import type { RuntimeConfig } from '../config/runtime.ts';
import { packageInfo } from '../package-info.ts';
import { createProjectRegistryService } from '../services/registry/index.ts';
import { createRunnerManager } from '../services/runner/index.ts';
import { validateProjectWorkflowSetups, writeProjectWorkflow } from '../services/workflow/index.ts';

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
          {
            name: 'projects_validate_setup',
            description: 'Validate registry projects and generated Symphony workflow setup.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          },
          {
            name: 'workflows_render',
            description: 'Render WORKFLOW.md for a managed project after setup validation.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          },
          {
            name: 'runners_start',
            description: 'Start the Symphony runner for a managed project.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          },
          {
            name: 'runners_stop',
            description: 'Stop the Symphony runner for a managed project.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          },
          {
            name: 'runners_restart',
            description: 'Restart the Symphony runner for a managed project.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          },
          {
            name: 'runners_status',
            description: 'Inspect the Symphony runner for a managed project.',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'string' }
              }
            }
          }
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

  if (name === 'projects_validate_setup') {
    const projects = await selectedProjects(runtime, argumentsValue.projectId);
    if (projects.length === 0) {
      return jsonRpcResult(message.id ?? null, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'invalid', error: 'Project not found' }, null, 2) }],
        isError: true
      });
    }
    const setup = await validateProjectWorkflowSetups(projects);
    return jsonRpcResult(message.id ?? null, {
      content: [{ type: 'text', text: JSON.stringify({ status: setup.every((validation) => validation.ok) ? 'ok' : 'invalid', setup }, null, 2) }],
      isError: setup.some((validation) => !validation.ok)
    });
  }

  if (name === 'workflows_render') {
    const projects = await selectedProjects(runtime, argumentsValue.projectId);
    if (projects.length === 0) {
      return jsonRpcResult(message.id ?? null, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'invalid', error: 'Project not found' }, null, 2) }],
        isError: true
      });
    }
    const workflow = await writeProjectWorkflow(projects[0]);
    return jsonRpcResult(message.id ?? null, {
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok', workflow }, null, 2) }],
      isError: false
    });
  }

  if (name === 'runners_start' || name === 'runners_stop' || name === 'runners_restart' || name === 'runners_status') {
    const projects = await selectedProjects(runtime, argumentsValue.projectId);
    if (projects.length === 0) {
      return jsonRpcResult(message.id ?? null, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'invalid', error: 'Project not found' }, null, 2) }],
        isError: true
      });
    }

    const manager = createRunnerManager();
    const runner = name === 'runners_start'
      ? await manager.start(projects[0])
      : name === 'runners_stop'
        ? await manager.stop(projects[0])
        : name === 'runners_restart'
          ? await manager.restart(projects[0])
          : await manager.status(projects[0]);
    return jsonRpcResult(message.id ?? null, {
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok', runner }, null, 2) }],
      isError: false
    });
  }

  return jsonRpcError(message.id ?? null, -32602, `Unknown tool: ${name ?? '<missing>'}`);
}

async function selectedProjects(runtime: RuntimeConfig, projectId: unknown) {
  const projects = await createProjectRegistryService(runtime.configPath).list();

  if (typeof projectId !== 'string') {
    return projects;
  }

  return projects.filter((project) => project.id === projectId);
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
