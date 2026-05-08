import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export type ManagedProjectRegistry = {
  version: 2;
  projects: ManagedProject[];
};

export type ManagedProject = {
  id: string;
  name: string;
  tracker: TrackerProjectConfig;
  repo: RepositoryConfig;
  workflow: WorkflowConfig;
  symphony: SymphonyProjectConfig;
  codex: CodexPolicyConfig;
};

export type TrackerProjectConfig = {
  kind: 'linear';
  teamKey: string;
  teamId: string;
  projectId: string;
  projectSlug: string;
};

export type RepositoryConfig = {
  path: string;
  remoteUrl: string;
  defaultBranch: string;
  cloneSource: string;
};

export type WorkflowConfig =
  | {
      source: 'repo';
      path: string;
    }
  | {
      source: 'generated';
      template: string;
    };

export type CodexSandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexPolicyConfig = {
  threadSandbox: CodexSandboxPolicy;
  turnSandbox: CodexSandboxPolicy;
};

export type SymphonyProjectConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  runnerPort: number;
  workspaceRoot: string;
  logsRoot: string;
  dashboardUrl?: string;
};

export type ProjectRegistry = ManagedProjectRegistry;
export type RegistryProject = ManagedProject;
export type ManagedProjectPatch = Partial<Omit<ManagedProject, 'tracker' | 'repo' | 'workflow' | 'symphony' | 'codex'>> & {
  tracker?: Partial<TrackerProjectConfig>;
  repo?: Partial<RepositoryConfig>;
  workflow?: Partial<WorkflowConfig>;
  symphony?: Partial<SymphonyProjectConfig>;
  codex?: Partial<CodexPolicyConfig>;
};

export type ProjectRegistryService = {
  create(project: ManagedProject): Promise<ManagedProject>;
  load(): Promise<ManagedProjectRegistry>;
  list(): Promise<ManagedProject[]>;
  update(projectId: string, patch: ManagedProjectPatch): Promise<ManagedProject>;
  validate(registry: ManagedProjectRegistry): void;
};

export class ProjectRegistryValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid project registry:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ProjectRegistryValidationError';
    this.issues = issues;
  }
}

const nonEmptyString = z.string().trim().min(1, 'expected a non-empty string');
const port = z.number().int().min(1).max(65535);
const sandboxPolicy = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

export const managedProjectSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  tracker: z.object({
    kind: z.literal('linear'),
    teamKey: nonEmptyString,
    teamId: nonEmptyString,
    projectId: nonEmptyString,
    projectSlug: nonEmptyString
  }).strict(),
  repo: z.object({
    path: nonEmptyString,
    remoteUrl: nonEmptyString,
    defaultBranch: nonEmptyString,
    cloneSource: nonEmptyString
  }).strict(),
  workflow: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('repo'),
      path: nonEmptyString
    }).strict(),
    z.object({
      source: z.literal('generated'),
      template: nonEmptyString
    }).strict()
  ]),
  symphony: z.object({
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    cwd: nonEmptyString.optional(),
    runnerPort: port,
    workspaceRoot: nonEmptyString,
    logsRoot: nonEmptyString,
    dashboardUrl: nonEmptyString.optional()
  }).strict(),
  codex: z.object({
    threadSandbox: sandboxPolicy,
    turnSandbox: sandboxPolicy
  }).strict()
}).strict();

export const managedProjectRegistrySchema = z.object({
  version: z.literal(2),
  projects: z.array(managedProjectSchema)
}).strict();

export function createEmptyRegistry(): ManagedProjectRegistry {
  return { version: 2, projects: [] };
}

