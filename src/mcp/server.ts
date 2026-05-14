import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RuntimeConfig } from '../config/runtime.ts';
import { packageInfo } from '../package-info.ts';
import { createLinearService, LinearServiceError, type LinearService } from '../services/linear/index.ts';
import {
  createProjectRegistryService,
  managedProjectSchema,
  type ManagedProject,
  ProjectRegistryValidationError
} from '../services/registry/index.ts';
import { projectSchemaErrorDetails, projectSchemaHelp } from '../services/registry/schema-help.ts';
import { setupManagedProject, type RunnerBootstrapper } from '../services/onboarding/index.ts';
import { createRunnerManager, type RunnerManager } from '../services/runner/index.ts';
import {
  type PortAvailabilityProbe,
  validateProjectWorkflowSetups,
  type WorkflowSetupValidationPhase,
  WorkflowSetupValidationError,
  writeProjectWorkflow
} from '../services/workflow/index.ts';
import { setupProjectDescription } from './tool-descriptions.ts';

const optionalString = z.string().trim().min(1).optional();
const requiredString = z.string().trim().min(1);
const runnerPort = z.number().int().min(1).max(65535);
const linearIssueSchema = {
  title: requiredString,
  teamId: optionalString,
  teamKey: optionalString,
  description: optionalString,
  projectId: optionalString,
  stateId: optionalString,
  stateName: optionalString,
  assigneeId: optionalString,
  priority: z.number().int().min(0).max(4).optional(),
  labelIds: z.array(requiredString).optional()
};
const projectIssueSchema = {
  title: requiredString,
  description: optionalString,
  stateId: optionalString,
  stateName: optionalString,
  assigneeId: optionalString,
  priority: z.number().int().min(0).max(4).optional(),
  labelIds: z.array(requiredString).optional()
};

export type McpServerServices = {
  createLinearService?: (runtime: McpServerRuntimeConfig) => LinearService;
  createRunnerManager?: (runtime: McpServerRuntimeConfig) => RunnerManager;
  runnerBootstrap?: RunnerBootstrapper;
  portAvailable?: PortAvailabilityProbe;
};

export type McpServerRuntimeConfig = RuntimeConfig & {
  mcpServices?: McpServerServices;
};

export function createMcpServer(runtime: McpServerRuntimeConfig): McpServer {
  const server = new McpServer({
    name: packageInfo.name,
    version: packageInfo.version
  }, {
    capabilities: {
      prompts: {},
      resources: {},
      tools: {}
    },
    instructions: 'Symphony meta-orchestrator control-plane MCP server.'
  });

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const projects = await createProjectRegistryService(runtime.configPath).list();
    return {
      resources: projects.map((project) => ({
        uri: `symphony://projects/${project.id}`,
        name: project.name,
        description: `${project.tracker.teamKey} managed project at ${project.repo.path}`,
        mimeType: 'application/yaml'
      }))
    };
  });

  registerTools(server, runtime);
  return server;
}

