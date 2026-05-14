import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeConfig, handleMcpMessage } from '../src/index.ts';
import { createLinearService, type LinearSdkClient } from '../src/services/linear/index.ts';
import { managedProject, managedProjectYaml } from './project-fixtures.ts';

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

test('MCP tools/list exposes control-plane tools', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });

  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, runtime);

  assert.equal(response?.jsonrpc, '2.0');
  const tools = ((response?.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_projects',
    'get_project',
    'register_project',
    'describe_project_schema',
    'validate_project',
    'generate_workflow',
    'create_linear_project',
    'list_teams',
    'find_linear_project',
    'setup_project',
    'create_issue',
    'create_issue_batch',
    'link_issue_dependency',
    'move_issue_state',
    'create_project_issue',
    'create_planned_issue_batch',
    'promote_ready_issue',
    'link_project_issue_dependency',
    'start_runner',
    'stop_runner',
    'restart_runner',
    'get_runner_status',
    'tail_runner_logs'
  ]);
});

test('MCP describe_project_schema returns register_project guidance and template', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });

  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'schema',
    method: 'tools/call',
    params: { name: 'describe_project_schema', arguments: {} }
  }, runtime);

  const structured = ((response?.result as Record<string, unknown>).structuredContent as Record<string, any>);
  assert.equal(structured.status, 'ok');
  assert.deepEqual(structured.guidance.requiredTopLevelFields, ['id', 'name', 'tracker', 'repo', 'workflow', 'symphony', 'codex']);
  assert.equal(structured.example.tracker.kind, 'linear');
  assert.equal(structured.example.workflow.source, 'repo');
});

test('MCP register_project validation errors include schema guidance', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb91-mcp-schema-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'register-invalid',
      method: 'tools/call',
      params: { name: 'register_project', arguments: { project: { id: 'incomplete' } } }
    }, runtime);

    const structured = ((response?.result as Record<string, unknown>).structuredContent as Record<string, any>);
    assert.equal(structured.status, 'error');
    assert.equal(structured.error.code, 'invalid_registry');
    assert.match(structured.error.message, /projects\[0\]\.tracker/);
    assert.deepEqual(structured.error.details.schema.guidance.requiredTopLevelFields, ['id', 'name', 'tracker', 'repo', 'workflow', 'symphony', 'codex']);
    assert.equal(structured.error.details.schema.example.codex.threadSandbox, 'workspace-write');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP list_teams returns accessible Linear teams', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });
  runtime.mcpServices = {
    createLinearService: () => ({
      async listTeams() {
        return [{ id: 'team-1', key: 'MRB', name: 'Mrboo', description: 'Main team' }];
      }
    } as never)
  };

  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'linear-teams',
    method: 'tools/call',
    params: { name: 'list_teams', arguments: {} }
  }, runtime);

  const result = response?.result as Record<string, unknown>;
  const structured = result.structuredContent as { status: string; teams: unknown[] };
  assert.equal(result.isError, false);
  assert.deepEqual(structured, {
    status: 'ok',
    teams: [{ id: 'team-1', key: 'MRB', name: 'Mrboo', description: 'Main team' }]
  });
});

test('MCP find_linear_project returns matching Linear projects', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'find-project',
    method: 'tools/call',
    params: { name: 'find_linear_project', arguments: { name: 'meta', slugId: 'meta-123' } }
  }, {
    ...runtime,
    mcpServices: {
      createLinearService: () => createLinearService({
        client: fakeLinearProjectClient()
      })
    }
  });

  const structured = ((response?.result as Record<string, unknown>).structuredContent as Record<string, any>);
  assert.equal(structured.status, 'ok');
  assert.deepEqual(structured.projects, [{
    id: 'project-1',
    name: 'Meta Orchestrator',
    slugId: 'meta-123',
    url: 'https://linear.example/project/meta-123',
    teamId: 'team-1'
  }]);
});

test('MCP resources/list exposes managed projects from YAML registry', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb8-mcp-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: '/tmp/meta-orchestrator',
      workspaceRoot: '/tmp/workspaces/meta-orchestrator'
    })));

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

