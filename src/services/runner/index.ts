import { openSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { ManagedProject } from '../registry/index.ts';
import { validateProjectWorkflowSetup, writeProjectWorkflow, type WorkflowRenderResult } from '../workflow/index.ts';

export type RunnerProcessState = 'idle' | 'starting' | 'running' | 'unhealthy' | 'stopped' | 'exited' | 'missing' | 'invalid';

export type RunnerStatusDetails = {
  message: string;
  checkedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  readiness?: RunnerReadinessState;
  logExcerpt?: string[];
};

export type RunnerStatus = {
  id: string;
  state: RunnerProcessState;
  pid?: number;
  port?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  workflowPath: string;
  dashboardUrl?: string;
  logPath: string;
  statePath: string;
  latestHeartbeat?: string;
  details: RunnerStatusDetails;
};

export type RunnerStartResult = {
  status: RunnerStatus;
  started: boolean;
};

export type RunnerManagerOptions = {
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  now?: () => Date;
  spawnProcess?: typeof spawn;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  readinessCheck?: RunnerReadinessCheck;
  isProcessAlive?: (pid: number) => boolean;
};

export type RunnerReadinessState = 'ready' | 'not_ready' | 'wrong_project' | 'wrong_workflow' | 'error' | 'timeout' | 'exited';

export type RunnerReadinessResult = {
  ready: boolean;
  state: RunnerReadinessState;
  message: string;
};

export type RunnerReadinessCheck = (project: ManagedProject, status: RunnerStatus) => Promise<RunnerReadinessResult>;

type RunnerStateFile = {
  projectId: string;
  pid: number;
  port?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  workflowPath: string;
  dashboardUrl?: string;
  logPath: string;
  startedAt: string;
  latestHeartbeat?: string;
  status?: RunnerStatusDetails;
};

export type RunnerManager = {
  start(project: ManagedProject): Promise<RunnerStartResult>;
  stop(project: ManagedProject): Promise<RunnerStatus>;
  restart(project: ManagedProject): Promise<RunnerStartResult>;
  status(project: ManagedProject): Promise<RunnerStatus>;
  tailLogs(project: ManagedProject, lineCount?: number): Promise<RunnerLogTail>;
};

export type RunnerLogTail = {
  id: string;
  logPath: string;
  lines: string[];
  lineCount: number;
  truncated: boolean;
};

const STOP_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = Number.parseInt(process.env.SYMPHONY_RUNNER_READINESS_TIMEOUT_MS ?? '', 10) || 30_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = Number.parseInt(process.env.SYMPHONY_RUNNER_READINESS_POLL_INTERVAL_MS ?? '', 10) || 500;
const LOG_EXCERPT_LINES = 20;

export function createRunnerManager(options: RunnerManagerOptions = {}): RunnerManager {
  const now = options.now ?? (() => new Date());
  const spawnProcess = options.spawnProcess ?? spawn;
  const commandOverride = options.command ?? process.env.SYMPHONY_RUNNER_COMMAND;
  const readinessTimeoutMs = Math.max(1, options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  const readinessPollIntervalMs = Math.max(1, options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS);
  const readinessCheck = options.readinessCheck ?? checkRunnerReadiness;
  const processAlive = options.isProcessAlive ?? isProcessAlive;

  return {
    async start(project: ManagedProject): Promise<RunnerStartResult> {
      const paths = runnerPaths(project);
      await mkdir(paths.logsRoot, { recursive: true });

      const existing = await readState(paths.statePath);
      if (existing !== undefined && processAlive(existing.pid)) {
        const checkedAt = now().toISOString();
        const readiness = await readinessCheck(project, statusFromState(project, paths, existing, 'running', {
          message: 'Runner process is running',
          checkedAt
        }));
        return {
          started: false,
          status: statusFromState(project, paths, existing, readiness.ready ? 'running' : 'unhealthy', {
            message: readiness.ready ? 'Runner is already running for this managed project' : `Existing runner is not ready: ${readiness.message}`,
            checkedAt,
            readiness: readiness.state
          })
        };
      }

      const validation = await validateProjectWorkflowSetup(project, { phase: 'live' });
      if (!validation.ok) {
        return {
          started: false,
          status: {
            id: project.id,
            state: 'invalid',
            port: project.symphony.runnerPort,
            workflowPath: validation.workflowPath,
            dashboardUrl: projectDashboardUrl(project),
            logPath: paths.logPath,
            statePath: paths.statePath,
            details: {
              message: `Invalid runner setup: ${validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')}`,
              checkedAt: now().toISOString()
            }
          }
        };
      }

      const workflow = await writeProjectWorkflow(project);
      const runnerCommand = resolveRunnerCommand(commandOverride, options.commandArgs, options.cwd, project, workflow);
      const child = spawnRunner(spawnProcess, runnerCommand, project, workflow, paths.logPath);
      const pid = requirePid(child);
      const state: RunnerStateFile = {
        projectId: project.id,
        pid,
        port: project.symphony.runnerPort,
        command: runnerCommand.file,
        args: runnerCommand.args,
        cwd: runnerCommand.cwd,
        workflowPath: workflow.workflowPath,
        dashboardUrl: projectDashboardUrl(project),
        logPath: paths.logPath,
        startedAt: now().toISOString(),
        latestHeartbeat: now().toISOString(),
        status: {
          message: 'Runner process started; waiting for readiness',
          checkedAt: now().toISOString()
        }
      };
      await writeState(paths.statePath, state);
      const starting = statusFromState(project, paths, state, 'starting', state.status);
      const readiness = await waitForReadiness(project, starting, {
        timeoutMs: readinessTimeoutMs,
        pollIntervalMs: readinessPollIntervalMs,
        readinessCheck,
        now,
        isAlive: () => processAlive(pid)
      });
      const readyState: RunnerStateFile = {
        ...state,
        latestHeartbeat: readiness.details.checkedAt,
        status: readiness.details
      };
      await writeState(paths.statePath, readyState);

      const status = statusFromState(project, paths, readyState, readiness.ready ? 'running' : 'unhealthy', readiness.details);

      return {
        started: status.state === 'running',
        status
      };
    },

    async stop(project: ManagedProject): Promise<RunnerStatus> {
      const paths = runnerPaths(project);
      const state = await readState(paths.statePath);
      const checkedAt = now().toISOString();

      if (state === undefined) {
        return createIdleRunnerStatus(project, paths, 'No runner state file exists', checkedAt);
      }

      if (!processAlive(state.pid)) {
        const stopped = statusFromState(project, paths, state, 'stopped', {
          message: 'Runner process was not running',
          checkedAt
        });
        await writeState(paths.statePath, { ...state, latestHeartbeat: checkedAt, status: stopped.details });
        return stopped;
      }

      await terminateProcess(state.pid);
      const stopped = statusFromState(project, paths, state, 'stopped', {
        message: 'Runner process stopped',
        checkedAt
      });
      await writeState(paths.statePath, { ...state, latestHeartbeat: checkedAt, status: stopped.details });
      return stopped;
    },

    async restart(project: ManagedProject): Promise<RunnerStartResult> {
      await this.stop(project);
      return this.start(project);
    },

    async status(project: ManagedProject): Promise<RunnerStatus> {
      const paths = runnerPaths(project);
      const state = await readState(paths.statePath);
      const checkedAt = now().toISOString();

      if (state === undefined) {
        return createIdleRunnerStatus(project, paths, 'No runner state file exists', checkedAt);
      }

      const running = processAlive(state.pid);
      if (!running) {
        await removeState(paths.statePath);
        return createIdleRunnerStatus(project, paths, `Removed stale runner state for missing process ${state.pid}`, checkedAt);
      }

      const initialDetails: RunnerStatusDetails = {
        message: 'Runner process is running',
        checkedAt
      };
      const readiness = await readinessCheck(project, statusFromState(project, paths, state, 'running', initialDetails));
      const details: RunnerStatusDetails = {
        message: readiness.message,
        checkedAt,
        readiness: readiness.state
      };
      const nextState: RunnerProcessState = readiness.ready ? 'running' : 'unhealthy';
      const nextStatus = statusFromState(project, paths, state, nextState, details);
      await writeState(paths.statePath, { ...state, latestHeartbeat: checkedAt, status: details });
      return nextStatus;
    },

    async tailLogs(project: ManagedProject, lineCount = 100): Promise<RunnerLogTail> {
      const paths = runnerPaths(project);
      const requestedLineCount = Math.max(1, Math.min(Math.trunc(lineCount), 1000));
      let contents = '';

      try {
        contents = await readFile(paths.logPath, 'utf8');
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) {
          throw error;
        }
      }

      const lines = contents.length === 0 ? [] : contents.replace(/\r?\n$/, '').split(/\r?\n/);
      return {
        id: project.id,
        logPath: paths.logPath,
        lines: lines.slice(-requestedLineCount),
        lineCount: lines.length,
        truncated: lines.length > requestedLineCount
      };
    }
  };
}

async function waitForReadiness(
  project: ManagedProject,
  status: RunnerStatus,
  options: {
    timeoutMs: number;
    pollIntervalMs: number;
    readinessCheck: RunnerReadinessCheck;
    now: () => Date;
    isAlive: () => boolean;
  }
): Promise<{ ready: boolean; details: RunnerStatusDetails }> {
  const deadline = Date.now() + options.timeoutMs;
  let lastResult: RunnerReadinessResult | undefined;

  while (Date.now() <= deadline) {
    if (!options.isAlive()) {
      return {
        ready: false,
        details: {
          message: `Runner process exited before readiness. Check logs at ${status.logPath}.`,
          checkedAt: options.now().toISOString(),
          readiness: 'exited',
          logExcerpt: await tailLogExcerpt(status.logPath)
        }
      };
    }

    lastResult = await options.readinessCheck(project, status);
    if (lastResult.ready) {
      return {
        ready: true,
        details: {
          message: lastResult.message,
          checkedAt: options.now().toISOString(),
          readiness: lastResult.state
        }
      };
    }
    if (lastResult.state === 'wrong_project' || lastResult.state === 'wrong_workflow') {
      return {
        ready: false,
        details: {
          message: `${lastResult.message}. Check logs at ${status.logPath}.`,
          checkedAt: options.now().toISOString(),
          readiness: lastResult.state,
          logExcerpt: await tailLogExcerpt(status.logPath)
        }
      };
    }

    await sleep(options.pollIntervalMs);
  }

  return {
    ready: false,
    details: {
      message: `Runner readiness timed out after ${options.timeoutMs}ms: ${lastResult?.message ?? 'service did not report ready'}. Check logs at ${status.logPath}.`,
      checkedAt: options.now().toISOString(),
      readiness: 'timeout',
      logExcerpt: await tailLogExcerpt(status.logPath)
    }
  };
}

async function checkRunnerReadiness(project: ManagedProject, status: RunnerStatus): Promise<RunnerReadinessResult> {
  if (status.dashboardUrl === undefined) {
    return { ready: false, state: 'not_ready', message: 'Runner dashboard URL is not configured' };
  }

  try {
    const response = await fetch(status.dashboardUrl, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) {
      return { ready: false, state: 'not_ready', message: `Runner service returned HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { ready: true, state: 'ready', message: 'Runner service responded successfully; project/workflow identity was not exposed by the dashboard response' };
    }

    const body = await response.json() as unknown;
    const projectId = readStringPath(body, ['projectId']) ?? readStringPath(body, ['project', 'id']) ?? readStringPath(body, ['id']);
    if (projectId !== undefined && projectId !== project.id) {
      return { ready: false, state: 'wrong_project', message: `Runner is serving project "${projectId}", expected "${project.id}"` };
    }

    const workflowPath = readStringPath(body, ['workflowPath']) ?? readStringPath(body, ['workflow', 'path']);
    if (workflowPath !== undefined && resolve(workflowPath) !== resolve(status.workflowPath)) {
      return { ready: false, state: 'wrong_workflow', message: `Runner is serving workflow "${workflowPath}", expected "${status.workflowPath}"` };
    }

    const readiness = readStringPath(body, ['state']) ?? readStringPath(body, ['status']);
    if (readiness !== undefined && !['ready', 'running', 'ok'].includes(readiness.toLowerCase())) {
      return { ready: false, state: 'not_ready', message: `Runner service responded but is "${readiness}"` };
    }

    return { ready: true, state: 'ready', message: 'Runner service responded with expected project/workflow readiness' };
  } catch (error) {
    return {
      ready: false,
      state: 'error',
      message: `Runner service is not ready: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function createIdleRunnerStatus(
  projectOrId: ManagedProject | string,
  paths?: ReturnType<typeof runnerPaths>,
  message = 'Runner has not been started',
  checkedAt = new Date().toISOString()
): RunnerStatus {
  if (typeof projectOrId === 'string') {
    return {
      id: projectOrId,
      state: 'idle',
      workflowPath: '',
      logPath: '',
      statePath: '',
      details: { message, checkedAt }
    };
  }

  const resolvedPaths = paths ?? runnerPaths(projectOrId);
  return {
    id: projectOrId.id,
    state: 'idle',
    port: projectOrId.symphony.runnerPort,
    command: projectOrId.symphony.command,
    args: projectOrId.symphony.args,
    cwd: runnerCwd(projectOrId, resolvedPaths.workspaceRoot),
    workflowPath: resolvedPaths.workflowPath,
    dashboardUrl: projectDashboardUrl(projectOrId),
    logPath: resolvedPaths.logPath,
    statePath: resolvedPaths.statePath,
    details: { message, checkedAt }
  };
}

function runnerPaths(project: ManagedProject) {
  const workspaceRoot = resolve(project.symphony.workspaceRoot);
  const logsRoot = resolve(project.symphony.logsRoot);
  return {
    workspaceRoot,
    logsRoot,
    workflowPath: join(workspaceRoot, 'WORKFLOW.md'),
    logPath: join(logsRoot, `${project.id}.runner.log`),
    statePath: join(logsRoot, `${project.id}.runner.json`)
  };
}

function spawnRunner(
  spawnProcess: typeof spawn,
  command: ResolvedRunnerCommand,
  project: ManagedProject,
  workflow: WorkflowRenderResult,
  logPath: string
): ChildProcess {
  const child = spawnProcess(command.file, command.args, {
    cwd: command.cwd,
    detached: true,
    stdio: ['ignore', openLogFd(logPath), openLogFd(logPath)],
    env: {
      ...process.env,
      SYMPHONY_WORKFLOW_PATH: workflow.workflowPath,
      SYMPHONY_RUNNER_PORT: String(project.symphony.runnerPort),
      SYMPHONY_DASHBOARD_URL: projectDashboardUrl(project)
    }
  });
  child.unref();
  return child;
}

function openLogFd(logPath: string): number {
  return openSync(logPath, 'a');
}

type ResolvedRunnerCommand = {
  file: string;
  args: string[];
  cwd: string;
};

function resolveRunnerCommand(
  commandOverride: string | undefined,
  argsOverride: string[] | undefined,
  cwdOverride: string | undefined,
  project: ManagedProject,
  workflow: WorkflowRenderResult
): ResolvedRunnerCommand {
  const file = commandOverride ?? project.symphony.command;
  if (file.trim().length === 0) {
    throw new Error('Runner command cannot be empty');
  }

  return {
    file,
    args: [
      ...(argsOverride ?? project.symphony.args ?? []),
      '--port',
      String(project.symphony.runnerPort),
      '--logs-root',
      resolve(project.symphony.logsRoot),
      workflow.workflowPath
    ],
    cwd: cwdOverride ?? runnerCwd(project, workflow.workspaceRoot)
  };
}

function runnerCwd(project: ManagedProject, fallbackWorkspaceRoot: string): string {
  return resolve(project.symphony.cwd ?? fallbackWorkspaceRoot);
}

function requirePid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error('Runner process did not expose a pid');
  }

  return child.pid;
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (fallbackError) {
        if (isNodeError(fallbackError) && fallbackError.code === 'ESRCH') {
          return;
        }
        throw fallbackError;
      }
    } else {
      throw error;
    }
  }

  const started = Date.now();
  while (Date.now() - started < STOP_TIMEOUT_MS) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (fallbackError) {
        if (!(isNodeError(fallbackError) && fallbackError.code === 'ESRCH')) {
          throw fallbackError;
        }
      }
    } else {
      throw error;
    }
  }
}

