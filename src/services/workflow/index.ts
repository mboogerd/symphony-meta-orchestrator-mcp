import { createServer } from 'node:net';
import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { validateProjectRegistry, type ManagedProject, type ManagedProjectRegistry } from '../registry/index.ts';

const execFileAsync = promisify(execFile);

export type WorkflowState = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';

export function isActiveWorkflowState(state: WorkflowState): boolean {
  return state === 'todo' || state === 'in_progress' || state === 'in_review';
}

export type WorkflowSetupIssueCode =
  | 'registry_schema_invalid'
  | 'repo_path_missing'
  | 'repo_path_not_directory'
  | 'repo_path_not_git_repo'
  | 'repo_remote_missing'
  | 'repo_default_branch_missing'
  | 'workflow_path_missing'
  | 'workspace_root_unavailable'
  | 'logs_root_unavailable'
  | 'workflow_render_failed'
  | 'workflow_front_matter_invalid'
  | 'workflow_prompt_missing'
  | 'linear_token_missing'
  | 'linear_project_slug_missing'
  | 'runner_command_missing'
  | 'runner_command_probe_failed'
  | 'runner_cwd_missing'
  | 'runner_command_not_executable'
  | 'runner_port_unavailable'
  | 'codex_turn_sandbox_missing';

export type WorkflowSetupIssue = {
  code: WorkflowSetupIssueCode;
  field: string;
  message: string;
  path?: string;
  phase?: WorkflowSetupValidationPhase;
  severity?: 'error' | 'warning';
};

export type WorkflowSetupSubsystem = {
  ok: boolean;
  warnings: WorkflowSetupIssue[];
  errors: WorkflowSetupIssue[];
};

export type WorkflowSetupSubsystemName = 'registry' | 'repo' | 'workflow' | 'linear' | 'runner' | 'filesystem' | 'codexPolicy';

export type WorkflowSetupSubsystems = Record<WorkflowSetupSubsystemName, WorkflowSetupSubsystem>;

export type WorkflowSetupValidationPhase = 'schema' | 'render' | 'workspace' | 'live';

export type WorkflowSetupPhaseResult = {
  ok: boolean;
  warnings: WorkflowSetupIssue[];
  errors: WorkflowSetupIssue[];
};

export type WorkflowSetupPhaseResults = Record<WorkflowSetupValidationPhase, WorkflowSetupPhaseResult>;

export type WorkflowRenderResult = {
  projectId: string;
  workflowPath: string;
  workspaceRoot: string;
  logsRoot: string;
  content: string;
};

export type WorkflowSetupValidation = {
  ok: boolean;
  phase: WorkflowSetupValidationPhase;
  projectId: string;
  workflowPath: string;
  workspaceRoot: string;
  logsRoot: string;
  issues: WorkflowSetupIssue[];
  warnings: WorkflowSetupIssue[];
  subsystems: WorkflowSetupSubsystems;
  phases: WorkflowSetupPhaseResults;
  workflow?: WorkflowRenderResult;
};

export type WorkflowSetupValidationOptions = {
  phase?: WorkflowSetupValidationPhase;
  registry?: ManagedProjectRegistry;
  validateLinear?: boolean;
  env?: Record<string, string | undefined>;
  portAvailable?: PortAvailabilityProbe;
};

export type PortAvailabilityProbe = (port: number) => Promise<boolean>;

export async function renderProjectWorkflow(project: ManagedProject): Promise<WorkflowRenderResult> {
  const workspaceRoot = projectWorkspaceRoot(project);
  const logsRoot = projectLogsRoot(project);
  const workflowPath = join(workspaceRoot, 'WORKFLOW.md');
  const template = await loadWorkflowTemplate(project, projectRepoPath(project) ?? workspaceRoot);
  const frontMatter = mergeWorkflowFrontMatter(template.frontMatter, project, workspaceRoot);
  const content = renderWorkflowDocument(frontMatter, template.body);

  return { projectId: project.id, workflowPath, workspaceRoot, logsRoot, content };
}

