import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { linearProjectUrlSlug, type LinearProjectReference, type LinearService, type LinearTeamReference } from '../linear/index.ts';
import type { ManagedProject, ProjectRegistryService } from '../registry/index.ts';
import type { RunnerManager, RunnerStartResult } from '../runner/index.ts';
import { writeProjectWorkflow, type WorkflowRenderResult } from '../workflow/index.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_SYMPHONY_REPOSITORY = 'https://github.com/mboogerd/symphony.git';
const DEFAULT_SYMPHONY_INSTALL_PATH = join(homedir(), '.local', 'share', 'symphony-meta-orchestrator', 'symphony');
const SYMPHONY_GUARDRAIL_FLAG = '--i-understand-that-this-will-be-running-without-the-usual-guardrails';

export type SetupProjectInput = {
  name: string;
  teamKey: string;
  repoPath: string;
  runnerPort: number;
  workspaceRoot: string;
  logsRoot: string;
  startRunner?: boolean;
  linearProjectId?: string;
};

export type SetupProjectStepName = 'linearProject' | 'registry' | 'workflow' | 'runner';

export type SetupProjectStepResult = {
  name: SetupProjectStepName;
  status: 'ok' | 'skipped' | 'error';
  output?: unknown;
  error?: Record<string, unknown>;
};

export type SetupProjectResult = {
  project?: ManagedProject;
  linearProject?: LinearProjectReference;
  team?: LinearTeamReference;
  workflow?: WorkflowRenderResult;
  runner?: RunnerStartResult;
  steps: SetupProjectStepResult[];
};

export type SetupProjectServices = {
  linear: LinearService;
  registry: ProjectRegistryService;
  runnerManager: RunnerManager;
  runnerBootstrap?: RunnerBootstrapper;
};

export type RunnerBootstrapResult = {
  command: string;
  args: string[];
  cwd: string;
};

export type RunnerBootstrapper = (repoPath: string) => Promise<RunnerBootstrapResult>;

