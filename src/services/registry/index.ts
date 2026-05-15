import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export type ManagedProjectRegistry = {
  version: 3;
  projects: ManagedProject[];
};

export type ManagedProject = {
  id: string;
  name: string;
  enabled?: boolean;
  githubUrl: string;
  tracker?: TrackerConfig;
  workflow: WorkflowConfig;
  codex: CodexPolicyConfig;
};

export type TrackerConfig = {
  kind: 'linear';
  teamKey: string;
  teamId: string;
  projectId: string;
  projectSlug: string;
};

export type WorkflowConfig =
  | ({
      source: 'repo';
      path: string;
    } & WorkflowRuntimeConfig)
  | ({
      source: 'generated';
      template: string;
    } & WorkflowRuntimeConfig);

export type WorkflowRuntimeConfig = {
  runtime?: {
    tracker?: {
      activeStates?: string[];
      terminalStates?: string[];
    };
    agent?: {
      maxConcurrentAgents?: number;
      maxTurns?: number;
    };
    codex?: {
      command?: string;
      approvalPolicy?: string;
    };
    hooks?: {
      afterCreate?: WorkflowAfterCreateHookConfig;
      beforeRemove?: string;
    };
  };
};

export type WorkflowAfterCreateHookConfig =
  | {
      type: 'gitClone';
      cloneSource?: string;
      target?: string;
    }
  | {
      type: 'none';
    };

export type CodexThreadSandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexTurnSandboxPolicy =
  | { type: 'readOnly'; networkAccess?: boolean }
  | { type: 'workspaceWrite'; networkAccess?: boolean; writableRoots?: string[]; excludeSlashTmp?: boolean; excludeTmpdirEnvVar?: boolean }
  | { type: 'dangerFullAccess' }
  | { type: 'externalSandbox'; networkAccess?: 'restricted' | 'enabled' };
export type LegacyCodexSandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexPolicyConfig = {
  threadSandbox: CodexThreadSandboxPolicy;
  turnSandbox: CodexTurnSandboxPolicy;
};

export type ProjectRegistry = ManagedProjectRegistry;
export type RegistryProject = ManagedProject;
export type ManagedProjectPatch = Partial<Omit<ManagedProject, 'workflow' | 'codex'>> & {
  workflow?: Partial<WorkflowConfig>;
  codex?: Partial<CodexPolicyConfig>;
  tracker?: Partial<TrackerConfig>;
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
const legacySandboxPolicy = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
const threadSandboxPolicy = legacySandboxPolicy;
const positiveInteger = z.number().int().min(1);
const stringList = z.array(nonEmptyString).min(1);
const turnSandboxPolicy = z.preprocess(normalizeCodexTurnSandboxPolicy, z.discriminatedUnion('type', [
  z.object({
    type: z.literal('readOnly'),
    networkAccess: z.boolean().optional()
  }).strict(),
  z.object({
    type: z.literal('workspaceWrite'),
    networkAccess: z.boolean().optional(),
    writableRoots: z.array(nonEmptyString).optional(),
    excludeSlashTmp: z.boolean().optional(),
    excludeTmpdirEnvVar: z.boolean().optional()
  }).strict(),
  z.object({
    type: z.literal('dangerFullAccess')
  }).strict(),
  z.object({
    type: z.literal('externalSandbox'),
    networkAccess: z.enum(['restricted', 'enabled']).optional()
  }).strict()
]));

const workflowRuntimeSchema = z.object({
  runtime: z.object({
    tracker: z.object({
      activeStates: stringList.optional(),
      terminalStates: stringList.optional()
    }).strict().optional(),
    agent: z.object({
      maxConcurrentAgents: positiveInteger.optional(),
      maxTurns: positiveInteger.optional()
    }).strict().optional(),
    codex: z.object({
      command: nonEmptyString.optional(),
      approvalPolicy: nonEmptyString.optional()
    }).strict().optional(),
    hooks: z.object({
      afterCreate: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('gitClone'),
          cloneSource: nonEmptyString.optional(),
          target: nonEmptyString.optional()
        }).strict(),
        z.object({
          type: z.literal('none')
        }).strict()
      ]).optional(),
      beforeRemove: nonEmptyString.optional()
    }).strict().optional()
  }).strict().optional()
});

export const managedProjectSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  enabled: z.boolean().optional(),
  githubUrl: nonEmptyString,
  tracker: z.object({
    kind: z.literal('linear'),
    teamKey: nonEmptyString,
    teamId: nonEmptyString,
    projectId: nonEmptyString,
    projectSlug: nonEmptyString
  }).strict().optional(),
  workflow: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('repo'),
      path: nonEmptyString
    }).merge(workflowRuntimeSchema).strict(),
    z.object({
      source: z.literal('generated'),
      template: nonEmptyString
    }).merge(workflowRuntimeSchema).strict()
  ]),
  codex: z.object({
    threadSandbox: threadSandboxPolicy,
    turnSandbox: turnSandboxPolicy
  }).strict()
}).strict();

export const managedProjectRegistrySchema = z.object({
  version: z.literal(3),
  projects: z.array(managedProjectSchema)
}).strict();

