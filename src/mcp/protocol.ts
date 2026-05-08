import type { RuntimeConfig } from '../config/runtime.ts';
import { packageInfo } from '../package-info.ts';
import { createLinearService, LinearServiceError } from '../services/linear/index.ts';
import { createProjectRegistryService, ProjectRegistryValidationError, type ManagedProject } from '../services/registry/index.ts';
import { createRunnerManager } from '../services/runner/index.ts';
import { validateProjectWorkflowSetups, WorkflowSetupValidationError, writeProjectWorkflow } from '../services/workflow/index.ts';

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export async function handleMcpMessage(message: unknown, runtime: RuntimeConfig): Promise<JsonRpcResponse | undefined> {
  if (!isJsonRpcRequest(message)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  if (message.id === undefined) {
    return undefined;
  }

  switch (message.method) {
    case 'initialize':
      return jsonRpcResult(message.id, {
        protocolVersion: readProtocolVersion(message.params),
        capabilities: {
          prompts: {},
          resources: {},
          tools: {}
        },
        serverInfo: {
          name: packageInfo.name,
          version: packageInfo.version
        },
        instructions: 'No-op Symphony meta-orchestrator MCP scaffold.',
        _meta: {
          configPath: runtime.configPath,
          configExists: runtime.configExists
        }
      });

    case 'ping':
      return jsonRpcResult(message.id, {});

    case 'prompts/list':
      return jsonRpcResult(message.id, { prompts: [] });

    case 'resources/list': {
      const projects = await createProjectRegistryService(runtime.configPath).list();
      return jsonRpcResult(message.id, {
        resources: projects.map((project) => ({
          uri: `symphony://projects/${project.id}`,
          name: project.name,
          description: `${project.linear.teamKey} managed project at ${project.repo.path}`,
          mimeType: 'application/yaml'
        }))
      });
    }

    case 'tools/list':
      return jsonRpcResult(message.id, {
        tools: [
          tool('list_projects', 'List managed projects from the local registry.', {}),
          tool('get_project', 'Get one managed project from the local registry.', { projectId: stringSchema() }, ['projectId']),
          tool('register_project', 'Register a managed project in the local registry.', { project: projectSchema() }, ['project']),
          tool('validate_project', 'Validate one project or all registry projects and workflow setup.', { projectId: stringSchema() }),
          tool('generate_workflow', 'Generate WORKFLOW.md for a managed project.', { projectId: stringSchema() }, ['projectId']),
          tool('create_linear_project', 'Create a Linear project.', {
            name: stringSchema(),
            teamId: stringSchema(),
            teamKey: stringSchema(),
            description: stringSchema(),
            leadId: stringSchema()
          }, ['name']),
          tool('create_issue', 'Create one Linear issue.', linearIssueSchema(), ['title']),
          tool('create_issue_batch', 'Create multiple Linear issues.', {
            issues: { type: 'array', items: { type: 'object', properties: linearIssueSchema() } }
          }, ['issues']),
          tool('link_issue_dependency', 'Link two Linear issues with a blocking dependency.', {
            blockingIssueId: stringSchema(),
            blockedIssueId: stringSchema()
          }, ['blockingIssueId', 'blockedIssueId']),
          tool('move_issue_state', 'Move a Linear issue to a workflow state.', {
            issueId: stringSchema(),
            stateNameOrId: stringSchema(),
            teamId: stringSchema()
          }, ['issueId', 'stateNameOrId']),
          tool('start_runner', 'Start the Symphony runner for a managed project.', { projectId: stringSchema() }, ['projectId']),
          tool('stop_runner', 'Stop the Symphony runner for a managed project.', { projectId: stringSchema() }, ['projectId']),
          tool('restart_runner', 'Restart the Symphony runner for a managed project.', { projectId: stringSchema() }, ['projectId']),
          tool('get_runner_status', 'Inspect the Symphony runner for a managed project.', { projectId: stringSchema() }, ['projectId']),
          tool('tail_runner_logs', 'Read recent runner log lines for a managed project.', {
            projectId: stringSchema(),
            lineCount: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
          }, ['projectId'])
        ]
      });

    case 'tools/call':
      return handleToolCall(message, runtime);

    case 'shutdown':
      return jsonRpcResult(message.id, null);

    default:
      return jsonRpcError(message.id, -32601, `Method not found: ${message.method ?? '<missing>'}`);
  }
}

async function handleToolCall(message: JsonRpcRequest, runtime: RuntimeConfig): Promise<JsonRpcResponse> {
  const name = typeof message.params?.name === 'string' ? message.params.name : undefined;
  const argumentsValue = isRecord(message.params?.arguments) ? message.params.arguments : {};

  try {
    const registry = createProjectRegistryService(runtime.configPath);

    if (name === 'list_projects') {
      return toolResult(message.id ?? null, { projects: await registry.list() });
    }

    if (name === 'get_project') {
      return toolResult(message.id ?? null, { project: await requireProject(runtime, argumentsValue.projectId) });
    }

    if (name === 'register_project') {
      const project = readProject(argumentsValue.project);
      return toolResult(message.id ?? null, { project: await registry.create(project) });
    }

    if (name === 'validate_project') {
      const projects = await selectedProjects(runtime, argumentsValue.projectId);
      if (projects.length === 0) {
        return toolError(message.id ?? null, 'project_not_found', 'Project was not found', { projectId: argumentsValue.projectId });
      }
      const setup = await validateProjectWorkflowSetups(projects);
      return toolResult(message.id ?? null, { setup }, setup.some((validation) => !validation.ok));
    }

    if (name === 'generate_workflow') {
      return toolResult(message.id ?? null, { workflow: await writeProjectWorkflow(await requireProject(runtime, argumentsValue.projectId)) });
    }

    if (name === 'create_linear_project') {
      return toolResult(message.id ?? null, { project: await linear(runtime).createProject(argumentsValue as never) });
    }

    if (name === 'create_issue') {
      return toolResult(message.id ?? null, { issue: await linear(runtime).createIssue(argumentsValue as never) });
    }

    if (name === 'create_issue_batch') {
      return toolResult(message.id ?? null, { issues: await linear(runtime).createIssueBatch(argumentsValue as never) });
    }

    if (name === 'link_issue_dependency') {
      return toolResult(message.id ?? null, { dependency: await linear(runtime).createDependency(argumentsValue as never) });
    }

    if (name === 'move_issue_state') {
      return toolResult(message.id ?? null, {
        issue: await linear(runtime).moveIssueToState(
          requiredString(argumentsValue.issueId, 'issueId'),
          requiredString(argumentsValue.stateNameOrId, 'stateNameOrId'),
          optionalString(argumentsValue.teamId)
        )
      });
    }

    if (name === 'start_runner' || name === 'stop_runner' || name === 'restart_runner' || name === 'get_runner_status' || name === 'tail_runner_logs') {
      const project = await requireProject(runtime, argumentsValue.projectId);
      const manager = createRunnerManager();
      const runner = name === 'start_runner'
        ? await manager.start(project)
        : name === 'stop_runner'
          ? await manager.stop(project)
          : name === 'restart_runner'
            ? await manager.restart(project)
            : name === 'tail_runner_logs'
              ? await manager.tailLogs(project, typeof argumentsValue.lineCount === 'number' ? argumentsValue.lineCount : undefined)
              : await manager.status(project);
      return toolResult(message.id ?? null, { runner });
    }

    return jsonRpcError(message.id ?? null, -32602, `Unknown tool: ${name ?? '<missing>'}`);
  } catch (error) {
    return toolError(message.id ?? null, errorCode(error), error instanceof Error ? error.message : String(error), errorDetails(error));
  }
}

async function selectedProjects(runtime: RuntimeConfig, projectId: unknown) {
  const projects = await createProjectRegistryService(runtime.configPath).list();

  if (typeof projectId !== 'string') {
    return projects;
  }

  return projects.filter((project) => project.id === projectId);
}

async function requireProject(runtime: RuntimeConfig, projectId: unknown): Promise<ManagedProject> {
  const projects = await selectedProjects(runtime, projectId);
  if (typeof projectId !== 'string' || projects.length === 0) {
    throw new McpToolError('project_not_found', 'Project was not found', { projectId });
  }
  return projects[0];
}

function linear(runtime: RuntimeConfig) {
  return createLinearService({ apiKey: runtime.env.LINEAR_API_KEY });
}

function toolResult(id: string | number | null, payload: Record<string, unknown>, isError = false): JsonRpcResponse {
  const status = isError ? 'invalid' : 'ok';
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify({ status, ...payload }, null, 2) }],
    structuredContent: { status, ...payload },
    isError
  });
}