function statusFromState(
  project: ManagedProject,
  paths: ReturnType<typeof runnerPaths>,
  state: RunnerStateFile,
  processState: RunnerProcessState,
  details: RunnerStatusDetails | undefined
): RunnerStatus {
  return {
    id: project.id,
    state: processState,
    pid: state.pid,
    port: state.port ?? project.symphony.runnerPort,
    command: state.command ?? project.symphony.command,
    args: state.args ?? project.symphony.args,
    cwd: state.cwd ?? runnerCwd(project, paths.workspaceRoot),
    workflowPath: state.workflowPath || paths.workflowPath,
    dashboardUrl: state.dashboardUrl ?? projectDashboardUrl(project),
    logPath: state.logPath || paths.logPath,
    statePath: paths.statePath,
    latestHeartbeat: state.latestHeartbeat,
    details: details ?? state.status ?? {
      message: 'Runner state loaded',
      checkedAt: new Date().toISOString()
    }
  };
}

async function readState(statePath: string): Promise<RunnerStateFile | undefined> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRunnerStateFile(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeState(statePath: string, state: RunnerStateFile): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function removeState(statePath: string): Promise<void> {
  try {
    await unlink(statePath);
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

async function tailLogExcerpt(logPath: string): Promise<string[]> {
  try {
    const contents = await readFile(logPath, 'utf8');
    return contents.replace(/\r?\n$/, '').split(/\r?\n/).slice(-LOG_EXCERPT_LINES).filter((line) => line.length > 0);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function readStringPath(value: unknown, path: string[]): string | undefined {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRunnerStateFile(value: unknown): value is RunnerStateFile {
  return value !== null
    && typeof value === 'object'
    && typeof (value as RunnerStateFile).projectId === 'string'
    && typeof (value as RunnerStateFile).pid === 'number'
    && ((value as RunnerStateFile).command === undefined || typeof (value as RunnerStateFile).command === 'string')
    && ((value as RunnerStateFile).args === undefined || Array.isArray((value as RunnerStateFile).args))
    && ((value as RunnerStateFile).cwd === undefined || typeof (value as RunnerStateFile).cwd === 'string')
    && typeof (value as RunnerStateFile).workflowPath === 'string'
    && typeof (value as RunnerStateFile).logPath === 'string';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ESRCH' || error.code === 'EPERM')) {
      return error.code === 'EPERM';
    }
    return false;
  }
}

function dashboardUrl(port: number | undefined): string | undefined {
  return port === undefined ? undefined : `http://localhost:${port}`;
}

function projectDashboardUrl(project: ManagedProject): string | undefined {
  return project.symphony.dashboardUrl ?? dashboardUrl(project.symphony.runnerPort);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
