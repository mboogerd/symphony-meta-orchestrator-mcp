import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeConfig, handleMcpMessage, type JsonRpcResponse, type ManagedProject, type RunnerManager } from '../src/index.ts';
import { LinearService, type LinearSdkClient } from '../src/services/linear/index.ts';
import { managedProject } from './project-fixtures.ts';

test('MCP integration registers, validates, renders, starts, reports, and stops a managed project', async () => {
  const fixture = createProjectFixture('mrb20-happy-');
  const runnerCalls: string[] = [];
  const runner = mockRunnerManager(runnerCalls);

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createRunnerManager: () => runner
    });

    const registered = await callTool(runtime, 'register', 'register_project', { project: fixture.project });
    assertJsonRpcOk(registered, 'register');
    assert.equal(toolPayload(registered).status, 'ok');

    const validated = await callTool(runtime, 'validate', 'validate_project', { projectId: fixture.project.id });
    assertJsonRpcOk(validated, 'validate');
    assert.equal(toolPayload(validated).status, 'ok');

    const rendered = await callTool(runtime, 'render', 'generate_workflow', { projectId: fixture.project.id });
    assertJsonRpcOk(rendered, 'render');
    assert.equal(toolPayload(rendered).workflow.workflowPath, join(fixture.workspacePath, 'WORKFLOW.md'));

    const started = await callTool(runtime, 'start', 'start_runner', { projectId: fixture.project.id });
    assertJsonRpcOk(started, 'start');
    assert.equal(toolPayload(started).runner.status.state, 'running');

    const status = await callTool(runtime, 'status', 'get_runner_status', { projectId: fixture.project.id });
    assertJsonRpcOk(status, 'status');
    assert.equal(toolPayload(status).runner.state, 'running');

    const stopped = await callTool(runtime, 'stop', 'stop_runner', { projectId: fixture.project.id });
    assertJsonRpcOk(stopped, 'stop');
    assert.equal(toolPayload(stopped).runner.state, 'stopped');
    assert.deepEqual(runnerCalls, ['start:meta-orchestrator', 'status:meta-orchestrator', 'stop:meta-orchestrator']);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration creates planned Backlog issues and Linear dependencies with mocked SDK calls', async () => {
  const fixture = createProjectFixture('mrb20-linear-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client = mockLinearClient(calls);

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client })
    });
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const response = await callTool(runtime, 'planned', 'create_planned_issue_batch', {
      projectId: fixture.project.id,
      issues: [
        { key: 'setup', title: 'Set up control plane' },
        { key: 'tests', title: 'Add integration tests' }
      ],
      dependencies: [{ from: 'setup', blocks: 'tests' }]
    });

    assertJsonRpcOk(response, 'planned');
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
    assert.equal(calls[0].input.filter.name.eq, 'Backlog');
    assert.equal(calls[1].input.stateId, 'state-backlog');
    assert.equal(calls[1].input.projectId, fixture.project.tracker.projectId);
    assert.equal(calls[2].input.filter.name.eq, 'Backlog');
    assert.equal(calls[3].input.stateId, 'state-backlog');
    assert.deepEqual(calls[6].input, {
      issueId: 'issue-1',
      relatedIssueId: 'issue-2',
      type: 'blocks'
    });
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration sets up a managed project end-to-end with defaults', async () => {
  const fixture = createProjectFixture('mrb71-setup-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const runnerCalls: string[] = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) }),
      createRunnerManager: () => mockRunnerManager(runnerCalls)
    });

    const response = await callTool(runtime, 'setup', 'setup_project', {
      name: 'Dummy Project',
      teamKey: 'MRB',
      repoPath: fixture.repoPath,
      runnerPort: fixture.project.symphony.runnerPort,
      workspaceRoot: fixture.workspacePath,
      logsRoot: fixture.logsPath,
      startRunner: true
    });

    assertJsonRpcOk(response, 'setup');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'registry:ok',
      'workflow:ok',
      'runner:ok'
    ]);
    assert.equal(payload.setup.project.id, 'dummy-project');
    assert.equal(payload.setup.project.tracker.teamId, 'linear-team-id');
    assert.equal(payload.setup.project.tracker.projectId, 'project-id');
    assert.equal(payload.setup.project.tracker.projectSlug, 'project-slug');
    assert.equal(payload.setup.workflow.workflowPath, join(fixture.workspacePath, 'WORKFLOW.md'));
    assert.equal(payload.setup.runner.status.state, 'running');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'createProject']);
    assert.deepEqual(runnerCalls, ['start:dummy-project']);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration can set up a managed project from an existing Linear project', async () => {
  const fixture = createProjectFixture('mrb75-existing-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-existing', 'setup_project', {
      name: 'Existing Project',
      teamKey: 'MRB',
      linearProjectId: 'existing-project-id',
      repoPath: fixture.repoPath,
      runnerPort: fixture.project.symphony.runnerPort,
      workspaceRoot: fixture.workspacePath,
      logsRoot: fixture.logsPath
    });

    assertJsonRpcOk(response, 'setup-existing');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.project.tracker.projectId, 'existing-project-id');
    assert.equal(payload.setup.project.tracker.projectSlug, 'existing-project-slug');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'projects']);
    assert.deepEqual(calls[1].input, {
      filter: {
        id: { eq: 'existing-project-id' },
        teams: { id: { eq: 'linear-team-id' } }
      },
      first: 1
    });
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration rejects an existing Linear project outside the resolved team', async () => {
  const fixture = createProjectFixture('mrb75-wrong-team-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-wrong-team', 'setup_project', {
      name: 'Wrong Team Project',
      teamKey: 'MRB',
      linearProjectId: 'wrong-team-project-id',
      repoPath: fixture.repoPath,
      runnerPort: fixture.project.symphony.runnerPort,
      workspaceRoot: fixture.workspacePath,
      logsRoot: fixture.logsPath
    });

    assertJsonRpcOk(response, 'setup-wrong-team');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:error'
    ]);
    assert.equal(payload.setup.steps[0].error.code, 'project_not_found');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'projects']);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration returns partial setup details when workflow generation fails', async () => {
  const fixture = createProjectFixture('mrb71-partial-', { writeWorkflow: false });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup', 'setup_project', {
      name: 'Partial Project',
      teamKey: 'MRB',
      repoPath: fixture.repoPath,
      runnerPort: fixture.project.symphony.runnerPort,
      workspaceRoot: fixture.workspacePath,
      logsRoot: fixture.logsPath
    });

    assertJsonRpcOk(response, 'setup');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.equal(payload.setup.project.id, 'partial-project');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'registry:ok',
      'workflow:error'
    ]);
    assert.equal(payload.setup.steps[2].error.name, 'WorkflowSetupValidationError');
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration returns structured tool error when a workflow template is missing', async () => {
  const fixture = createProjectFixture('mrb20-missing-workflow-', { writeWorkflow: false });

  try {
    const runtime = runtimeFor(fixture.configPath);
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const response = await callTool(runtime, 'render', 'generate_workflow', { projectId: fixture.project.id });

    assertJsonRpcOk(response, 'render');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'error');
    assert.equal(payload.error.code, 'invalid_workflow_setup');
    assert.equal(payload.error.details.setup[0].issues[0].code, 'workflow_path_missing');
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration reports live runner command and port failures when requested', async () => {
  const fixture = createProjectFixture('mrb20-runner-failure-', { command: 'definitely-missing-symphony-runner' });
  const checkedPorts: number[] = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return false;
      }
    });
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const response = await callTool(runtime, 'validate', 'validate_project', { projectId: fixture.project.id, phase: 'live' });

    assertJsonRpcOk(response, 'validate');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.equal(payload.setup[0].phase, 'live');
    const codes = payload.setup[0].issues.map((issue: { code: string }) => issue.code);
    assert.deepEqual(codes.sort(), ['runner_command_missing', 'runner_port_unavailable']);
    assert.deepEqual(checkedPorts, [fixture.project.symphony.runnerPort]);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration exposes machine-readable tool errors for callers', async () => {
  const runtime = runtimeFor(join(mkdtempSync(join(tmpdir(), 'mrb20-error-')), 'registry.yaml'));
  const response = await callTool(runtime, 'missing', 'get_project', { projectId: 'missing-project' });

  assertJsonRpcOk(response, 'missing');
  const result = response.result as Record<string, unknown>;
  assert.equal(result.isError, true);
  const payload = toolPayload(response);
  assert.equal(payload.status, 'error');
  assert.deepEqual(payload.error, {
    code: 'project_not_found',
    message: 'Project was not found',
    details: { projectId: 'missing-project' }
  });
});

