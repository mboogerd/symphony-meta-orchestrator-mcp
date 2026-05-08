import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeConfig, handleMcpMessage } from '../src/index.ts';

test('MCP initialize returns no-op server capabilities', () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });
  const response = handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' }
  }, runtime);

  assert.equal(response?.jsonrpc, '2.0');
  assert.equal(response?.id, 1);
  assert.deepEqual((response?.result as Record<string, unknown>).capabilities, {
    prompts: {},
    resources: {},
    tools: {}
  });
});

test('MCP list methods are present and empty', () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });

  assert.deepEqual(handleMcpMessage({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, runtime), {
    jsonrpc: '2.0',
    id: 'tools',
    result: { tools: [] }
  });
});