function toolError(id: string | number | null, code: string, message: string, details: Record<string, unknown> = {}): JsonRpcResponse {
  const error = { code, message, details };
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify({ status: 'error', error }, null, 2) }],
    structuredContent: { status: 'error', error },
    isError: true
  });
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

function readProject(value: unknown): ManagedProject {
  if (!isRecord(value)) {
    throw new McpToolError('invalid_input', 'project must be an object');
  }
  return value as ManagedProject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpToolError('invalid_input', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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
    return { issues: error.issues };
  }
  if (error instanceof WorkflowSetupValidationError) {
    return { setup: error.validations };
  }
  return {};
}

export function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  if (message === null || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readProtocolVersion(params: Record<string, unknown> | undefined): string {
  return typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}

function stringSchema() {
  return { type: 'string' };
}

function linearIssueSchema(): Record<string, unknown> {
  return {
    title: stringSchema(),
    teamId: stringSchema(),
    teamKey: stringSchema(),
    description: stringSchema(),
    projectId: stringSchema(),
    stateId: stringSchema(),
    stateName: stringSchema(),
    assigneeId: stringSchema(),
    priority: { type: 'integer', minimum: 0, maximum: 4 }
  };
}

function projectSchema() {
  return {
    type: 'object',
    properties: {
      id: stringSchema(),
      name: stringSchema(),
      linear: {
        type: 'object',
        properties: {
          teamKey: stringSchema(),
          projectId: stringSchema(),
          projectKey: stringSchema()
        },
        required: ['teamKey']
      },
      repo: {
        type: 'object',
        properties: {
          path: stringSchema(),
          remote: stringSchema(),
          branch: stringSchema()
        },
        required: ['path']
      },
      symphony: {
        type: 'object',
        properties: {
          workspacePath: stringSchema(),
          logsPath: stringSchema(),
          mcpPort: { type: 'integer', minimum: 1, maximum: 65535 },
          runnerPort: { type: 'integer', minimum: 1, maximum: 65535 }
        },
        required: ['workspacePath', 'mcpPort']
      }
    },
    required: ['id', 'name', 'linear', 'repo', 'symphony']
  };
}
