import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Environment } from '../../config/env.ts';
import { linearProjectUrlSlug, type LinearProjectReference, type LinearService, type LinearTeamReference } from '../linear/index.ts';
import type { ManagedProject, ProjectRegistryService } from '../registry/index.ts';
import type { RunnerManager, RunnerStartResult } from '../runner/index.ts';
import { writeProjectWorkflow, type WorkflowRenderResult } from '../workflow/index.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_SYMPHONY_REPOSITORY = 'https://github.com/openai/symphony.git';
const DEFAULT_SYMPHONY_INSTALL_PATH = join(homedir(), '.local', 'share', 'symphony-meta-orchestrator', 'symphony');
const SYMPHONY_GUARDRAIL_FLAG = '--i-understand-that-this-will-be-running-without-the-usual-guardrails';

export type SetupProjectInput = {
  name: string;
  teamKey: string;
  githubUrl: string;
  startRunner?: boolean;
  linearProjectId?: string;
};

export type SetupProjectStepName = 'linearProject' | 'bootstrap' | 'registry' | 'workflow' | 'runner';

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
  env?: Environment;
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
  let runnerConfig: RunnerBootstrapResult | undefined;
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
    runnerConfig = await resolveDefaultRunner(services.runnerBootstrap ?? bootstrapSymphonyRunner, services.env ?? process.env);
    steps.push({ name: 'bootstrap', status: 'ok', output: { runner: runnerConfig } });
  } catch (error) {
    steps.push({ name: 'bootstrap', status: 'error', error: structuredError(error) });
    return { team, linearProject, steps };
  }

  try {
    project = await buildManagedProject(input, team, linearProject, runnerConfig, services.env ?? process.env);
    project = await services.registry.create(project);
    steps.push({ name: 'registry', status: 'ok', output: { project } });
  } catch (error) {
    steps.push({ name: 'registry', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, steps };
  }

  try {
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
  runner: RunnerBootstrapResult,
  env: Environment
): Promise<ManagedProject> {
  const githubUrl = normalizeGithubUrl(input.githubUrl);
  const projectSlug = slugify(input.name);
  const { workspaceRoot, logsRoot } = resolveProjectPaths(projectSlug, env);

  const project = {
    id: projectSlug,
    name: input.name,
    githubUrl,
    workflow: {
      source: 'generated',
      template: 'default'
    },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: {
        type: 'workspaceWrite',
        networkAccess: true
      }
    }
  } as ManagedProject;

  Object.defineProperties(project, {
    tracker: {
      enumerable: false,
      value: {
        kind: 'linear',
        teamKey: team.key,
        teamId: team.id,
        projectId: linearProject.id,
        projectSlug: linearProjectUrlSlug(linearProject)
      }
    },
    symphony: {
      enumerable: false,
      value: {
        command: runner.command,
        args: runner.args,
        cwd: runner.cwd,
        workspaceRoot,
        logsRoot
      }
    }
  });

  return project;
}

async function resolveDefaultRunner(runnerBootstrap: RunnerBootstrapper, env: Environment): Promise<RunnerBootstrapResult> {
  const defaultCwd = resolve(process.cwd());

  const commandOverride = env.SYMPHONY_RUNNER_COMMAND?.trim();
  if (commandOverride !== undefined && commandOverride.length > 0) {
    return {
      command: commandOverride,
      args: [SYMPHONY_GUARDRAIL_FLAG],
      cwd: defaultCwd
    };
  }

  return runnerBootstrap(defaultCwd);
}

function resolveProjectPaths(projectSlug: string, env: Environment): { workspaceRoot: string; logsRoot: string } {
  const workspacesBase = env.DEFAULT_SYMPHONY_WORKSPACES ?? join(tmpdir(), 'symphony-workspaces');
  const logsBase = env.DEFAULT_SYMPHONY_LOGS ?? join(tmpdir(), 'symphony-logs');
  return {
    workspaceRoot: resolve(join(workspacesBase, projectSlug)),
    logsRoot: resolve(join(logsBase, projectSlug))
  };
}

export async function bootstrapSymphonyRunner(_repoPath: string): Promise<RunnerBootstrapResult> {
  const installPath = resolve(process.env.SYMPHONY_RUNNER_INSTALL_DIR ?? DEFAULT_SYMPHONY_INSTALL_PATH);
  const repository = process.env.SYMPHONY_RUNNER_REPOSITORY ?? DEFAULT_SYMPHONY_REPOSITORY;

  if (!await directoryHasEntries(installPath)) {
    await mkdir(dirname(installPath), { recursive: true });
    try {
      await execFileAsync('git', ['clone', repository, installPath]);
    } catch (error) {
      throw new SymphonyRunnerBootstrapError(repository, installPath, error);
    }
  }

  return {
    command: process.execPath,
    args: [join(installPath, 'bin', 'symphony'), SYMPHONY_GUARDRAIL_FLAG],
    cwd: installPath
  };
}

class SymphonyRunnerBootstrapError extends Error {
  readonly repository: string;
  readonly installPath: string;
  readonly cause: unknown;

  constructor(repository: string, installPath: string, cause: unknown) {
    const detail = cause instanceof Error ? `\n\n${cause.message}` : `\n\n${String(cause)}`;
    super(
      `Bootstrap failed while cloning Symphony runner from ${repository} into ${installPath}. ` +
      'Provide setup_project runnerCommand, set SYMPHONY_RUNNER_COMMAND to an executable runner, ' +
      'or override the bootstrap repository with SYMPHONY_RUNNER_REPOSITORY.' +
      detail
    );
    this.name = 'SymphonyRunnerBootstrapError';
    this.repository = repository;
    this.installPath = installPath;
    this.cause = cause;
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

function normalizeGithubUrl(value: string): string {
  const input = value.trim();
  if (input.length === 0) {
    throw new SetupProjectValidationError('github_url_missing', 'githubUrl', 'githubUrl is required.');
  }

  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(input) || /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(input)) {
    return input;
  }

  throw new SetupProjectValidationError(
    'github_url_invalid',
    'githubUrl',
    'githubUrl must be a GitHub repository URL, for example https://github.com/org/repo.git or git@github.com:org/repo.git.'
  );
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
