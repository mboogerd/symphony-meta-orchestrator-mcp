import type { RuntimeConfig } from '../config/runtime.ts';
import { packageInfo } from '../package-info.ts';

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

export function handleMcpMessage(message: unknown, runtime: RuntimeConfig): JsonRpcResponse | undefined {
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

    case 'resources/list':
      return jsonRpcResult(message.id, { resources: [] });

    case 'tools/list':
      return jsonRpcResult(message.id, { tools: [] });

    case 'shutdown':
      return jsonRpcResult(message.id, null);

    default:
      return jsonRpcError(message.id, -32601, `Method not found: ${message.method ?? '<missing>'}`);
  }
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

function readProtocolVersion(params: Record<string, unknown> | undefined): string {
  return typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
}
