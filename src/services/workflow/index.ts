import { createServer } from 'node:net';
import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { createLinearService } from '../linear/index.ts';
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
  | 'runner_cwd_missing'
  | 'runner_command_not_executable'
  | 'runner_port_unavailable'
  | 'codex_turn_sandbox_missing';

export type WorkflowSetupIssue = {
  code: WorkflowSetupIssueCode;
  field: string;
  message: string;
  path?: string;
  severity?: 'error' | 'warning';
};

export type WorkflowSetupSubsystem = {
  ok: boolean;
  warnings: WorkflowSetupIssue[];
  errors: WorkflowSetupIssue[];
};

export type WorkflowSetupSubsystemName = 'registry' | 'repo' | 'workflow' | 'linear' | 'runner' | 'filesystem' | 'codexPolicy';

export type WorkflowSetupSubsystems = Record<WorkflowSetupSubsystemName, WorkflowSetupSubsystem>;

export type WorkflowRenderResult = {
  projectId: string;
  workflowPath: string;
  repoPath: string;
  workspaceRoot: string;
  logsRoot: string;
  content: string;
};

export type WorkflowSetupValidation = {
  ok: boolean;
  projectId: string;
  workflowPath: string;
  repoPath: string;
  workspaceRoot: string;
  logsRoot: string;
  issues: WorkflowSetupIssue[];
  warnings: WorkflowSetupIssue[];
  subsystems: WorkflowSetupSubsystems;
  workflow?: WorkflowRenderResult;
};

export type WorkflowSetupValidationOptions = {
  registry?: ManagedProjectRegistry;
  validateLinear?: boolean;
  env?: Record<string, string | undefined>;
  portAvailable?: PortAvailabilityProbe;
};

export type PortAvailabilityProbe = (port: number) => Promise<boolean>;

export async function renderProjectWorkflow(project: ManagedProject): Promise<WorkflowRenderResult> {
  const repoPath = resolve(project.repo.path);
  const workspaceRoot = resolve(project.symphony.workspaceRoot);
  const logsRoot = resolve(project.symphony.logsRoot);
  const workflowPath = join(workspaceRoot, 'WORKFLOW.md');
  const template = await loadWorkflowTemplate(project, repoPath);
  const frontMatter = mergeWorkflowFrontMatter(template.frontMatter, project, workspaceRoot);
  const content = renderWorkflowDocument(frontMatter, template.body);

  return { projectId: project.id, workflowPath, repoPath, workspaceRoot, logsRoot, content };
}