function registerTools(server: McpServer, runtime: McpServerRuntimeConfig): void {
  server.registerTool('list_projects', {
    description: 'List managed projects from the local registry.'
  }, async () => withToolErrors(async () => toolResult({ projects: await registry(runtime).list() })));

  server.registerTool('get_project', {
    description: 'Get one managed project from the local registry.',
    inputSchema: { projectId: requiredString }
  }, async ({ projectId }) => withToolErrors(async () => toolResult({ project: await requireProject(runtime, projectId) })));

  server.registerTool('register_project', {
    description: 'Register a complete managed project object in the local registry. If you need the required shape, call describe_project_schema first; for guided defaults, prefer setup_project.',
    inputSchema: { project: managedProjectSchema }
  }, async ({ project }) => withToolErrors(async () => toolResult({ project: await registry(runtime).create(project) })));

  server.registerTool('describe_project_schema', {
    description: 'Return guidance and an annotated example object for register_project.'
  }, async () => withToolErrors(async () => toolResult(projectSchemaHelp())));

  server.registerTool('validate_project', {
    description: 'Validate one project or all registry projects and workflow setup.',
    inputSchema: {
      projectId: optionalString,
      phase: z.enum(['schema', 'render', 'workspace', 'live']).optional(),
      live: z.boolean().optional(),
      validateLinear: z.boolean().optional()
    }
  }, async ({ projectId, phase, live, validateLinear }) => {
    const loadedRegistry = await registry(runtime).load();
    const projects = projectId === undefined ? loadedRegistry.projects : loadedRegistry.projects.filter((candidate) => candidate.id === projectId);
    if (projects.length === 0) {
      return toolError('project_not_found', 'Project was not found', { projectId });
    }
    const setup = await validateProjectWorkflowSetups(projects, {
      registry: loadedRegistry,
      phase: live ? 'live' : readValidationPhase(phase),
      validateLinear,
      env: runtime.env,
      portAvailable: runtime.mcpServices?.portAvailable
    });
    return toolResult({ setup }, setup.some((validation) => !validation.ok));
  });

  server.registerTool('generate_workflow', {
    description: 'Generate WORKFLOW.md for a managed project.',
    inputSchema: { projectId: requiredString }
  }, async ({ projectId }) => withToolErrors(async () => toolResult({ workflow: await writeProjectWorkflow(await requireProject(runtime, projectId)) })));

  server.registerTool('create_linear_project', {
    description: 'Create a Linear project.',
    inputSchema: {
      name: requiredString,
      teamId: optionalString,
      teamKey: optionalString,
      description: optionalString,
      leadId: optionalString
    }
  }, async (args) => withToolErrors(async () => toolResult({ project: await linear(runtime).createProject(args) })));

  server.registerTool('list_teams', {
    description: 'List Linear teams accessible to the configured API key.'
  }, async () => withToolErrors(async () => toolResult({ teams: await linear(runtime).listTeams() })));

  server.registerTool('find_linear_project', {
    description: 'Find existing Linear projects by name substring and/or slug ID. Pass teamKey to return only active projects that setup_project can attach to for that team.',
    inputSchema: {
      name: optionalString,
      slugId: optionalString,
      teamKey: optionalString
    }
  }, async (args) => withToolErrors(async () => toolResult({ projects: await linear(runtime).findProjects(args) })));

  server.registerTool('setup_project', {
    description: setupProjectDescription,
    inputSchema: {
      name: requiredString,
      teamKey: requiredString,
      repoPath: requiredString,
      runnerPort,
      workspaceRoot: requiredString,
      logsRoot: requiredString,
      remoteUrl: optionalString,
      cloneSource: optionalString,
      runnerCommand: optionalString,
      runnerArgs: z.array(requiredString).optional(),
      runnerCwd: optionalString,
      linearProjectId: optionalString,
      startRunner: z.boolean().optional()
    }
  }, async (args) => withToolErrors(async () => {
    const setup = await setupManagedProject(args, {
      linear: linear(runtime),
      registry: registry(runtime),
      runnerManager: runnerManager(runtime),
      runnerBootstrap: runtime.mcpServices?.runnerBootstrap
    });
    return toolResult({ setup }, setup.steps.some((step) => step.status === 'error'));
  }));

  server.registerTool('create_issue', {
    description: 'Create one Linear issue.',
    inputSchema: linearIssueSchema
  }, async (args) => withToolErrors(async () => toolResult({ issue: await linear(runtime).createIssue(args) })));

  server.registerTool('create_issue_batch', {
    description: 'Create multiple Linear issues.',
    inputSchema: { issues: z.array(z.object(linearIssueSchema).strict()) }
  }, async ({ issues }) => withToolErrors(async () => toolResult({ issues: await linear(runtime).createIssueBatch({ issues }) })));

  server.registerTool('link_issue_dependency', {
    description: 'Link two Linear issues with a blocking dependency.',
    inputSchema: { blockingIssueId: requiredString, blockedIssueId: requiredString }
  }, async (args) => withToolErrors(async () => toolResult({ dependency: await linear(runtime).createDependency(args) })));

  server.registerTool('move_issue_state', {
    description: 'Move a Linear issue to a workflow state.',
    inputSchema: { issueId: requiredString, stateNameOrId: requiredString, teamId: optionalString }
  }, async ({ issueId, stateNameOrId, teamId }) => withToolErrors(async () => toolResult({
    issue: await linear(runtime).moveIssueToState(issueId, stateNameOrId, teamId)
  })));

  server.registerTool('create_project_issue', {
    description: 'Create one issue in a managed Linear project using registry defaults.',
    inputSchema: { projectId: requiredString, ...projectIssueSchema }
  }, async ({ projectId, ...issue }) => withToolErrors(async () => toolResult({
    issue: await linear(runtime).createProjectIssue(await requireProject(runtime, projectId), issue)
  })));

  server.registerTool('create_planned_issue_batch', {
    description: 'Create multiple planned issues in a managed Linear project and link dependencies by stable client keys.',
    inputSchema: {
      projectId: requiredString,
      issues: z.array(z.object({ key: requiredString, ...projectIssueSchema }).strict()),
      dependencies: z.array(z.object({ from: requiredString, blocks: requiredString }).strict()).optional()
    }
  }, async ({ projectId, issues, dependencies }) => withToolErrors(async () => toolResult({
    batch: await linear(runtime).createPlannedIssueBatch(await requireProject(runtime, projectId), { issues, dependencies })
  })));

  server.registerTool('create_linear_project_planned_issue_batch', {
    description: 'Create multiple planned issues in a Linear project by raw team/project IDs and link dependencies by stable client keys.',
    inputSchema: {
      teamId: optionalString,
      teamKey: optionalString,
      linearProjectId: requiredString,
      issues: z.array(z.object({ key: requiredString, ...projectIssueSchema }).strict()),
      dependencies: z.array(z.object({ from: requiredString, blocks: requiredString }).strict()).optional()
    }
  }, async ({ teamId, teamKey, linearProjectId, issues, dependencies }) => withToolErrors(async () => toolResult({
    batch: await linear(runtime).createLinearProjectPlannedIssueBatch({ teamId, teamKey, linearProjectId, issues, dependencies })
  })));

  server.registerTool('promote_ready_issue', {
    description: 'Explicitly move a managed-project issue from Backlog to Todo.',
    inputSchema: { projectId: requiredString, issueId: requiredString }
  }, async ({ projectId, issueId }) => withToolErrors(async () => toolResult({
    issue: await linear(runtime).promoteReadyIssue(await requireProject(runtime, projectId), issueId)
  })));

  server.registerTool('link_project_issue_dependency', {
    description: 'Link two issues in a managed Linear project with a blocking dependency.',
    inputSchema: { projectId: requiredString, blockingIssueId: requiredString, blockedIssueId: requiredString }
  }, async ({ projectId, blockingIssueId, blockedIssueId }) => withToolErrors(async () => toolResult({
    dependency: await linear(runtime).linkProjectIssueDependency(await requireProject(runtime, projectId), { blockingIssueId, blockedIssueId })
  })));

  for (const name of ['start_runner', 'stop_runner', 'restart_runner', 'get_runner_status'] as const) {
    server.registerTool(name, {
      description: `${name.replaceAll('_', ' ')} for a managed project.`,
      inputSchema: { projectId: requiredString }
    }, async ({ projectId }) => withToolErrors(async () => {
      const project = await requireProject(runtime, projectId);
      const manager = runnerManager(runtime);
      const runner = name === 'start_runner'
        ? await manager.start(project)
        : name === 'stop_runner'
          ? await manager.stop(project)
          : name === 'restart_runner'
            ? await manager.restart(project)
            : await manager.status(project);
      return toolResult({ runner });
    }));
  }

  server.registerTool('tail_runner_logs', {
    description: 'Read recent runner log lines for a managed project.',
    inputSchema: {
      projectId: requiredString,
      lineCount: z.number().int().min(1).max(1000).optional()
    }
  }, async ({ projectId, lineCount }) => withToolErrors(async () => {
    const project = await requireProject(runtime, projectId);
    return toolResult({ runner: await runnerManager(runtime).tailLogs(project, lineCount) });
  }));
}

