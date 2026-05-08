import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export type ManagedProjectRegistry = {
  version: 1;
  projects: ManagedProject[];
};

export type ManagedProject = {
  id: string;
  name: string;
  linear: LinearProjectConfig;
  repo: RepositoryConfig;
  symphony: SymphonyProjectConfig;
};

export type LinearProjectConfig = {
  teamKey: string;
  projectId?: string;
  projectKey?: string;
};

export type RepositoryConfig = {
  path: string;
  remote?: string;
  branch?: string;
};

export type SymphonyProjectConfig = {
  workspacePath: string;
  logsPath?: string;
  mcpPort: number;
  runnerPort?: number;
};

export type ProjectRegistry = ManagedProjectRegistry;
export type RegistryProject = ManagedProject;

export type ProjectRegistryService = {
  create(project: ManagedProject): Promise<ManagedProject>;
  load(): Promise<ManagedProjectRegistry>;
  list(): Promise<ManagedProject[]>;
  update(projectId: string, patch: Partial<ManagedProject>): Promise<ManagedProject>;
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

export const managedProjectSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  linear: z.object({
    teamKey: nonEmptyString,
    projectId: nonEmptyString.optional(),
    projectKey: nonEmptyString.optional()
  }).strict().refine((value) => value.projectId !== undefined || value.projectKey !== undefined, {
    message: 'expected projectId or projectKey'
  }),
  repo: z.object({
    path: nonEmptyString,
    remote: nonEmptyString.optional(),
    branch: nonEmptyString.optional()
  }).strict(),
  symphony: z.object({
    workspacePath: nonEmptyString,
    logsPath: nonEmptyString.optional(),
    mcpPort: port,
    runnerPort: port.optional()
  }).strict()
}).strict();

export const managedProjectRegistrySchema = z.object({
  version: z.literal(1),
  projects: z.array(managedProjectSchema)
}).strict();

export function createEmptyRegistry(): ManagedProjectRegistry {
  return { version: 1, projects: [] };
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

    async update(projectId: string, patch: Partial<ManagedProject>): Promise<ManagedProject> {
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

    validateLinear(project.linear, prefix, index, linearIdentities, issues);
    validateRepo(project.repo, prefix, index, repoPaths, issues);
    validateSymphony(project.symphony, prefix, index, workspacePaths, ports, issues);
  });
}

function validateLinear(
  value: unknown,
  prefix: string,
  projectIndex: number,
  linearIdentities: Map<string, number>,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${prefix}.linear: expected an object`);
    return;
  }

  const teamKey = readRequiredString(value.teamKey, `${prefix}.linear.teamKey`, issues);
  const projectId = readOptionalString(value.projectId, `${prefix}.linear.projectId`, issues);
  const projectKey = readOptionalString(value.projectKey, `${prefix}.linear.projectKey`, issues);

  if (teamKey !== undefined && projectId === undefined && projectKey === undefined) {
    issues.push(`${prefix}.linear: expected projectId or projectKey`);
  }

  if (teamKey !== undefined && (projectId !== undefined || projectKey !== undefined)) {
    const identity = `${teamKey}:${projectId ?? projectKey}`;
    addStringCollision(linearIdentities, identity, projectIndex, `${prefix}.linear`, 'Linear identity', issues);
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
  readOptionalString(value.remote, `${prefix}.repo.remote`, issues);
  readOptionalString(value.branch, `${prefix}.repo.branch`, issues);

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

  const workspacePath = readRequiredString(value.workspacePath, `${prefix}.symphony.workspacePath`, issues);
  readOptionalString(value.logsPath, `${prefix}.symphony.logsPath`, issues);
  const mcpPort = readRequiredPort(value.mcpPort, `${prefix}.symphony.mcpPort`, issues);
  const runnerPort = readOptionalPort(value.runnerPort, `${prefix}.symphony.runnerPort`, issues);

  if (workspacePath !== undefined) {
    addStringCollision(
      workspacePaths,
      resolve(workspacePath),
      projectIndex,
      `${prefix}.symphony.workspacePath`,
      'workspace path',
      issues
    );
  }

  if (mcpPort !== undefined) {
    addPortCollision(ports, mcpPort, `${prefix}.symphony.mcpPort`, issues);
  }

  if (runnerPort !== undefined) {
    addPortCollision(ports, runnerPort, `${prefix}.symphony.runnerPort`, issues);
  }
}

function mergeProject(existing: ManagedProject, patch: Partial<ManagedProject>): ManagedProject {
  return {
    ...existing,
    ...patch,
    linear: { ...existing.linear, ...patch.linear },
    repo: { ...existing.repo, ...patch.repo },
    symphony: { ...existing.symphony, ...patch.symphony }
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