export function createEmptyRegistry(): ManagedProjectRegistry {
  return { version: 3, projects: [] };
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
  const registry = normalizeRegistry(parsed, dirname(resolve(configPath)));
  validateProjectRegistry(registry);
  return registry;
}

export async function saveRegistry(configPath: string, registry: ManagedProjectRegistry): Promise<void> {
  validateProjectRegistry(registry);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(registryForYaml(registry), { collectionStyle: 'block' }), 'utf8');
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

function normalizeRegistry(value: unknown, registryDir?: string): ManagedProjectRegistry {
  if (value === null || value === undefined) {
    return createEmptyRegistry();
  }

  if (!isRecord(value)) {
    throw new ProjectRegistryValidationError(['registry: expected an object']);
  }

  if (value.version === 2) {
    throw new ProjectRegistryValidationError([
      'registry.version: version 2 registries must be migrated to version 3; replace repo/tracker/symphony fields with githubUrl'
    ]);
  }

  return {
    version: value.version,
    projects: Array.isArray(value.projects) ? value.projects.map((project) => normalizeProject(project, registryDir)) : value.projects
  } as ManagedProjectRegistry;
}

function normalizeProject(value: unknown, registryDir?: string): unknown {
  if (!isRecord(value) || !isRecord(value.codex)) {
    return value;
  }

  const project = {
    ...value,
    codex: {
      ...value.codex,
      turnSandbox: normalizeCodexTurnSandboxPolicy(value.codex.turnSandbox)
    }
  };

  if (registryDir !== undefined && !('symphony' in project) && typeof project.id === 'string') {
    attachRuntimeHints(project, registryDir);
  }

  return project;
}

function attachRuntimeHints(project: Record<string, unknown>, registryDir: string): void {
  const workspaceRoot = join(registryDir, 'workspace');
  const logsRoot = join(registryDir, 'logs');
  const repoPath = join(registryDir, 'repo');
  const command = process.env.SYMPHONY_RUNNER_COMMAND?.trim();

  const runtimeHints: PropertyDescriptorMap = {
    repo: {
      enumerable: false,
      value: {
        path: existsSync(repoPath) ? repoPath : workspaceRoot,
        remoteUrl: project.githubUrl,
        defaultBranch: 'main',
        cloneSource: project.githubUrl
      }
    },
    symphony: {
      enumerable: false,
      value: {
        ...(command === undefined || command.length === 0 ? {} : { command }),
        workspaceRoot,
        logsRoot
      }
    }
  };

  Object.defineProperties(project, runtimeHints);
}

export function normalizeCodexTurnSandboxPolicy(value: unknown): unknown {
  if (value === 'read-only') {
    return { type: 'readOnly' };
  }

  if (value === 'workspace-write') {
    return { type: 'workspaceWrite' };
  }

  if (value === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  return value;
}

function validateProjects(projects: unknown[], issues: string[]): void {
  const projectIds = new Map<string, number>();
  const githubUrls = new Map<string, number>();

  projects.forEach((project, index) => {
    const prefix = `projects[${index}]`;

    if (!isRecord(project)) {
      issues.push(`${prefix}: expected an object`);
      return;
    }

    const id = readRequiredString(project.id, `${prefix}.id`, issues);
    readRequiredString(project.name, `${prefix}.name`, issues);
    const githubUrl = readRequiredString(project.githubUrl, `${prefix}.githubUrl`, issues);

    if (id !== undefined) {
      addStringCollision(projectIds, id, index, `${prefix}.id`, 'project id', issues);
    }

    if (githubUrl !== undefined) {
      addStringCollision(githubUrls, githubUrl, index, `${prefix}.githubUrl`, 'githubUrl', issues);
    }
  });
}

function mergeProject(existing: ManagedProject, patch: ManagedProjectPatch): ManagedProject {
  const merged = {
    ...existing,
    ...patch,
    tracker: patch.tracker === undefined ? existing.tracker : mergeTracker(existing, patch.tracker),
    workflow: { ...existing.workflow, ...patch.workflow } as WorkflowConfig,
    codex: { ...existing.codex, ...patch.codex }
  };
  copyNonEnumerableProjectProperties(existing, merged);
  return omitDefaultEnabled(merged);
}

function mergeTracker(existing: ManagedProject, patch: Partial<TrackerConfig>): TrackerConfig {
  return {
    kind: 'linear',
    teamKey: 'MRB',
    teamId: 'linear-team-id',
    projectId: existing.id,
    projectSlug: existing.id,
    ...existing.tracker,
    ...patch
  };
}

function registryForYaml(registry: ManagedProjectRegistry): ManagedProjectRegistry {
  return {
    ...registry,
    projects: registry.projects.map(omitDefaultEnabled)
  };
}

function omitDefaultEnabled(project: ManagedProject): ManagedProject {
  if (project.enabled !== true && project.enabled !== undefined) {
    return project;
  }

  const { enabled: _enabled, ...rest } = project;
  copyNonEnumerableProjectProperties(project, rest);
  return rest;
}

function copyNonEnumerableProjectProperties(source: ManagedProject, target: ManagedProject): void {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!descriptor.enumerable && !(key in target)) {
      Object.defineProperty(target, key, descriptor);
    }
  }
}

function readRequiredString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path}: expected a non-empty string`);
    return undefined;
  }

  return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