export async function setupManagedProject(input: SetupProjectInput, services: SetupProjectServices): Promise<SetupProjectResult> {
  const steps: SetupProjectStepResult[] = [];
  let team: LinearTeamReference | undefined;
  let linearProject: LinearProjectReference | undefined;
  let project: ManagedProject | undefined;
  let workflow: WorkflowRenderResult | undefined;
  let runner: RunnerStartResult | undefined;

  try {
    team = await services.linear.resolveTeam(input.teamKey);
    if (input.linearProjectId) {
      linearProject = await services.linear.resolveProjectForTeam(input.linearProjectId, team.id);
    } else {
      linearProject = await services.linear.findProjectByNameForTeam(input.name, team.id)
        ?? await services.linear.createProject({ name: input.name, teamId: team.id });
    }
    steps.push({ name: 'linearProject', status: 'ok', output: { team, project: linearProject } });
  } catch (error) {
    steps.push({ name: 'linearProject', status: 'error', error: structuredError(error) });
    return { team, linearProject, steps };
  }

  try {
    project = await buildManagedProject(input, team, linearProject, services.runnerBootstrap ?? bootstrapSymphonyRunner);
    project = await services.registry.create(project);
    steps.push({ name: 'registry', status: 'ok', output: { project } });
  } catch (error) {
    steps.push({ name: 'registry', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, steps };
  }

  try {
    await mkdir(project.repo.path, { recursive: true });
    workflow = await writeProjectWorkflow(project);
    steps.push({ name: 'workflow', status: 'ok', output: { workflow } });
  } catch (error) {
    steps.push({ name: 'workflow', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, workflow, steps };
  }

  if (input.startRunner === true) {
    try {
      runner = await services.runnerManager.start(project);
      steps.push({ name: 'runner', status: 'ok', output: { runner } });
    } catch (error) {
      steps.push({ name: 'runner', status: 'error', error: structuredError(error) });
      return { team, linearProject, project, workflow, runner, steps };
    }
  } else {
    steps.push({ name: 'runner', status: 'skipped', output: { reason: 'startRunner was not true' } });
  }

  return { team, linearProject, project, workflow, runner, steps };
}

async function buildManagedProject(
  input: SetupProjectInput,
  team: LinearTeamReference,
  linearProject: LinearProjectReference,
  runnerBootstrap: RunnerBootstrapper
): Promise<ManagedProject> {
  const repoPath = resolve(input.repoPath);
  const workspaceRoot = resolve(input.workspaceRoot);
  const logsRoot = resolve(input.logsRoot);
  const repoRemote = await resolveRepoRemote(repoPath);
  const runner = await resolveDefaultRunner(repoPath, runnerBootstrap);

  return {
    id: slugify(input.name),
    name: input.name,
    tracker: {
      kind: 'linear',
      teamKey: team.key,
      teamId: team.id,
      projectId: linearProject.id,
      projectSlug: linearProjectUrlSlug(linearProject)
    },
    repo: {
      path: repoPath,
      remoteUrl: repoRemote ?? repoPath,
      defaultBranch: 'main',
      cloneSource: repoRemote ?? repoPath
    },
    workflow: {
      source: 'generated',
      template: 'default'
    },
    symphony: {
      command: runner.command,
      args: runner.args,
      cwd: runner.cwd,
      runnerPort: input.runnerPort,
      workspaceRoot,
      logsRoot,
      dashboardUrl: `http://localhost:${input.runnerPort}`
    },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: {
        type: 'workspaceWrite',
        networkAccess: true
      }
    }
  };
}

async function resolveRepoRemote(repoPath: string): Promise<string | undefined> {
  if (!await isGitRepo(repoPath)) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    const remoteUrl = stdout.trim();
    if (remoteUrl.length > 0) {
      return remoteUrl;
    }
  } catch {
    // Fall through to the actionable setup error below.
  }

  throw new SetupProjectValidationError(
    'repo_remote_missing',
    'repo.remoteUrl',
    `Git origin remote is not configured for ${repoPath}; add a real origin remote or register the project with explicit repo.remoteUrl and repo.cloneSource.`
  );
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await access(resolve(repoPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultRunner(repoPath: string, runnerBootstrap: RunnerBootstrapper): Promise<RunnerBootstrapResult> {
  const commandOverride = process.env.SYMPHONY_RUNNER_COMMAND?.trim();
  if (commandOverride !== undefined && commandOverride.length > 0) {
    return {
      command: commandOverride,
      args: [SYMPHONY_GUARDRAIL_FLAG],
      cwd: repoPath
    };
  }

  if (await executableExists(join(repoPath, 'bin', 'symphony'))) {
    return {
      command: 'mise',
      args: ['exec', '--', './bin/symphony', SYMPHONY_GUARDRAIL_FLAG],
      cwd: repoPath
    };
  }

  return runnerBootstrap(repoPath);
}

export async function bootstrapSymphonyRunner(_repoPath: string): Promise<RunnerBootstrapResult> {
  const installPath = resolve(process.env.SYMPHONY_RUNNER_INSTALL_DIR ?? DEFAULT_SYMPHONY_INSTALL_PATH);
  const repository = process.env.SYMPHONY_RUNNER_REPOSITORY ?? DEFAULT_SYMPHONY_REPOSITORY;

  if (!await directoryHasEntries(installPath)) {
    await mkdir(dirname(installPath), { recursive: true });
    await execFileAsync('git', ['clone', repository, installPath]);
  }

  return {
    command: process.execPath,
    args: [join(installPath, 'bin', 'symphony'), SYMPHONY_GUARDRAIL_FLAG],
    cwd: installPath
  };
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

class SetupProjectValidationError extends Error {
  readonly code: string;
  readonly field: string;

  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'SetupProjectValidationError';
    this.code = code;
    this.field = field;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      message: this.message
    };
  }
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : basename(process.cwd());
}

function structuredError(error: unknown): Record<string, unknown> {
  if (error !== null && typeof error === 'object' && 'toJSON' in error && typeof error.toJSON === 'function') {
    return error.toJSON() as Record<string, unknown>;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: 'Error',
    message: String(error)
  };
}