export function createProjectRegistryService(configPath: string): ProjectRegistryService {
  const registryPath = resolve(configPath);

  return {
    async create(project: ManagedProject): Promise<ManagedProject> {
      const registry = await loadRegistry(registryPath);
      const nextRegistry = { ...registry, projects: [...registry.projects, project] };
      validateProjectRegistry(nextRegistry);
      await saveRegistry(registryPath, nextRegistry);
      return project;
    },

    async load(): Promise<ManagedProjectRegistry> {
      return loadRegistry(registryPath);
    },

    async list(): Promise<ManagedProject[]> {
      return (await loadRegistry(registryPath)).projects;
    },

    async update(projectId: string, patch: ManagedProjectPatch): Promise<ManagedProject> {
      const registry = await loadRegistry(registryPath);
      const projectIndex = registry.projects.findIndex((project) => project.id === projectId);

      if (projectIndex === -1) {
        throw new ProjectRegistryValidationError([`projects: project id "${projectId}" was not found`]);
      }

      const existing = registry.projects[projectIndex];
      const updated = mergeProject(existing, patch);
      const projects = registry.projects.slice();
      projects[projectIndex] = updated;
      const nextRegistry = { ...registry, projects };
      validateProjectRegistry(nextRegistry);
      await saveRegistry(registryPath, nextRegistry);
      return updated;
    },

    validate(registry: ManagedProjectRegistry): void {
      validateProjectRegistry(registry);
    }
  };
}

export async function loadRegistry(configPath: string): Promise<ManagedProjectRegistry> {
  let raw: string;

  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptyRegistry();
    }

    throw error;
  }

  const parsed = YAML.parse(raw) as unknown;
  const registry = normalizeRegistry(parsed);
  validateProjectRegistry(registry);
  return registry;
}

export async function saveRegistry(configPath: string, registry: ManagedProjectRegistry): Promise<void> {
  validateProjectRegistry(registry);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(registry, { collectionStyle: 'block' }), 'utf8');
}

export function validateProjectRegistry(registry: ManagedProjectRegistry): void {
  const parsed = managedProjectRegistrySchema.safeParse(registry);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => {
    const path = formatZodPath(issue.path);
    return `${path}: ${registryIssueMessage(issue.message)}`;
  });

  if (parsed.success) {
    validateProjects(parsed.data.projects, issues);
  }

  if (issues.length > 0) {
    throw new ProjectRegistryValidationError(issues);
  }
}

function formatZodPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return 'registry';
  }

  return path.reduce((formatted, part) => {
    if (typeof part === 'number') {
      return `${formatted}[${part}]`;
    }
    return formatted.length === 0 ? String(part) : `${formatted}.${String(part)}`;
  }, '');
}

function registryIssueMessage(message: string): string {
  return message.startsWith('Too big: expected number to be <=65535')
    ? 'expected an integer from 1 to 65535'
    : message;
}

function normalizeRegistry(value: unknown): ManagedProjectRegistry {
  if (value === null || value === undefined) {
    return createEmptyRegistry();
  }

  if (!isRecord(value)) {
    throw new ProjectRegistryValidationError(['registry: expected an object']);
  }

  return {
    version: value.version,
    projects: value.projects
  } as ManagedProjectRegistry;
}

function validateProjects(projects: unknown[], issues: string[]): void {
  const projectIds = new Map<string, number>();
  const linearIdentities = new Map<string, number>();
  const repoPaths = new Map<string, number>();
  const workspacePaths = new Map<string, number>();
  const ports = new Map<number, string>();

  projects.forEach((project, index) => {
    const prefix = `projects[${index}]`;

    if (!isRecord(project)) {
      issues.push(`${prefix}: expected an object`);
      return;
    }

    const id = readRequiredString(project.id, `${prefix}.id`, issues);
    readRequiredString(project.name, `${prefix}.name`, issues);

    if (id !== undefined) {
      addStringCollision(projectIds, id, index, `${prefix}.id`, 'project id', issues);
    }

    validateTracker(project.tracker, prefix, index, linearIdentities, issues);
    validateRepo(project.repo, prefix, index, repoPaths, issues);
    validateSymphony(project.symphony, prefix, index, workspacePaths, ports, issues);
  });
}