function createProjectFixture(prefix: string, options: { writeWorkflow?: boolean; command?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(root, 'registry.yaml');
  const repoPath = join(root, 'repo');
  const workspacePath = join(root, 'workspace');
  const logsPath = join(root, 'logs');
  const project = managedProject({
    repoPath,
    workspaceRoot: workspacePath,
    logsRoot: logsPath,
    command: options.command ?? process.execPath,
    runnerPort: 43_120 + Math.trunc(Math.random() * 1000)
  });

  mkdirSync(join(repoPath, '.git'), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(logsPath, { recursive: true });

  if (options.writeWorkflow !== false) {
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
  }

  return {
    root,
    configPath,
    repoPath,
    workspacePath,
    logsPath,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function runtimeFor(configPath: string, services: NonNullable<Parameters<typeof handleMcpMessage>[1]['mcpServices']> = {}) {
  return {
    ...createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() }),
    mcpServices: services
  };
}

async function callTool(runtime: Parameters<typeof handleMcpMessage>[1], id: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  }, runtime);

  assert.ok(response);
  return response;
}

function assertJsonRpcOk(response: JsonRpcResponse, id: string): void {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  assert.equal(response.error, undefined);
  assert.ok(response.result);
}

function toolPayload(response: JsonRpcResponse): Record<string, any> {
  const result = response.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
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
        team: { id: 'linear-team-id', key: 'MRB', name: 'MRB' },
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
      if (input?.filter?.id?.eq === 'existing-project-id' && input?.filter?.teams?.id?.eq === 'linear-team-id') {
        return {
          nodes: [{
            id: 'existing-project-id',
            name: 'Existing Project',
            slugId: 'existing-project-slug',
            url: 'https://linear.example/existing-project'
          }]
        };
      }
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