export async function validateProjectWorkflowSetup(project: ManagedProject, options: WorkflowSetupValidationOptions = {}): Promise<WorkflowSetupValidation> {
  const subsystemIssues = createSubsystems();
  let workflow: WorkflowRenderResult | undefined;
  const repoPath = resolve(project.repo.path);
  const workspaceRoot = resolve(project.symphony.workspaceRoot);
  const logsRoot = resolve(project.symphony.logsRoot);
  const workflowPath = join(workspaceRoot, 'WORKFLOW.md');

  validateRegistry(options.registry, subsystemIssues.registry);
  await validateRepo(project, repoPath, subsystemIssues.repo);
  await validateWritableDirectory(workspaceRoot, 'workspaceRoot', 'workspace_root_unavailable', subsystemIssues.filesystem);
  await validateWritableDirectory(logsRoot, 'logsRoot', 'logs_root_unavailable', subsystemIssues.filesystem);
  await validateRunner(project, workspaceRoot, subsystemIssues.runner, options.portAvailable ?? isPortAvailable);
  await validateLinear(project, options, subsystemIssues.linear);

  if (project.workflow.source === 'repo') {
    await validateRepoWorkflowPath(repoPath, project.workflow.path, subsystemIssues.workflow);
  }

  if (subsystemIssues.repo.errors.length === 0 && subsystemIssues.workflow.errors.length === 0) {
    try {
      workflow = await renderProjectWorkflow(project);
      validateRenderedWorkflow(workflow.content, subsystemIssues.workflow);
      validateCodexPolicy(project, workflow.content, subsystemIssues.codexPolicy);
    } catch (error) {
      addIssue(subsystemIssues.workflow, {
        code: 'workflow_render_failed',
        field: 'workflow',
        message: `Workflow could not be rendered: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const subsystems = finalizeSubsystems(subsystemIssues);
  const issues = Object.values(subsystems).flatMap((subsystem) => subsystem.errors);
  const warnings = Object.values(subsystems).flatMap((subsystem) => subsystem.warnings);

  return {
    ok: issues.length === 0,
    projectId: project.id,
    workflowPath,
    repoPath,
    workspaceRoot,
    logsRoot,
    issues,
    warnings,
    subsystems,
    workflow
  };
}

export async function validateProjectWorkflowSetups(projects: ManagedProject[], options: WorkflowSetupValidationOptions = {}): Promise<WorkflowSetupValidation[]> {
  return Promise.all(projects.map((project) => validateProjectWorkflowSetup(project, options)));
}

export async function writeProjectWorkflow(project: ManagedProject): Promise<WorkflowRenderResult> {
  const validation = await validateProjectWorkflowSetup(project);

  if (!validation.ok || validation.workflow === undefined) {
    throw new WorkflowSetupValidationError([validation]);
  }

  await mkdir(validation.workspaceRoot, { recursive: true });
  await mkdir(validation.logsRoot, { recursive: true });
  await mkdir(dirname(validation.workflowPath), { recursive: true });
  await writeFile(validation.workflowPath, validation.workflow.content, 'utf8');
  return validation.workflow;
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

function addIssue(subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }, issue: WorkflowSetupIssue, severity: 'error' | 'warning' = 'error'): void {
  subsystem[severity === 'error' ? 'errors' : 'warnings'].push({ ...issue, severity });
}

function finalizeSubsystems(subsystems: ReturnType<typeof createSubsystems>): WorkflowSetupSubsystems {
  return Object.fromEntries(Object.entries(subsystems).map(([name, subsystem]) => [
    name,
    { ok: subsystem.errors.length === 0, errors: subsystem.errors, warnings: subsystem.warnings }
  ])) as WorkflowSetupSubsystems;
}

function validateRegistry(registry: ManagedProjectRegistry | undefined, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): void {
  if (registry === undefined) {
    return;
  }
  try {
    validateProjectRegistry(registry);
  } catch (error) {
    const messages = error instanceof Error && 'issues' in error && Array.isArray(error.issues) ? error.issues : [error instanceof Error ? error.message : String(error)];
    for (const message of messages) {
      addIssue(subsystem, { code: 'registry_schema_invalid', field: 'registry', message: String(message) });
    }
  }
}

async function validateRepo(project: ManagedProject, repoPath: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): Promise<void> {
  await validateRepoPath(repoPath, subsystem);
  if (subsystem.errors.length > 0) {
    return;
  }
  await validateGitConfig(project, repoPath, subsystem);
}

async function validateRepoPath(repoPath: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): Promise<void> {
  try {
    const repoStat = await stat(repoPath);

    if (!repoStat.isDirectory()) {
      addIssue(subsystem, {
        code: 'repo_path_not_directory',
        field: 'repo.path',
        message: 'Repo path exists but is not a directory',
        path: repoPath
      });
      return;
    }
  } catch {
    addIssue(subsystem, {
      code: 'repo_path_missing',
      field: 'repo.path',
      message: 'Repo path does not exist',
      path: repoPath
    });
    return;
  }

  try {
    await access(join(repoPath, '.git'));
  } catch {
    addIssue(subsystem, {
      code: 'repo_path_not_git_repo',
      field: 'repo.path',
      message: 'Repo path is not a git repository',
      path: repoPath
    });
  }
}

async function validateGitConfig(project: ManagedProject, repoPath: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    if (stdout.trim().length === 0) {
      addIssue(subsystem, { code: 'repo_remote_missing', field: 'repo.remoteUrl', message: 'Git origin remote is not configured' }, 'warning');
    }
  } catch {
    addIssue(subsystem, { code: 'repo_remote_missing', field: 'repo.remoteUrl', message: 'Git origin remote is not configured' }, 'warning');
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'show-ref', '--verify', `refs/heads/${project.repo.defaultBranch}`]);
    if (stdout.trim().length === 0) {
      addIssue(subsystem, { code: 'repo_default_branch_missing', field: 'repo.defaultBranch', message: `Default branch "${project.repo.defaultBranch}" is not present locally` }, 'warning');
    }
  } catch {
    addIssue(subsystem, { code: 'repo_default_branch_missing', field: 'repo.defaultBranch', message: `Default branch "${project.repo.defaultBranch}" is not present locally` }, 'warning');
  }
}

async function validateRepoWorkflowPath(repoPath: string, workflowPath: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): Promise<void> {
  const path = resolve(repoPath, workflowPath);
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      addIssue(subsystem, { code: 'workflow_path_missing', field: 'workflow.path', message: 'Repo-owned workflow path is not a file', path });
    }
  } catch {
    addIssue(subsystem, { code: 'workflow_path_missing', field: 'workflow.path', message: 'Repo-owned workflow path does not exist', path });
  }
}

async function validateWritableDirectory(
  path: string,
  field: string,
  code: Extract<WorkflowSetupIssueCode, 'workspace_root_unavailable' | 'logs_root_unavailable'>,
  subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }
): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    addIssue(subsystem, {
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
  subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] },
  portAvailable: PortAvailabilityProbe
): Promise<void> {
  const cwd = resolve(project.symphony.cwd ?? workspaceRoot);
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      addIssue(subsystem, { code: 'runner_cwd_missing', field: 'symphony.cwd', message: 'Runner cwd is not a directory', path: cwd });
    }
  } catch {
    addIssue(subsystem, { code: 'runner_cwd_missing', field: 'symphony.cwd', message: 'Runner cwd does not exist', path: cwd });
  }

  if (project.symphony.command.includes('/')) {
    try {
      await access(resolve(project.symphony.command), constants.X_OK);
    } catch {
      addIssue(subsystem, { code: 'runner_command_not_executable', field: 'symphony.command', message: 'Runner command path is not executable', path: resolve(project.symphony.command) });
    }
  } else {
    const found = await commandExists(project.symphony.command);
    if (!found) {
      addIssue(subsystem, { code: 'runner_command_missing', field: 'symphony.command', message: `Runner command "${project.symphony.command}" was not found on PATH` });
    }
  }

  const isAvailable = await portAvailable(project.symphony.runnerPort);
  if (!isAvailable) {
    addIssue(subsystem, { code: 'runner_port_unavailable', field: 'symphony.runnerPort', message: `Runner port ${project.symphony.runnerPort} is already in use` });
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

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function validateLinear(project: ManagedProject, options: WorkflowSetupValidationOptions, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): Promise<void> {
  if (!options.validateLinear) {
    return;
  }
  if (!options.env?.LINEAR_API_KEY) {
    addIssue(subsystem, { code: 'linear_token_missing', field: 'LINEAR_API_KEY', message: 'Linear API token is required when Linear validation is requested' });
  }
  if (project.tracker.projectSlug.trim().length === 0) {
    addIssue(subsystem, { code: 'linear_project_slug_missing', field: 'tracker.projectSlug', message: 'Linear project slug is required when Linear validation is requested' });
  }
  if (subsystem.errors.length > 0) {
    return;
  }
  try {
    const linearProject = await createLinearService({ apiKey: options.env.LINEAR_API_KEY }).resolveProjectSlug(project.tracker.projectSlug);
    if (linearProject === undefined || linearProject.id !== project.tracker.projectId) {
      addIssue(subsystem, {
        code: 'linear_project_slug_missing',
        field: 'tracker.projectSlug',
        message: `Linear project slug "${project.tracker.projectSlug}" did not resolve to configured project id`
      });
    }
  } catch (error) {
    addIssue(subsystem, {
      code: 'linear_project_slug_missing',
      field: 'tracker.projectSlug',
      message: `Linear project slug could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

function validateRenderedWorkflow(content: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): void {
  try {
    const parsed = parseWorkflowTemplate(content);
    if (!isRecord(parsed.frontMatter.tracker) || !isRecord(parsed.frontMatter.workspace) || !isRecord(parsed.frontMatter.codex)) {
      addIssue(subsystem, { code: 'workflow_front_matter_invalid', field: 'workflow.frontMatter', message: 'Rendered workflow is missing required Symphony front matter sections' });
    }
    if (parsed.body.trim().length === 0) {
      addIssue(subsystem, { code: 'workflow_prompt_missing', field: 'workflow.prompt', message: 'Rendered workflow prompt body is empty' });
    }
  } catch (error) {
    addIssue(subsystem, { code: 'workflow_front_matter_invalid', field: 'workflow.frontMatter', message: `Rendered workflow front matter is invalid: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function validateCodexPolicy(project: ManagedProject, workflowContent: string, subsystem: { errors: WorkflowSetupIssue[]; warnings: WorkflowSetupIssue[] }): void {
  const expectsGit = /\b(git|GitHub|github|clone|fetch|push|pull|PR)\b/.test(workflowContent);
  if (expectsGit && project.codex.turnSandbox === 'read-only') {
    addIssue(subsystem, { code: 'codex_turn_sandbox_missing', field: 'codex.turnSandbox', message: 'Workflow expects git/GitHub operations but turn sandbox is read-only' });
  }
}

type WorkflowTemplate = {
  frontMatter: Record<string, unknown>;
  body: string;
};

async function loadWorkflowTemplate(project: ManagedProject, repoPath: string): Promise<WorkflowTemplate> {
  if (project.workflow.source === 'generated') {
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

  const templatePath = resolve(repoPath, project.workflow.path);
  const raw = await readFile(templatePath, 'utf8');
  return parseWorkflowTemplate(raw);
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
  return {
    ...existing,
    tracker: {
      ...readRecord(existing.tracker),
      kind: 'linear',
      project_slug: project.tracker.projectSlug,
      active_states: ['Todo', 'In Progress', 'In Review'],
      terminal_states: ['Done', 'Duplicate', 'Canceled', 'Cancelled', 'Closed']
    },
    workspace: {
      ...readRecord(existing.workspace),
      root: workspaceRoot
    },
    hooks: {
      ...readRecord(existing.hooks),
      after_create: `git clone ${project.repo.cloneSource} .`,
      before_remove: 'true'
    },
    agent: {
      ...readRecord(existing.agent),
      max_concurrent_agents: 10,
      max_turns: 20
    },
    codex: {
      ...readRecord(existing.codex),
      command: 'codex --config shell_environment_policy.inherit=all app-server',
      approval_policy: 'never',
      thread_sandbox: project.codex.threadSandbox,
      turn_sandbox_policy: project.codex.turnSandbox
    }
  };
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