test('MCP validate_project returns structured invalid setup output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-mcp-invalid-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: join(cwd, 'missing-repo'),
      workspaceRoot: join(cwd, 'workspace')
    })));

    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'validate_project', arguments: { projectId: 'meta-orchestrator' } }
    }, runtime);

    const result = response?.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>).status, 'invalid');
    const text = ((result.content as Array<Record<string, string>>)[0]).text;
    const output = JSON.parse(text);
    assert.equal(output.status, 'invalid');
    assert.equal(output.setup[0].issues[0].code, 'repo_path_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP registry tools can register, list, and get projects', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb12-mcp-registry-'));
  const configPath = join(cwd, 'registry.yaml');
  const project = managedProject({ repoPath: join(cwd, 'repo'), workspaceRoot: join(cwd, 'workspace') });

  try {
    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    const registered = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'register',
      method: 'tools/call',
      params: { name: 'register_project', arguments: { project } }
    }, runtime);
    assert.equal(((registered?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).status, 'ok');

    const listed = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'list',
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} }
    }, runtime);
    const projects = (((listed?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).projects as unknown[]);
    assert.equal(projects.length, 1);

    const fetched = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'get',
      method: 'tools/call',
      params: { name: 'get_project', arguments: { projectId: 'meta-orchestrator' } }
    }, runtime);
    const fetchedProject = (((fetched?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).project as Record<string, unknown>);
    assert.equal(fetchedProject.name, 'Meta Orchestrator');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP smoke registers project, renders workflow, and validates setup', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb13-mcp-smoke-'));
  const configPath = join(cwd, 'registry.yaml');
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const project = managedProject({
    repoPath,
    workspaceRoot: workspacePath,
    logsRoot: logsPath,
    runnerPort: 43_120 + Math.trunc(Math.random() * 1000)
  });

  try {
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });

    const registered = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'register',
      method: 'tools/call',
      params: { name: 'register_project', arguments: { project } }
    }, runtime);
    assert.equal(((registered?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).status, 'ok');

    const rendered = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'render',
      method: 'tools/call',
      params: { name: 'generate_workflow', arguments: { projectId: 'meta-orchestrator' } }
    }, runtime);
    const workflow = (((rendered?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).workflow as Record<string, unknown>);
    assert.equal(workflow.workflowPath, join(workspacePath, 'WORKFLOW.md'));

    const validated = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'validate',
      method: 'tools/call',
      params: { name: 'validate_project', arguments: { projectId: 'meta-orchestrator' } }
    }, runtime);
    assert.equal(((validated?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).status, 'ok');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP Linear tools return structured missing auth errors', async () => {
  const runtime = createRuntimeConfig({ env: {}, argv: [], cwd: process.cwd() });
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'linear',
    method: 'tools/call',
    params: { name: 'create_issue', arguments: { title: 'Test', teamKey: 'MRB' } }
  }, runtime);

  const result = response?.result as Record<string, unknown>;
  const structured = result.structuredContent as { status: string; error: { code: string } };
  assert.equal(result.isError, true);
  assert.equal(structured.status, 'error');
  assert.equal(structured.error.code, 'missing_api_key');
});

function fakeLinearProjectClient(): LinearSdkClient {
  return {
    async issue(id) {
      return { id, identifier: 'MRB-1', url: 'https://linear.example/MRB-1' };
    },
    async createProject() {
      return { project: { id: 'project-1', name: 'Meta Orchestrator', slugId: 'meta-123', url: 'https://linear.example/project/meta-123' } };
    },
    async createIssue() {
      return { issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.example/MRB-1' } };
    },
    async createIssueBatch() {
      return { issues: [] };
    },
    async createIssueRelation() {
      return { relation: { id: 'relation-1', type: 'blocks' } };
    },
    async updateIssue() {
      return { issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.example/MRB-1' } };
    },
    async projects() {
      return {
        nodes: [{
          id: 'project-1',
          name: 'Meta Orchestrator',
          slugId: 'meta-123',
          url: 'https://linear.example/project/meta-123',
          team: { id: 'team-1', key: 'MRB' }
        }]
      };
    },
    async teams() {
      return { nodes: [{ id: 'team-1', key: 'MRB' }] };
    },
    async workflowStates() {
      return { nodes: [{ id: 'state-1', name: 'Backlog' }] };
    }
  };
}