function readValidationPhase(phase: string | undefined): WorkflowSetupValidationPhase {
  return phase === 'schema' || phase === 'render' || phase === 'workspace' || phase === 'live' ? phase : 'workspace';
}

async function withToolErrors(callback: () => Promise<ReturnType<typeof toolResult>>) {
  try {
    return await callback();
  } catch (error) {
    return toolError(errorCode(error), error instanceof Error ? error.message : String(error), errorDetails(error));
  }
}

function toolResult(payload: Record<string, unknown>, isError = false) {
  const status = isError ? 'invalid' : 'ok';
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status, ...payload }, null, 2) }],
    structuredContent: { status, ...payload },
    isError
  };
}

function toolError(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, details };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error }, null, 2) }],
    structuredContent: { status: 'error', error },
    isError: true
  };
}

function registry(runtime: RuntimeConfig) {
  return createProjectRegistryService(runtime.configPath);
}

async function selectedProjects(runtime: RuntimeConfig, projectId: string | undefined) {
  const projects = await registry(runtime).list();
  return projectId === undefined ? projects : projects.filter((project) => project.id === projectId);
}

async function requireProject(runtime: RuntimeConfig, projectId: string): Promise<ManagedProject> {
  const [project] = await selectedProjects(runtime, projectId);
  if (project === undefined) {
    throw new McpToolError('project_not_found', 'Project was not found', { projectId });
  }
  return project;
}

function linear(runtime: McpServerRuntimeConfig) {
  return runtime.mcpServices?.createLinearService?.(runtime) ?? createLinearService({ apiKey: runtime.env.LINEAR_API_KEY });
}

function runnerManager(runtime: McpServerRuntimeConfig) {
  return runtime.mcpServices?.createRunnerManager?.(runtime) ?? createRunnerManager();
}

function errorCode(error: unknown): string {
  if (error instanceof McpToolError || error instanceof LinearServiceError) {
    return error.code;
  }
  if (error instanceof ProjectRegistryValidationError) {
    return 'invalid_registry';
  }
  if (error instanceof WorkflowSetupValidationError) {
    return 'invalid_workflow_setup';
  }
  return 'tool_failed';
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof McpToolError || error instanceof LinearServiceError) {
    return error.details;
  }
  if (error instanceof ProjectRegistryValidationError) {
    return projectSchemaErrorDetails(error.issues);
  }
  if (error instanceof WorkflowSetupValidationError) {
    return { setup: error.validations };
  }
  return {};
}

class McpToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.details = details;
  }
}
