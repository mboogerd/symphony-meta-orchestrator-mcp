import { openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { ManagedProject } from '../registry/index.ts';
import { validateProjectWorkflowSetup, writeProjectWorkflow, type WorkflowRenderResult } from '../workflow/index.ts';

export type RunnerProcessState = 'idle' | 'starting' | 'running' | 'stopped' | 'exited' | 'missing' | 'invalid';

export type RunnerStatusDetails = {
  message: string;
  checkedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
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
};

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

export function createRunnerManager(options: RunnerManagerOptions = {}): RunnerManager {
  const now = options.now ?? (() => new Date());
  const spawnProcess = options.spawnProcess ?? spawn;
  const commandOverride = options.command ?? process.env.SYMPHONY_RUNNER_COMMAND;

  return {
    async start(project: ManagedProject): Promise<RunnerStartResult> {
      const paths = runnerPaths(project);
      await mkdir(paths.logsRoot, { recursive: true });

      const existing = await readState(paths.statePath);
      if (existing !== undefined && isProcessAlive(existing.pid)) {
        return {
          started: false,
          status: statusFromState(project, paths, existing, 'running', {
            message: 'Runner is already running for this managed project',
            checkedAt: now().toISOString()
          })
        };
      }

      const validation = await validateProjectWorkflowSetup(project);
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
      const state: RunnerStateFile = {
        projectId: project.id,
        pid: requirePid(child),
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
          message: 'Runner process started',
          checkedAt: now().toISOString()
        }
      };
      await writeState(paths.statePath, state);

      return {
        started: true,
        status: statusFromState(project, paths, state, 'running', state.status)
      };
    },

    async stop(project: ManagedProject): Promise<RunnerStatus> {
      const paths = runnerPaths(project);
      const state = await readState(paths.statePath);
      const checkedAt = now().toISOString();

      if (state === undefined) {
        return createIdleRunnerStatus(project, paths, 'No runner state file exists', checkedAt);
      }

      if (!isProcessAlive(state.pid)) {
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

      const running = isProcessAlive(state.pid);
      const details: RunnerStatusDetails = {
        message: running ? 'Runner process is running' : 'Runner process is not running',
        checkedAt
      };
      const nextStatus = statusFromState(project, paths, state, running ? 'running' : 'missing', details);
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