function validateTracker(
  value: unknown,
  prefix: string,
  projectIndex: number,
  linearIdentities: Map<string, number>,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${prefix}.tracker: expected an object`);
    return;
  }

  if (value.kind !== 'linear') {
    issues.push(`${prefix}.tracker.kind: expected "linear"`);
  }
  const teamKey = readRequiredString(value.teamKey, `${prefix}.tracker.teamKey`, issues);
  const teamId = readRequiredString(value.teamId, `${prefix}.tracker.teamId`, issues);
  const projectId = readRequiredString(value.projectId, `${prefix}.tracker.projectId`, issues);
  readRequiredString(value.projectSlug, `${prefix}.tracker.projectSlug`, issues);

  if (teamKey !== undefined && teamId !== undefined && projectId !== undefined) {
    const identity = `${teamKey}:${teamId}:${projectId}`;
    addStringCollision(linearIdentities, identity, projectIndex, `${prefix}.tracker`, 'Linear identity', issues);
  }
}

function validateRepo(
  value: unknown,
  prefix: string,
  projectIndex: number,
  repoPaths: Map<string, number>,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${prefix}.repo: expected an object`);
    return;
  }

  const repoPath = readRequiredString(value.path, `${prefix}.repo.path`, issues);
  readRequiredString(value.remoteUrl, `${prefix}.repo.remoteUrl`, issues);
  readRequiredString(value.defaultBranch, `${prefix}.repo.defaultBranch`, issues);
  readRequiredString(value.cloneSource, `${prefix}.repo.cloneSource`, issues);

  if (repoPath !== undefined) {
    addStringCollision(repoPaths, resolve(repoPath), projectIndex, `${prefix}.repo.path`, 'repo path', issues);
  }
}

function validateSymphony(
  value: unknown,
  prefix: string,
  projectIndex: number,
  workspacePaths: Map<string, number>,
  ports: Map<number, string>,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${prefix}.symphony: expected an object`);
    return;
  }

  readRequiredString(value.command, `${prefix}.symphony.command`, issues);
  validateOptionalStringArray(value.args, `${prefix}.symphony.args`, issues);
  readOptionalString(value.cwd, `${prefix}.symphony.cwd`, issues);
  const workspacePath = readRequiredString(value.workspaceRoot, `${prefix}.symphony.workspaceRoot`, issues);
  readRequiredString(value.logsRoot, `${prefix}.symphony.logsRoot`, issues);
  const runnerPort = readRequiredPort(value.runnerPort, `${prefix}.symphony.runnerPort`, issues);

  if (workspacePath !== undefined) {
    addStringCollision(
      workspacePaths,
      resolve(workspacePath),
      projectIndex,
      `${prefix}.symphony.workspaceRoot`,
      'workspace root',
      issues
    );
  }

  if (runnerPort !== undefined) {
    addPortCollision(ports, runnerPort, `${prefix}.symphony.runnerPort`, issues);
  }
}

function mergeProject(existing: ManagedProject, patch: ManagedProjectPatch): ManagedProject {
  return {
    ...existing,
    ...patch,
    tracker: { ...existing.tracker, ...patch.tracker },
    repo: { ...existing.repo, ...patch.repo },
    workflow: { ...existing.workflow, ...patch.workflow } as WorkflowConfig,
    symphony: { ...existing.symphony, ...patch.symphony },
    codex: { ...existing.codex, ...patch.codex }
  };
}

function readRequiredString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path}: expected a non-empty string`);
    return undefined;
  }

  return value;
}

function readOptionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path}: expected a non-empty string when provided`);
    return undefined;
  }

  return value;
}

function readRequiredPort(value: unknown, path: string, issues: string[]): number | undefined {
  if (!isPort(value)) {
    issues.push(`${path}: expected an integer from 1 to 65535`);
    return undefined;
  }

  return value;
}

function readOptionalPort(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredPort(value, path, issues);
}

function validateOptionalStringArray(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}: expected an array of strings when provided`);
    return;
  }

  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      issues.push(`${path}[${index}]: expected a string`);
    }
  });
}

function addStringCollision(
  seen: Map<string, number>,
  value: string,
  index: number,
  path: string,
  label: string,
  issues: string[]
): void {
  const existingIndex = seen.get(value);

  if (existingIndex !== undefined) {
    issues.push(`${path}: duplicate ${label} also used by projects[${existingIndex}]`);
    return;
  }

  seen.set(value, index);
}

function addPortCollision(seen: Map<number, string>, port: number, path: string, issues: string[]): void {
  const existingPath = seen.get(port);

  if (existingPath !== undefined) {
    issues.push(`${path}: duplicate port also used by ${existingPath}`);
    return;
  }

  seen.set(port, path);
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
