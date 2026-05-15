import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeConfig, handleMcpMessage } from '../src/index.ts';
import { setupProjectDescription } from '../src/mcp/tool-descriptions.ts';
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
    'relink_project',
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
    'create_linear_project_planned_issue_batch',
    'promote_ready_issue',
    'link_project_issue_dependency',
    'enable_project',
    'disable_project',
    'restart_runner',
    'get_runner_status',
    'tail_runner_logs'
  ]);
  const setupProjectTool = tools.find((tool) => tool.name === 'setup_project');
  assert.equal(setupProjectTool?.description, setupProjectDescription);
  assert.deepEqual((setupProjectTool?.inputSchema as any).required, ['name', 'teamKey', 'githubUrl']);
  assert.equal((setupProjectTool?.inputSchema as any).properties.repoPath, undefined);
  assert.equal((setupProjectTool?.inputSchema as any).properties.runnerPort, undefined);
  assert.match(String(setupProjectTool?.description), /githubUrl must point to a GitHub repository/);
  assert.match(String(setupProjectTool?.description), /describe_project_schema and then register_project/);
  assert.match(String(setupProjectTool?.description), /Partial failures are not automatically rolled back/);
  assert.match(String(setupProjectTool?.description), /includes recovery with the failed step/);
});

test('MCP setup_project rejects removed repoPath parameter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb121-setup-schema-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    const runtime = createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() });
    runtime.mcpServices = {
      createLinearService: () => ({
        resolveTeam: async () => ({ id: 'team-1', key: 'MRB', name: 'MRB' }),
        findProjectByNameForTeam: async () => undefined,
        createProject: async () => ({ id: 'project-1', name: 'Dummy', slugId: 'dummy', url: 'https://linear.example/project/dummy', teamId: 'team-1' }),
        resolveProjectForTeam: async () => undefined
      } as never)
    };

    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'setup-repo-path',
      method: 'tools/call',
      params: {
        name: 'setup_project',
        arguments: {
          name: 'Dummy',
          teamKey: 'MRB',
          githubUrl: 'https://github.com/org/repo.git',
          repoPath: '/tmp/repo'
        }
      }
    }, runtime);

    const result = response?.result as Record<string, unknown>;
    const structured = result.structuredContent as Record<string, any>;
    assert.equal(result.isError, true);
    assert.equal(structured.status, 'error');
    assert.equal(structured.error.code, 'invalid_input');
    assert.equal(structured.error.details.field, 'repoPath');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
  assert.deepEqual(structured.guidance.requiredTopLevelFields, ['id', 'name', 'githubUrl', 'workflow', 'codex']);
  assert.equal(structured.example.githubUrl, 'https://github.com/example/meta-orchestrator.git');
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
    assert.match(structured.error.message, /projects\[0\]\.githubUrl/);
    assert.deepEqual(structured.error.details.schema.guidance.requiredTopLevelFields, ['id', 'name', 'githubUrl', 'workflow', 'codex']);
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
          description: 'Meta Orchestrator managed project for git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git',
          mimeType: 'application/yaml'
        }]
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP validate_project fails without repo WORKFLOW.md', async () => {
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
    assert.equal(output.setup[0].issues[0].code, 'workflow_missing_in_repo');
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

test('MCP relink_project updates persisted Linear tracker linkage without duplicating projects', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb138-mcp-relink-'));
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

    const relinked = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'relink',
      method: 'tools/call',
      params: {
        name: 'relink_project',
        arguments: {
          projectId: 'meta-orchestrator',
          linearProjectId: 'replacement-linear-project',
          linearProjectSlug: 'replacement-linear-project-slug'
        }
      }
    }, runtime);

    const structured = ((relinked?.result as Record<string, unknown>).structuredContent as Record<string, any>);
    assert.equal(structured.status, 'ok');
    assert.equal(structured.project.tracker.projectId, 'replacement-linear-project');
    assert.equal(structured.project.tracker.projectSlug, 'replacement-linear-project-slug');

    const listed = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'list',
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} }
    }, runtime);
    const projects = (((listed?.result as Record<string, unknown>).structuredContent as Record<string, any>).projects as any[]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].tracker.projectId, 'replacement-linear-project');
    assert.equal(projects[0].tracker.projectSlug, 'replacement-linear-project-slug');
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
    async project(id) {
      return {
        id,
        name: 'Meta Orchestrator',
        slugId: 'meta-123',
        url: 'https://linear.example/project/meta-123',
        team: { id: 'team-1', key: 'MRB' }
      };
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
      return { issueRelation: { id: 'relation-1', type: 'blocks' } };
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
