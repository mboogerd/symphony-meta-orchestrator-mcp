import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeConfig, handleMcpMessage } from '../src/index.ts';

test('MCP initialize returns no-op server capabilities', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });
  const response = await handleMcpMessage({
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

test('MCP tools/list exposes workflow setup tools', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });

  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, runtime);

  assert.equal(response?.jsonrpc, '2.0');
  const tools = ((response?.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
  assert.deepEqual(tools.map((tool) => tool.name), ['projects_validate_setup', 'workflows_render']);
});

test('MCP resources/list exposes managed projects from YAML registry', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb8-mcp-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, [
      'version: 1',
      'projects:',
      '  - id: meta-orchestrator',
      '    name: Meta Orchestrator',
      '    linear:',
      '      teamKey: MRB',
      '      projectKey: META',
      '    repo:',
      '      path: /tmp/meta-orchestrator',
      '    symphony:',
      '      workspacePath: /tmp/workspaces/meta-orchestrator',
      '      mcpPort: 4100'
    ].join('\n'));

    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 'resources', method: 'resources/list' }, runtime);

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 'resources',
      result: {
        resources: [{
          uri: 'symphony://projects/meta-orchestrator',
          name: 'Meta Orchestrator',
          description: 'MRB managed project at /tmp/meta-orchestrator',
          mimeType: 'application/yaml'
        }]
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP projects_validate_setup returns structured invalid setup output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-mcp-invalid-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, [
      'version: 1',
      'projects:',
      '  - id: meta-orchestrator',
      '    name: Meta Orchestrator',
      '    linear:',
      '      teamKey: MRB',
      '      projectKey: META',
      '    repo:',
      `      path: ${join(cwd, 'missing-repo')}`,
      '    symphony:',
      `      workspacePath: ${join(cwd, 'workspace')}`,
      '      mcpPort: 4100'
    ].join('\n'));

    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'projects_validate_setup', arguments: { projectId: 'meta-orchestrator' } }
    }, runtime);

    const result = response?.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const text = ((result.content as Array<Record<string, string>>)[0]).text;
    const output = JSON.parse(text);
    assert.equal(output.status, 'invalid');
    assert.equal(output.setup[0].issues[0].code, 'repo_path_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
