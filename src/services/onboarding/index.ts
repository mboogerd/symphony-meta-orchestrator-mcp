import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Environment } from '../../config/env.ts';
import { LinearServiceError, linearProjectUrlSlug, type LinearProjectReference, type LinearService, type LinearTeamReference } from '../linear/index.ts';
import type { ManagedProject, ManagedProjectRegistry, ProjectRegistryService } from '../registry/index.ts';
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

export type SetupProjectRecovery = {
  failedStep: SetupProjectStepName;
  summary: string;
  actions: string[];
  retry: {
    tool: 'setup_project';
    input: Partial<SetupProjectInput>;
    note: string;
  };
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
    const registry = await services.registry.load();
    const registryMatch = findRegistryMatch(input, registry);
    if (registryMatch !== undefined) {
      const existingLinearProject = projectLinearReference(registryMatch.project);
      if (registryMatch.resumable && existingLinearProject !== undefined) {
        linearProject = await resolveResumableLinearProject(input, services.linear, existingLinearProject, team.id);
      } else {
        throw new SetupProjectRegistryConflictError(registryMatch);
      }
    } else if (input.linearProjectId) {
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
    const registry = await services.registry.load();
    const registryMatch = findRegistryMatch(input, registry);
    if (registryMatch?.resumable === true) {
      project = { ...registryMatch.project };
      attachSetupRuntimeHints(project, team, linearProject, runnerConfig, services.env ?? process.env);
      steps.push({ name: 'registry', status: 'skipped', output: { project, reason: 'project already exists in registry' } });
    } else {
      project = await buildManagedProject(input, team, linearProject, runnerConfig, services.env ?? process.env);
      project = await services.registry.create(project);
      steps.push({ name: 'registry', status: 'ok', output: { project } });
    }
  } catch (error) {
    steps.push({ name: 'registry', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, steps };
  }

  try {
    workflow = await writeProjectWorkflow(project, { env: services.env });
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

async function resolveResumableLinearProject(
  input: SetupProjectInput,
  linear: LinearService,
  existingLinearProject: LinearProjectReference,
  teamId: string
): Promise<LinearProjectReference> {
  try {
    return await linear.resolveProjectForTeam(existingLinearProject.id, teamId);
  } catch (error) {
    if (!isStaleLinearProjectReferenceError(error)) {
      throw error;
    }
  }

  if (input.linearProjectId !== undefined && input.linearProjectId !== existingLinearProject.id) {
    return linear.resolveProjectForTeam(input.linearProjectId, teamId);
  }

  return await linear.findProjectByNameForTeam(input.name, teamId)
    ?? await linear.createProject({ name: input.name, teamId });
}

export function setupProjectRecovery(input: SetupProjectInput, setup: SetupProjectResult): SetupProjectRecovery | undefined {
  const failedStep = setup.steps.find((step) => step.status === 'error');
  if (failedStep === undefined) {
    return undefined;
  }

  const retryInput: Partial<SetupProjectInput> = {
    name: input.name,
    teamKey: input.teamKey,
    githubUrl: input.githubUrl
  };
  if (input.startRunner !== undefined) {
    retryInput.startRunner = input.startRunner;
  }
  if (setup.linearProject?.id !== undefined) {
    retryInput.linearProjectId = setup.linearProject.id;
  } else if (input.linearProjectId !== undefined) {
    retryInput.linearProjectId = input.linearProjectId;
  }

  return {
    failedStep: failedStep.name,
    summary: setupRecoverySummary(failedStep, setup),
    actions: setupRecoveryActions(failedStep, setup),
    retry: {
      tool: 'setup_project',
      input: retryInput,
      note: setup.linearProject?.id !== undefined
        ? 'Retry with linearProjectId to reuse the Linear project that was already created or attached.'
        : 'Retry after completing the recovery actions.'
    }
  };
}

function setupRecoverySummary(step: SetupProjectStepResult, setup: SetupProjectResult): string {
  if (step.name === 'linearProject') {
    return 'Linear project resolution failed before setup created registry or workflow state.';
  }
  if (step.name === 'bootstrap') {
    return 'Runner bootstrap failed after Linear project resolution; no managed project registry entry was written.';
  }
  if (step.name === 'registry') {
    return setup.linearProject === undefined
      ? 'Registry write failed before a managed project could be registered.'
      : 'Registry write failed after Linear project resolution; the Linear project may be orphaned until setup is retried with its explicit ID.';
  }
  if (step.name === 'workflow') {
    return 'Workflow generation failed after the managed project was registered.';
  }
  return 'Runner startup failed after the managed project and workflow were created.';
}

function setupRecoveryActions(step: SetupProjectStepResult, setup: SetupProjectResult): string[] {
  if (step.name === 'linearProject') {
    return [
      'Inspect setup.steps[0].error for the exact Linear or input validation problem.',
      'If multiple same-name Linear projects exist, call find_linear_project with teamKey and pass the intended project as linearProjectId on retry.',
      'If the GitHub URL is invalid, retry with a canonical https://github.com/owner/repo URL.'
    ];
  }
  if (step.name === 'bootstrap') {
    return [
      'Set SYMPHONY_RUNNER_COMMAND to an executable runner, or fix SYMPHONY_RUNNER_REPOSITORY/bootstrap access.',
      ...linearProjectRetryActions(setup),
      'Retry setup_project; no registry entry should need manual cleanup from this failed attempt.'
    ];
  }
  if (step.name === 'registry') {
    return [
      'Inspect setup.steps for the registry error, especially duplicate id or githubUrl conflicts.',
      'If the registry already contains the intended project, use list_projects/get_project instead of creating a duplicate.',
      'If setup created or attached the intended Linear project, retry setup_project with recovery.retry.input.linearProjectId so the same Linear project is reused.',
      'If the Linear project is not intended, archive or delete it in Linear before retrying with corrected name/githubUrl.'
    ];
  }
  if (step.name === 'workflow') {
    return [
      'Inspect setup.steps for the workflow error and fix the workspace, repository, or workflow template problem.',
      'Use get_project to confirm the managed project registry entry exists before retrying.',
      ...linearProjectRetryActions(setup),
      'Retry setup_project; setup will resume from the existing registry entry when id and githubUrl match.'
    ];
  }
  return [
    'Inspect setup.steps for the runner startup error and fix the runner command, port, or logsRoot problem.',
    'Use get_project to confirm the managed project registry entry exists.',
    'Retry setup_project with startRunner true after fixing the runner issue, or call enable_project for the registered project.'
  ];
}

function linearProjectRetryActions(setup: SetupProjectResult): string[] {
  return setup.linearProject?.id === undefined ? [] : [
    `Use Linear project "${setup.linearProject.id}" on retry by passing recovery.retry.input.linearProjectId.`
  ];
}

type RegistryMatch = {
  project: ManagedProject;
  duplicateFields: Array<'id' | 'githubUrl'>;
  resumable: boolean;
};

class SetupProjectRegistryConflictError extends Error {
  readonly code = 'project_registry_conflict';
  readonly fields: string[];
  readonly projectId: string;

  constructor(match: RegistryMatch) {
    const fields = match.duplicateFields;
    super(
      `Project registry already contains project "${match.project.id}" with matching ${fields.join(' and ')}. ` +
      'Use the existing managed project entry or provide a different name/githubUrl.'
    );
    this.name = 'SetupProjectRegistryConflictError';
    this.fields = fields;
    this.projectId = match.project.id;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      fields: this.fields,
      projectId: this.projectId,
      message: this.message
    };
  }
}

function findRegistryMatch(input: SetupProjectInput, registry: ManagedProjectRegistry): RegistryMatch | undefined {
  const projectSlug = slugify(input.name);
  const githubUrl = normalizeGithubUrl(input.githubUrl);

  for (const project of registry.projects) {
    const duplicateFields: Array<'id' | 'githubUrl'> = [];
    if (project.id === projectSlug) {
      duplicateFields.push('id');
    }
    if (project.githubUrl === githubUrl) {
      duplicateFields.push('githubUrl');
    }
    if (duplicateFields.length > 0) {
      return {
        project,
        duplicateFields,
        resumable: duplicateFields.length === 2 && projectLinearReference(project) !== undefined
      };
    }
  }

  return undefined;
}

function projectLinearReference(project: ManagedProject): LinearProjectReference | undefined {
  const tracker = readObjectProperty(project, 'tracker');
  const projectId = readStringProperty(tracker, 'projectId');
  if (projectId === undefined) {
    return undefined;
  }

  return {
    id: projectId,
    name: readStringProperty(project, 'name') ?? projectId,
    url: linearProjectUrlFromTracker(tracker, projectId)
  };
}

function attachSetupRuntimeHints(
  project: ManagedProject,
  team: LinearTeamReference,
  linearProject: LinearProjectReference,
  runner: RunnerBootstrapResult,
  env: Environment
): void {
  const projectSlug = project.id;
  const { workspaceRoot, logsRoot } = resolveProjectPaths(projectSlug, env);

  Object.defineProperties(project, {
    tracker: {
      enumerable: false,
      configurable: true,
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
      configurable: true,
      value: {
        command: runner.command,
        args: runner.args,
        cwd: runner.cwd,
        workspaceRoot,
        logsRoot
      }
    }
  });
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
  const elixirPath = join(installPath, 'elixir');
  const releasePath = join(elixirPath, '_build', 'prod', 'rel', 'symphony', 'bin', 'symphony');

  if (!await directoryHasEntries(installPath)) {
    await mkdir(dirname(installPath), { recursive: true });
    try {
      await execFileAsync('git', ['clone', repository, installPath]);
    } catch (error) {
      throw new SymphonyRunnerBootstrapError(repository, installPath, error);
    }
  }

  if (!await fileIsAccessible(join(elixirPath, 'mix.exs'))) {
    throw new SymphonyRunnerBootstrapError(
      repository,
      installPath,
      new Error(`Expected an Elixir/Mix Symphony project at ${elixirPath}, but mix.exs was not found.`)
    );
  }

  if (!await fileIsAccessible(releasePath, constants.X_OK)) {
    try {
      await execFileAsync('mix', ['deps.get'], { cwd: elixirPath, env: { ...process.env, MIX_ENV: 'prod' } });
      await execFileAsync('mix', ['release'], { cwd: elixirPath, env: { ...process.env, MIX_ENV: 'prod' } });
    } catch (error) {
      throw new SymphonyRunnerBootstrapError(repository, installPath, error);
    }
  }

  if (!await fileIsAccessible(releasePath, constants.X_OK)) {
    throw new SymphonyRunnerBootstrapError(
      repository,
      installPath,
      new Error(`Symphony release binary was not produced at ${releasePath}. Run mix deps.get && MIX_ENV=prod mix release in ${elixirPath}, or set SYMPHONY_RUNNER_COMMAND to an existing runner.`)
    );
  }

  return {
    command: releasePath,
    args: [SYMPHONY_GUARDRAIL_FLAG],
    cwd: elixirPath
  };
}

class SymphonyRunnerBootstrapError extends Error {
  readonly repository: string;
  readonly installPath: string;
  readonly cause: unknown;

  constructor(repository: string, installPath: string, cause: unknown) {
    const detail = cause instanceof Error ? `\n\n${cause.message}` : `\n\n${String(cause)}`;
    super(
      `Bootstrap failed while preparing Symphony runner from ${repository} into ${installPath}. ` +
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

async function fileIsAccessible(path: string, mode: number = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
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

function isStaleLinearProjectReferenceError(error: unknown): boolean {
  if (error instanceof LinearServiceError) {
    return error.code === 'project_not_found' || error.code === 'linear_sdk_error';
  }

  if (error !== null && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (code === 'project_not_found' || code === 'linear_sdk_error') {
      return true;
    }
  }

  if (error instanceof Error) {
    return /entity not found:\s*project/i.test(error.message)
      || /project\b.*\bnot found/i.test(error.message);
  }

  return false;
}

function readObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  return property !== null && typeof property === 'object' && !Array.isArray(property)
    ? property as Record<string, unknown>
    : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' && property.trim().length > 0 ? property : undefined;
}

function linearProjectUrlFromTracker(tracker: Record<string, unknown> | undefined, projectId: string): string {
  const projectSlug = readStringProperty(tracker, 'projectSlug');
  return projectSlug === undefined
    ? `https://linear.app/project/${projectId}`
    : `https://linear.app/project/${projectSlug}`;
}
