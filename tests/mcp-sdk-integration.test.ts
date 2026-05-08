import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, createRuntimeConfig, handleMcpMessage, type JsonRpcResponse, type ManagedProject, type McpServerRuntimeConfig, type RunnerManager } from '../src/index.ts';
import { LinearService, type LinearSdkClient } from '../src/services/linear/index.ts';
import { managedProject } from './project-fixtures.ts';

test('SDK MCP lists tools and matches compatibility tool names', async () => {
  const fixture = createProjectFixture('mrb27-sdk-tools-');

  try {
    const sdk = await createSdkHarness(runtimeFor(fixture.configPath));
    try {
      const listed = await sdk.client.listTools();
      const compatibility = await handleMcpMessage({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, runtimeFor(fixture.configPath));
      const compatibilityTools = ((compatibility?.result as Record<string, unknown>).tools as Array<{ name: string }>).map((tool) => tool.name);

      assert.deepEqual(listed.tools.map((tool) => tool.name), compatibilityTools);
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('SDK MCP register, list, get, validate, and generate workflow use the real server layer', async () => {
  const fixture = createProjectFixture('mrb27-sdk-workflow-');

  try {
    const sdk = await createSdkHarness(runtimeFor(fixture.configPath));
    try {
      assert.equal(toolPayload(await sdk.client.callTool({
        name: 'register_project',
        arguments: { project: fixture.project }
      })).status, 'ok');

      const listed = toolPayload(await sdk.client.callTool({ name: 'list_projects', arguments: {} }));
      assert.equal(listed.projects.length, 1);

      const fetched = toolPayload(await sdk.client.callTool({
        name: 'get_project',
        arguments: { projectId: fixture.project.id }
      }));
      assert.equal(fetched.project.name, fixture.project.name);

      const resources = await sdk.client.listResources();
      assert.equal(resources.resources[0].uri, `symphony://projects/${fixture.project.id}`);

      const rendered = toolPayload(await sdk.client.callTool({
        name: 'generate_workflow',
        arguments: { projectId: fixture.project.id }
      }));
      assert.equal(rendered.workflow.workflowPath, join(fixture.workspacePath, 'WORKFLOW.md'));

      const validated = toolPayload(await sdk.client.callTool({
        name: 'validate_project',
        arguments: { projectId: fixture.project.id }
      }));
      assert.equal(validated.status, 'ok');
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('SDK MCP returns project_not_found as a structured tool error matching compatibility', async () => {
  const fixture = createProjectFixture('mrb27-sdk-missing-');

  try {
    const runtime = runtimeFor(fixture.configPath);
    const sdk = await createSdkHarness(runtime);
    try {
      const sdkResponse = await sdk.client.callTool({
        name: 'get_project',
        arguments: { projectId: 'missing-project' }
      });
      const compatibilityResponse = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 'missing',
        method: 'tools/call',
        params: { name: 'get_project', arguments: { projectId: 'missing-project' } }
      }, runtime);

      assert.deepEqual(toolPayload(sdkResponse), toolPayload(compatibilityResponse as JsonRpcResponse));
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('SDK MCP Linear planning tools use mocked service boundaries', async () => {
  const fixture = createProjectFixture('mrb27-sdk-linear-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });
    const sdk = await createSdkHarness(runtime);
    try {
      await sdk.client.callTool({ name: 'register_project', arguments: { project: fixture.project } });

      const response = await sdk.client.callTool({
        name: 'create_planned_issue_batch',
        arguments: {
          projectId: fixture.project.id,
          issues: [
            { key: 'setup', title: 'Set up control plane' },
            { key: 'tests', title: 'Add integration tests' }
          ],
          dependencies: [{ from: 'setup', blocks: 'tests' }]
        }
      });

      const payload = toolPayload(response);
      assert.equal(payload.status, 'ok');
      assert.deepEqual(payload.batch.issues.map((issue: { key: string }) => issue.key), ['setup', 'tests']);
      assert.equal(payload.batch.dependencies[0].dependency.type, 'blocks');
      assert.deepEqual(calls.map((call) => call.method), [
        'workflowStates',
        'createIssue',
        'workflowStates',
        'createIssue',
        'issue',
        'issue',
        'createIssueRelation'
      ]);
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('SDK MCP runner lifecycle tools use mocked runner and setup probes', async () => {
  const fixture = createProjectFixture('mrb27-sdk-runner-');
  const runnerCalls: string[] = [];
  const checkedPorts: number[] = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createRunnerManager: () => mockRunnerManager(runnerCalls),
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return true;
      }
    });
    const sdk = await createSdkHarness(runtime);
    try {
      await sdk.client.callTool({ name: 'register_project', arguments: { project: fixture.project } });

      assert.equal(toolPayload(await sdk.client.callTool({
        name: 'start_runner',
        arguments: { projectId: fixture.project.id }
      })).runner.status.state, 'running');
      assert.equal(toolPayload(await sdk.client.callTool({
        name: 'get_runner_status',
        arguments: { projectId: fixture.project.id }
      })).runner.state, 'running');
      assert.equal(toolPayload(await sdk.client.callTool({
        name: 'stop_runner',
        arguments: { projectId: fixture.project.id }
      })).runner.state, 'stopped');
      assert.equal(toolPayload(await sdk.client.callTool({
        name: 'validate_project',
        arguments: { projectId: fixture.project.id, phase: 'live' }
      })).status, 'ok');

      assert.deepEqual(runnerCalls, ['start:meta-orchestrator', 'status:meta-orchestrator', 'stop:meta-orchestrator']);
      assert.deepEqual(checkedPorts, [fixture.project.symphony.runnerPort]);
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('SDK MCP returns structured Linear service errors', async () => {
  const fixture = createProjectFixture('mrb27-sdk-linear-error-');

  try {
    const sdk = await createSdkHarness(runtimeFor(fixture.configPath));
    try {
      const payload = toolPayload(await sdk.client.callTool({
        name: 'create_issue',
        arguments: { title: 'Test', teamKey: 'MRB' }
      }));

      assert.equal(payload.status, 'error');
      assert.equal(payload.error.code, 'missing_api_key');
    } finally {
      await sdk.close();
    }
  } finally {
    fixture.cleanup();
  }
});

function createProjectFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(root, 'registry.yaml');
  const repoPath = join(root, 'repo');
  const workspacePath = join(root, 'workspace');
  const logsPath = join(root, 'logs');
  const project = managedProject({
    repoPath,
    workspaceRoot: workspacePath,
    logsRoot: logsPath,
    command: process.execPath,
    runnerPort: 44_120 + Math.trunc(Math.random() * 1000)
  });

  mkdirSync(join(repoPath, '.git'), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(logsPath, { recursive: true });
  writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));

  return {
    root,
    configPath,
    workspacePath,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function runtimeFor(configPath: string, services: NonNullable<McpServerRuntimeConfig['mcpServices']> = {}): McpServerRuntimeConfig {
  return {
    ...createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() }),
    mcpServices: services
  };
}

async function createSdkHarness(runtime: McpServerRuntimeConfig) {
  const server = createMcpServer(runtime);
  const client = new Client({ name: 'mcp-sdk-integration-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function toolPayload(response: JsonRpcResponse | Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const result = 'result' in response ? response.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> } : response;
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
  return result.structuredContent as Record<string, any>;
}

function mockRunnerManager(calls: string[]): RunnerManager {
  return {
    async start(project: ManagedProject) {
      calls.push(`start:${project.id}`);
      return {
        started: true,
        status: runnerStatus(project, 'running')
      };
    },
    async stop(project: ManagedProject) {
      calls.push(`stop:${project.id}`);
      return runnerStatus(project, 'stopped');
    },
    async restart(project: ManagedProject) {
      calls.push(`restart:${project.id}`);
      return {
        started: true,
        status: runnerStatus(project, 'running')
      };
    },
    async status(project: ManagedProject) {
      calls.push(`status:${project.id}`);
      return runnerStatus(project, 'running');
    },
    async tailLogs(project: ManagedProject) {
      calls.push(`tail:${project.id}`);
      return {
        id: project.id,
        logPath: join(project.symphony.logsRoot, `${project.id}.runner.log`),
        lines: [],
        lineCount: 0,
        truncated: false
      };
    }
  };
}

function runnerStatus(project: ManagedProject, state: 'running' | 'stopped') {
  return {
    id: project.id,
    state,
    pid: 12345,
    port: project.symphony.runnerPort,
    command: project.symphony.command,
    args: project.symphony.args,
    cwd: project.symphony.workspaceRoot,
    workflowPath: join(project.symphony.workspaceRoot, 'WORKFLOW.md'),
    dashboardUrl: `http://localhost:${project.symphony.runnerPort}`,
    logPath: join(project.symphony.logsRoot, `${project.id}.runner.log`),
    statePath: join(project.symphony.logsRoot, `${project.id}.runner.json`),
    latestHeartbeat: '2026-05-08T00:00:00.000Z',
    details: {
      message: `Runner is ${state}`,
      checkedAt: '2026-05-08T00:00:00.000Z'
    }
  };
}

function mockLinearClient(calls: Array<{ method: string; input: Record<string, unknown> }>): LinearSdkClient {
  let nextIssue = 1;
  return {
    async issue(id) {
      calls.push({ method: 'issue', input: { id } });
      return {
        id,
        identifier: id === 'issue-1' ? 'MRB-1' : 'MRB-2',
        url: `https://linear.example/${id}`,
        team: { id: 'linear-team-id', key: 'MRB' },
        project: { id: 'linear-project-id', name: 'Meta Orchestrator' }
      };
    },
    async createProject(input) {
      calls.push({ method: 'createProject', input });
      return { project: { id: 'project-id', name: String(input.name), slugId: 'project-slug', url: 'https://linear.example/project' } };
    },
    async createIssue(input) {
      calls.push({ method: 'createIssue', input });
      const issueNumber = nextIssue++;
      return { issue: { id: `issue-${issueNumber}`, identifier: `MRB-${issueNumber}`, url: `https://linear.example/MRB-${issueNumber}` } };
    },
    async createIssueBatch(input) {
      calls.push({ method: 'createIssueBatch', input });
      return { issues: [] };
    },
    async createIssueRelation(input) {
      calls.push({ method: 'createIssueRelation', input });
      return { relation: { id: 'relation-1', type: 'blocks' } };
    },
    async updateIssue(id, input) {
      calls.push({ method: 'updateIssue', input: { id, ...input } });
      return { issue: { id, identifier: 'MRB-1', url: 'https://linear.example/MRB-1' } };
    },
    async projects(input) {
      calls.push({ method: 'projects', input: input ?? {} });
      return { nodes: [] };
    },
    async teams(input) {
      calls.push({ method: 'teams', input: input ?? {} });
      return { nodes: [{ id: 'linear-team-id', key: 'MRB', name: 'MRB' }] };
    },
    async workflowStates(input) {
      calls.push({ method: 'workflowStates', input: input ?? {} });
      return { nodes: [{ id: 'state-backlog', name: 'Backlog', type: 'backlog' }] };
    }
  };
}