export async function validateProjectWorkflowSetup(project: ManagedProject, options: WorkflowSetupValidationOptions = {}): Promise<WorkflowSetupValidation> {
  const phase = options.phase ?? 'workspace';
  const subsystemIssues = createSubsystems();
  const phaseIssues = createPhases();
  let workflow: WorkflowRenderResult | undefined;
  const workspaceRoot = projectWorkspaceRoot(project);
  const logsRoot = projectLogsRoot(project);
  const workflowPath = join(workspaceRoot, 'WORKFLOW.md');

  const recordIssue = issueRecorder(subsystemIssues, phaseIssues);

  validateRegistry(options.registry, recordIssue('registry', 'schema'));

  if (includesPhase(phase, 'render')) {
    if (project.workflow.source === 'repo') {
      await validateRepoWorkflowPath(projectRepoPath(project) ?? workspaceRoot, project.workflow.path, recordIssue('workflow', 'render'));
    }

    if (subsystemIssues.repo.errors.length === 0 && subsystemIssues.workflow.errors.length === 0) {
      try {
        workflow = await renderProjectWorkflow(project);
        validateRenderedWorkflow(workflow.content, recordIssue('workflow', 'render'));
        validateCodexPolicy(project, workflow.content, recordIssue('codexPolicy', 'render'));
      } catch (error) {
        recordIssue('workflow', 'render')({
          code: 'workflow_render_failed',
          field: 'workflow',
          message: `Workflow could not be rendered: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  if (includesPhase(phase, 'workspace')) {
    await validateWritableDirectory(workspaceRoot, 'workspaceRoot', 'workspace_root_unavailable', recordIssue('filesystem', 'workspace'));
    await validateWritableDirectory(logsRoot, 'logsRoot', 'logs_root_unavailable', recordIssue('filesystem', 'workspace'));
  }

  if (includesPhase(phase, 'live')) {
    await validateRunner(project, workspaceRoot, recordIssue('runner', 'live'), options.portAvailable ?? isPortAvailable);
  }

  await validateLinear(project, options, recordIssue('linear', phase));

  const subsystems = finalizeSubsystems(subsystemIssues);
  const phases = finalizePhases(phaseIssues);
  const issues = Object.values(subsystems).flatMap((subsystem) => subsystem.errors);
  const warnings = Object.values(subsystems).flatMap((subsystem) => subsystem.warnings);

  return {
    ok: issues.length === 0,
    phase,
    projectId: project.id,
    workflowPath,
    workspaceRoot,
    logsRoot,
    issues,
    warnings,
    subsystems,
    phases,
    workflow
  };
}

export async function validateProjectWorkflowSetups(projects: ManagedProject[], options: WorkflowSetupValidationOptions = {}): Promise<WorkflowSetupValidation[]> {
  return Promise.all(projects.map((project) => validateProjectWorkflowSetup(project, options)));
}

export async function writeProjectWorkflow(project: ManagedProject): Promise<WorkflowRenderResult> {
  const validation = await validateProjectWorkflowSetup(project, { phase: 'schema' });

  if (!validation.ok) {
    throw new WorkflowSetupValidationError([validation]);
  }

  const workflow = await renderProjectWorkflow(project);

  await mkdir(workflow.workspaceRoot, { recursive: true });
  await mkdir(workflow.logsRoot, { recursive: true });
  await mkdir(dirname(workflow.workflowPath), { recursive: true });
  await writeFile(workflow.workflowPath, workflow.content, 'utf8');
  return workflow;
}

export class WorkflowSetupValidationError extends Error {
  readonly validations: WorkflowSetupValidation[];

  constructor(validations: WorkflowSetupValidation[]) {
    const issues = validations.flatMap((validation) => validation.issues);
    super(`Invalid workflow setup:\n${issues.map((issue) => `- ${issue.field}: ${issue.message}`).join('\n')}`);
    this.name = 'WorkflowSetupValidationError';
    this.validations = validations;
  }
}

function createSubsystems(): Record<WorkflowSetupSubsystemName, { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }> {
  return {
    registry: { errors: [], warnings: [] },
    repo: { errors: [], warnings: [] },
    workflow: { errors: [], warnings: [] },
    linear: { errors: [], warnings: [] },
    runner: { errors: [], warnings: [] },
    filesystem: { errors: [], warnings: [] },
    codexPolicy: { errors: [], warnings: [] }
  };
}

function createPhases(): Record<WorkflowSetupValidationPhase, { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }> {
  return {
    schema: { errors: [], warnings: [] },
    render: { errors: [], warnings: [] },
    workspace: { errors: [], warnings: [] },
    live: { errors: [], warnings: [] }
  };
}

function issueRecorder(
  subsystems: ReturnType<typeof createSubsystems>,
  phases: ReturnType<typeof createPhases>
) {
  return (subsystemName: WorkflowSetupSubsystemName, phase: WorkflowSetupValidationPhase) =>
    (issue: WorkflowSetupIssue, severity: 'error' | 'warning' = 'error'): void => {
      const nextIssue = { ...issue, phase, severity };
      subsystems[subsystemName][severity === 'error' ? 'errors' : 'warnings'].push(nextIssue);
      phases[phase][severity === 'error' ? 'errors' : 'warnings'].push(nextIssue);
    };
}

function finalizeSubsystems(subsystems: ReturnType<typeof createSubsystems>): WorkflowSetupSubsystems {
  return Object.fromEntries(Object.entries(subsystems).map(([name, subsystem]) => [
    name,
    { ok: subsystem.errors.length === 0, errors: subsystem.errors, warnings: subsystem.warnings }
  ])) as WorkflowSetupSubsystems;
}

function finalizePhases(phases: ReturnType<typeof createPhases>): WorkflowSetupPhaseResults {
  return Object.fromEntries(Object.entries(phases).map(([name, phase]) => [
    name,
    { ok: phase.errors.length === 0, errors: phase.errors, warnings: phase.warnings }
  ])) as WorkflowSetupPhaseResults;
}

function includesPhase(selected: WorkflowSetupValidationPhase, candidate: WorkflowSetupValidationPhase): boolean {
  const order: WorkflowSetupValidationPhase[] = ['schema', 'render', 'workspace', 'live'];
  return order.indexOf(selected) >= order.indexOf(candidate);
}

type AddWorkflowSetupIssue = (issue: WorkflowSetupIssue, severity?: 'error' | 'warning') => void;

function validateRegistry(registry: ManagedProjectRegistry | undefined, addIssue: AddWorkflowSetupIssue): void {
  if (registry === undefined) {
    return;
  }
  try {
    validateProjectRegistry(registry);
  } catch (error) {
    const messages = error instanceof Error && 'issues' in error && Array.isArray(error.issues) ? error.issues : [error instanceof Error ? error.message : String(error)];
    for (const message of messages) {
      addIssue({ code: 'registry_schema_invalid', field: 'registry', message: String(message) });
    }
  }
}

async function validateRepoWorkflowPath(repoPath: string, workflowPath: string, addIssue: AddWorkflowSetupIssue): Promise<void> {
  const path = resolve(repoPath, workflowPath);
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      addIssue({ code: 'workflow_path_missing', field: 'workflow.path', message: 'Repo-owned workflow path is not a file', path });
    }
  } catch {
    addIssue({ code: 'workflow_path_missing', field: 'workflow.path', message: 'Repo-owned workflow path does not exist', path });
  }
}

async function validateWritableDirectory(
  path: string,
  field: string,
  code: Extract<WorkflowSetupIssueCode, 'workspace_root_unavailable' | 'logs_root_unavailable'>,
  addIssue: AddWorkflowSetupIssue
): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    addIssue({
      code,
      field,
      message: `Directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
      path
    });
  }
}

async function validateRunner(
  project: ManagedProject,
  workspaceRoot: string,
  addIssue: AddWorkflowSetupIssue,
  portAvailable: PortAvailabilityProbe
): Promise<void> {
  const legacyProject = project as ManagedProject & { symphony?: { command?: string; cwd?: string; runnerPort?: number; args?: string[] } };
  const command = process.env.SYMPHONY_RUNNER_COMMAND ?? legacyProject.symphony?.command ?? 'symphony';
  const cwd = resolve(process.env.SYMPHONY_RUNNER_CWD ?? legacyProject.symphony?.cwd ?? workspaceRoot);
  const runnerPort = Number(process.env.SYMPHONY_RUNNER_PORT ?? legacyProject.symphony?.runnerPort ?? '0');
  let blockingRunnerIssues = 0;
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      blockingRunnerIssues += 1;
      addIssue({ code: 'runner_cwd_missing', field: 'symphony.cwd', message: 'Runner cwd is not a directory', path: cwd });
    }
  } catch {
    blockingRunnerIssues += 1;
    addIssue({ code: 'runner_cwd_missing', field: 'symphony.cwd', message: 'Runner cwd does not exist', path: cwd });
  }

  if (command.includes('/')) {
    try {
      await access(resolve(command), constants.X_OK);
    } catch {
      blockingRunnerIssues += 1;
      addIssue({ code: 'runner_command_not_executable', field: 'SYMPHONY_RUNNER_COMMAND', message: 'Runner command path is not executable', path: resolve(command) });
    }
  } else {
    const found = await commandExists(command);
    if (!found) {
      blockingRunnerIssues += 1;
      addIssue({
        code: 'runner_command_missing',
        field: 'SYMPHONY_RUNNER_COMMAND',
        message: `Runner command "${command}" was not found on PATH. Install Symphony or set SYMPHONY_RUNNER_COMMAND to an executable runner.`
      });
    }
  }

  if (runnerPort > 0 && !await portAvailable(runnerPort)) {
    blockingRunnerIssues += 1;
    addIssue({ code: 'runner_port_unavailable', field: 'SYMPHONY_RUNNER_PORT', message: `Runner port ${runnerPort} is already in use` });
  }

  if (blockingRunnerIssues === 0) {
    await validateRunnerInvocation(command, legacyProject.symphony?.args, cwd, addIssue);
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v "$1"`, 'sh', command]);
    return true;
  } catch {
    return false;
  }
}

async function validateRunnerInvocation(command: string, configuredArgs: string[] | undefined, cwd: string, addIssue: AddWorkflowSetupIssue): Promise<void> {
  const args = [...(configuredArgs ?? []), '--help'];
  try {
    await execFileAsync(command, args, {
      cwd,
      timeout: 2_000,
      windowsHide: true
    });
  } catch (error) {
    if (isExecTimeout(error)) {
      return;
    }

    addIssue({
      code: 'runner_command_probe_failed',
      field: 'SYMPHONY_RUNNER_COMMAND',
      message: `Runner command exited during live probe. Live validation checks command existence and performs a warning-only compatibility probe, but does not guarantee full startup readiness. ${formatExecFailure(error)}`
    }, 'warning');
  }
}

function isExecTimeout(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'killed' in error
    && error.killed === true
    && 'signal' in error
    && error.signal === 'SIGTERM';
}

function formatExecFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.trim() : '';
  const excerpt = firstLine(stderr.length > 0 ? stderr : stdout);
  return excerpt.length > 0 ? excerpt : error.message;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? '';
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function validateLinear(project: ManagedProject, options: WorkflowSetupValidationOptions, addIssue: AddWorkflowSetupIssue): Promise<void> {
  if (!options.validateLinear) {
    return;
  }
  if (!options.env?.LINEAR_API_KEY) {
    addIssue({ code: 'linear_token_missing', field: 'LINEAR_API_KEY', message: 'Linear API token is required when Linear validation is requested' });
  }
  const legacyProject = project as ManagedProject & { tracker?: { projectSlug?: string; projectId?: string } };
  if (legacyProject.tracker === undefined) {
    return;
  }
  if ((legacyProject.tracker.projectSlug ?? '').trim().length === 0) {
    addIssue({ code: 'linear_project_slug_missing', field: 'tracker.projectSlug', message: 'Linear project slug is required when Linear validation is requested' });
  }
}

function validateRenderedWorkflow(content: string, addIssue: AddWorkflowSetupIssue): void {
  try {
    const parsed = parseWorkflowTemplate(content);
    if (!isRecord(parsed.frontMatter.tracker) || !isRecord(parsed.frontMatter.workspace) || !isRecord(parsed.frontMatter.codex)) {
      addIssue({ code: 'workflow_front_matter_invalid', field: 'workflow.frontMatter', message: 'Rendered workflow is missing required Symphony front matter sections' });
    }
    if (parsed.body.trim().length === 0) {
      addIssue({ code: 'workflow_prompt_missing', field: 'workflow.prompt', message: 'Rendered workflow prompt body is empty' });
    }
  } catch (error) {
    addIssue({ code: 'workflow_front_matter_invalid', field: 'workflow.frontMatter', message: `Rendered workflow front matter is invalid: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function validateCodexPolicy(project: ManagedProject, workflowContent: string, addIssue: AddWorkflowSetupIssue): void {
  const expectsGit = /\b(git|GitHub|github|clone|fetch|push|pull|PR)\b/.test(workflowContent);
  const turnSandbox = project.codex.turnSandbox;
  const hasFilesystemWrite = turnSandbox.type === 'workspaceWrite' || turnSandbox.type === 'dangerFullAccess';
  const hasNetworkAccess = turnSandbox.type === 'dangerFullAccess'
    || (turnSandbox.type === 'workspaceWrite' && turnSandbox.networkAccess === true)
    || (turnSandbox.type === 'readOnly' && turnSandbox.networkAccess === true)
    || (turnSandbox.type === 'externalSandbox' && turnSandbox.networkAccess === 'enabled');

  if (expectsGit && !hasFilesystemWrite) {
    addIssue({ code: 'codex_turn_sandbox_missing', field: 'codex.turnSandbox', message: 'Workflow expects git/GitHub operations but turn sandbox does not grant workspace write access' });
  }

  if (expectsGit && !hasNetworkAccess) {
    addIssue({ code: 'codex_turn_sandbox_missing', field: 'codex.turnSandbox.networkAccess', message: 'Workflow expects git/GitHub operations but turn sandbox does not grant network access' });
  }
}

type WorkflowTemplate = {
  frontMatter: Record<string, unknown>;
  body: string;
};

const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress', 'In Review'];
const DEFAULT_TERMINAL_STATES = ['Done', 'Duplicate', 'Canceled', 'Cancelled', 'Closed'];
const DEFAULT_AGENT_MAX_CONCURRENT = 10;
const DEFAULT_AGENT_MAX_TURNS = 20;
const DEFAULT_CODEX_COMMAND = 'codex --config shell_environment_policy.inherit=all app-server';
const DEFAULT_CODEX_APPROVAL_POLICY = 'never';

async function loadWorkflowTemplate(project: ManagedProject, repoPath: string): Promise<WorkflowTemplate> {
  if (project.workflow.source === 'generated') {
    return defaultWorkflowTemplate(project);
  }

  const templatePath = resolve(repoPath, project.workflow.path);
  let raw: string;
  try {
    raw = await readFile(templatePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaultWorkflowTemplate(project);
    }
    throw error;
  }
  return parseWorkflowTemplate(raw);
}

function defaultWorkflowTemplate(project: ManagedProject): WorkflowTemplate {
  return {
    frontMatter: {},
    body: [
      `You are working on a Linear ticket \`{{ issue.identifier }}\` for ${project.name}.`,
      '',
      'Use the repository cloned into this workspace as the source of truth.',
      'Keep the Linear issue workpad current and validate changes before handing off.'
    ].join('\n')
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseWorkflowTemplate(raw: string): WorkflowTemplate {
  const normalized = raw.replace(/^\uFEFF/, '');

  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontMatter: {}, body: normalized };
  }

  const lineEnding = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const startLength = 3 + lineEnding.length;
  const endMarker = `${lineEnding}---`;
  const endIndex = normalized.indexOf(endMarker, startLength);

  if (endIndex === -1) {
    throw new Error('Workflow template front matter is missing a closing --- delimiter');
  }

  const frontMatterRaw = normalized.slice(startLength, endIndex);
  const afterEnd = normalized.slice(endIndex + endMarker.length);
  const body = afterEnd.startsWith('\r\n') ? afterEnd.slice(2) : afterEnd.startsWith('\n') ? afterEnd.slice(1) : afterEnd;
  const parsed = frontMatterRaw.trim().length === 0 ? {} : YAML.parse(frontMatterRaw);

  if (!isRecord(parsed)) {
    throw new Error('Workflow template front matter must be a YAML mapping');
  }

  return { frontMatter: parsed, body };
}

function mergeWorkflowFrontMatter(
  existing: Record<string, unknown>,
  project: ManagedProject,
  workspaceRoot: string
): Record<string, unknown> {
  const runtime = project.workflow.runtime;
  return {
    ...existing,
    tracker: {
      ...readRecord(existing.tracker),
      kind: 'linear',
      project_slug: project.id,
      active_states: runtime?.tracker?.activeStates ?? DEFAULT_ACTIVE_STATES,
      terminal_states: runtime?.tracker?.terminalStates ?? DEFAULT_TERMINAL_STATES
    },
    workspace: {
      ...readRecord(existing.workspace),
      root: workspaceRoot
    },
    hooks: {
      ...readRecord(existing.hooks),
      after_create: renderAfterCreateHook(project),
      before_remove: runtime?.hooks?.beforeRemove ?? 'true'
    },
    agent: {
      ...readRecord(existing.agent),
      max_concurrent_agents: runtime?.agent?.maxConcurrentAgents ?? DEFAULT_AGENT_MAX_CONCURRENT,
      max_turns: runtime?.agent?.maxTurns ?? DEFAULT_AGENT_MAX_TURNS
    },
    codex: {
      ...readRecord(existing.codex),
      command: runtime?.codex?.command ?? DEFAULT_CODEX_COMMAND,
      approval_policy: runtime?.codex?.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY,
      thread_sandbox: project.codex.threadSandbox,
      turn_sandbox_policy: project.codex.turnSandbox
    }
  };
}

function renderAfterCreateHook(project: ManagedProject): string {
  const hook = project.workflow.runtime?.hooks?.afterCreate;

  if (hook?.type === 'none') {
    return 'true';
  }

  const cloneSource = hook?.type === 'gitClone' && hook.cloneSource !== undefined
    ? hook.cloneSource
    : projectGithubUrl(project);
  const target = hook?.type === 'gitClone' && hook.target !== undefined ? hook.target : '.';
  return shellCommand(['git', 'clone', cloneSource, target]);
}

function projectWorkspaceRoot(project: ManagedProject): string {
  const legacyProject = project as ManagedProject & { symphony?: { workspaceRoot?: string } };
  if (legacyProject.symphony?.workspaceRoot !== undefined) {
    return resolve(legacyProject.symphony.workspaceRoot);
  }
  return resolve(process.env.DEFAULT_SYMPHONY_WORKSPACES ?? join(tmpdir(), 'symphony-workspaces'), project.id);
}

function projectLogsRoot(project: ManagedProject): string {
  const legacyProject = project as ManagedProject & { symphony?: { logsRoot?: string } };
  if (legacyProject.symphony?.logsRoot !== undefined) {
    return resolve(legacyProject.symphony.logsRoot);
  }
  return resolve(process.env.DEFAULT_SYMPHONY_LOGS ?? join(tmpdir(), 'symphony-logs'), project.id);
}

function projectRepoPath(project: ManagedProject): string | undefined {
  const legacyProject = project as ManagedProject & { repo?: { path?: string } };
  return legacyProject.repo?.path === undefined ? undefined : resolve(legacyProject.repo.path);
}

function projectGithubUrl(project: ManagedProject): string {
  const legacyProject = project as ManagedProject & { repo?: { cloneSource?: string } };
  return legacyProject.repo?.cloneSource ?? project.githubUrl ?? '';
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function renderWorkflowDocument(frontMatter: Record<string, unknown>, body: string): string {
  const frontMatterYaml = YAML.stringify(frontMatter, { collectionStyle: 'block' }).trimEnd();
  return `---\n${frontMatterYaml}\n---\n\n${body}`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
