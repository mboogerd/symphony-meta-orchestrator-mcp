import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { ManagedProject } from '../registry/index.ts';

export type WorkflowState = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';

export function isActiveWorkflowState(state: WorkflowState): boolean {
  return state === 'todo' || state === 'in_progress' || state === 'in_review';
}

export type WorkflowSetupIssueCode =
  | 'repo_path_missing'
  | 'repo_path_not_directory'
  | 'repo_path_not_git_repo'
  | 'workspace_root_unavailable'
  | 'logs_root_unavailable'
  | 'workflow_render_failed';

export type WorkflowSetupIssue = {
  code: WorkflowSetupIssueCode;
  field: string;
  message: string;
  path?: string;
};

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
  workflow?: WorkflowRenderResult;
};

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

export async function validateProjectWorkflowSetup(project: ManagedProject): Promise<WorkflowSetupValidation> {
  const issues: WorkflowSetupIssue[] = [];
  let workflow: WorkflowRenderResult | undefined;
  const repoPath = resolve(project.repo.path);
  const workspaceRoot = resolve(project.symphony.workspaceRoot);
  const logsRoot = resolve(project.symphony.logsRoot);
  const workflowPath = join(workspaceRoot, 'WORKFLOW.md');

  await validateRepoPath(repoPath, issues);
  await validateWritableDirectory(workspaceRoot, 'workspaceRoot', 'workspace_root_unavailable', issues);
  await validateWritableDirectory(logsRoot, 'logsRoot', 'logs_root_unavailable', issues);

  if (!issues.some((issue) => issue.field === 'repo.path')) {
    try {
      workflow = await renderProjectWorkflow(project);
    } catch (error) {
      issues.push({
        code: 'workflow_render_failed',
        field: 'workflow',
        message: `Workflow could not be rendered: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return {
    ok: issues.length === 0,
    projectId: project.id,
    workflowPath,
    repoPath,
    workspaceRoot,
    logsRoot,
    issues,
    workflow
  };
}

export async function validateProjectWorkflowSetups(projects: ManagedProject[]): Promise<WorkflowSetupValidation[]> {
  return Promise.all(projects.map((project) => validateProjectWorkflowSetup(project)));
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

async function validateRepoPath(repoPath: string, issues: WorkflowSetupIssue[]): Promise<void> {
  try {
    const repoStat = await stat(repoPath);

    if (!repoStat.isDirectory()) {
      issues.push({
        code: 'repo_path_not_directory',
        field: 'repo.path',
        message: 'Repo path exists but is not a directory',
        path: repoPath
      });
      return;
    }
  } catch {
    issues.push({
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
    issues.push({
      code: 'repo_path_not_git_repo',
      field: 'repo.path',
      message: 'Repo path is not a git repository',
      path: repoPath
    });
  }
}

async function validateWritableDirectory(
  path: string,
  field: string,
  code: Extract<WorkflowSetupIssueCode, 'workspace_root_unavailable' | 'logs_root_unavailable'>,
  issues: WorkflowSetupIssue[]
): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    issues.push({
      code,
      field,
      message: `Directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
      path
    });
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
