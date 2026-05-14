import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectRegistryService, createRuntimeConfig, handleMcpMessage, startAllRunners, type JsonRpcResponse, type ManagedProject, type RunnerManager, type RunnerProcessState } from '../src/index.ts';
import { LinearService, type LinearSdkClient } from '../src/services/linear/index.ts';
import { managedProject } from './project-fixtures.ts';

test('MCP integration registers, validates, renders, enables, reports, and disables a managed project', async () => {
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

    const started = await callTool(runtime, 'start', 'enable_project', { projectId: fixture.project.id });
    assertJsonRpcOk(started, 'start');
    assert.equal(toolPayload(started).runner.status.state, 'running');

    const status = await callTool(runtime, 'status', 'get_runner_status', { projectId: fixture.project.id });
    assertJsonRpcOk(status, 'status');
    assert.equal(toolPayload(status).runner.state, 'running');

    const stopped = await callTool(runtime, 'stop', 'disable_project', { projectId: fixture.project.id });
    assertJsonRpcOk(stopped, 'stop');
    assert.equal(toolPayload(stopped).runner.state, 'stopped');
    assert.deepEqual(runnerCalls, ['start:meta-orchestrator', 'status:meta-orchestrator', 'stop:meta-orchestrator']);
  } finally {
    fixture.cleanup();
  }
});

test('enable_project starts runner and persists enabled as the default', async () => {
  const fixture = createProjectFixture('mrb122-enable-');
  const runnerCalls: string[] = [];
  fixture.project.enabled = false;

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createRunnerManager: () => mockRunnerManager(runnerCalls)
    });
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const enabled = await callTool(runtime, 'enable', 'enable_project', { projectId: fixture.project.id });

    assertJsonRpcOk(enabled, 'enable');
    assert.equal(toolPayload(enabled).runner.status.state, 'running');
    assert.deepEqual(runnerCalls, ['start:meta-orchestrator']);
    assert.equal((await runtimeRegistryProject(runtime, fixture.project.id)).enabled, undefined);
    assert.doesNotMatch(readFileSync(fixture.configPath, 'utf8'), /enabled: true|enabled: false/);
  } finally {
    fixture.cleanup();
  }
});

test('disable_project stops runner and persists enabled: false', async () => {
  const fixture = createProjectFixture('mrb122-disable-');
  const runnerCalls: string[] = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createRunnerManager: () => mockRunnerManager(runnerCalls)
    });
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const disabled = await callTool(runtime, 'disable', 'disable_project', { projectId: fixture.project.id });

    assertJsonRpcOk(disabled, 'disable');
    assert.equal(toolPayload(disabled).runner.state, 'stopped');
    assert.deepEqual(runnerCalls, ['stop:meta-orchestrator']);
    assert.equal((await runtimeRegistryProject(runtime, fixture.project.id)).enabled, false);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /enabled: false/);
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

test('MCP integration creates planned issues for an unregistered Linear project', async () => {
  const fixture = createProjectFixture('mrb104-linear-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client = mockLinearClient(calls);

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client })
    });

    const response = await callTool(runtime, 'raw-planned', 'create_linear_project_planned_issue_batch', {
      teamKey: 'MRB',
      linearProjectId: 'linear-project-id',
      issues: [
        { key: 'setup', title: 'Set up control plane' },
        { key: 'tests', title: 'Add integration tests' }
      ],
      dependencies: [{ from: 'setup', blocks: 'tests' }]
    });

    assertJsonRpcOk(response, 'raw-planned');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.batch.issues.map((issue: { key: string }) => issue.key), ['setup', 'tests']);
    assert.equal(payload.batch.dependencies[0].dependency.type, 'blocks');
    assert.deepEqual(calls.map((call) => call.method), [
      'teams',
      'project',
      'workflowStates',
      'createIssue',
      'workflowStates',
      'createIssue',
      'issue',
      'issue',
      'createIssueRelation'
    ]);
    assert.equal(calls[3].input.projectId, 'linear-project-id');
    assert.deepEqual(calls[8].input, {
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
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) }),
      createRunnerManager: () => mockRunnerManager(runnerCalls)
    });

    const response = await callTool(runtime, 'setup', 'setup_project', {
      name: 'Dummy Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl,
      startRunner: true
    });

    assertJsonRpcOk(response, 'setup');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:ok',
      'workflow:ok',
      'runner:ok'
    ]);
    assert.equal(payload.setup.project.id, 'dummy-project');
    assert.equal(payload.setup.project.tracker.teamId, 'linear-team-id');
    assert.equal(payload.setup.project.tracker.projectId, 'project-id');
    assert.equal(payload.setup.project.id, 'dummy-project');
    const defaultWorkspace = join(tmpdir(), 'symphony-workspaces', 'dummy-project');
    assert.match(readFileSync(join(defaultWorkspace, 'WORKFLOW.md'), 'utf8'), /project_slug: dummy-project/);
    assert.match(readFileSync(join(defaultWorkspace, 'WORKFLOW.md'), 'utf8'), /after_create: git clone https:\/\/github\.com\/mboogerd\/symphony-meta-orchestrator-mcp\.git ./);
    assert.deepEqual(payload.setup.project.workflow, { source: 'generated', template: 'default' });
    assert.equal(payload.setup.project.githubUrl, fixture.project.repo.remoteUrl);
    assert.equal(payload.setup.project.repo, undefined);
    assert.equal(payload.setup.project.symphony.command, process.execPath);
    assert.deepEqual(payload.setup.project.symphony.args, [
      join(process.cwd(), 'test-symphony', 'bin', 'symphony'),
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
    ]);
    assert.equal(payload.setup.project.symphony.cwd, join(process.cwd(), 'test-symphony'));
    assert.equal(payload.setup.workflow.workflowPath, join(defaultWorkspace, 'WORKFLOW.md'));
    assert.equal(payload.setup.workflow.logsRoot, join(tmpdir(), 'symphony-logs', 'dummy-project'));
    assert.equal(existsSync(fixture.repoPath), false);
    assert.equal(payload.setup.runner.status.state, 'running');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'teams', 'team.projects', 'createProject']);
    assert.deepEqual(runnerCalls, ['start:dummy-project']);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration attaches existing same-name Linear project during setup', async () => {
  const fixture = createProjectFixture('mrb97-existing-name-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    configureGitOrigin(fixture.repoPath);
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-existing-name', 'setup_project', {
      name: 'Existing Name Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-existing-name');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.project.tracker.projectId, 'existing-name-project-id');
    assert.equal(payload.setup.project.tracker.projectSlug, 'existing-name-project-slug');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'teams', 'team.projects']);
    assert.deepEqual(calls[2].input, { filter: { name: { eqIgnoreCase: 'Existing Name Project' } }, first: 2 });
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration can set up a managed project from an existing Linear project', async () => {
  const fixture = createProjectFixture('mrb75-existing-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    configureGitOrigin(fixture.repoPath);
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-existing', 'setup_project', {
      name: 'Existing Project',
      teamKey: 'MRB',
      linearProjectId: 'existing-project-id',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-existing');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.project.tracker.projectId, 'existing-project-id');
    assert.equal(payload.setup.project.tracker.projectSlug, 'existing-project-97e46de28c13');
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'project']);
    assert.deepEqual(calls[1].input, { id: 'existing-project-id' });
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration setup_project uses SYMPHONY_RUNNER_COMMAND without bootstrapping', async () => {
  const fixture = createProjectFixture('mrb100-runner-env-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) }),
      runnerBootstrap: async () => {
        throw new Error('runner bootstrap should not be called when SYMPHONY_RUNNER_COMMAND is set');
      }
    });
    runtime.env.SYMPHONY_RUNNER_COMMAND = 'custom-symphony-runner';

    const response = await callTool(runtime, 'setup-env-runner', 'setup_project', {
      name: 'Env Runner Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-env-runner');
    const payload = toolPayload(response);
    assert.equal(payload.setup.project.symphony.command, 'custom-symphony-runner');
    assert.deepEqual(payload.setup.project.symphony.args, ['--i-understand-that-this-will-be-running-without-the-usual-guardrails']);
    assert.equal(payload.setup.project.symphony.cwd, process.cwd());
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration reports runner bootstrap failures in the bootstrap step', async () => {
  const fixture = createProjectFixture('mrb102-bootstrap-error-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) }),
      runnerBootstrap: async () => {
        throw new Error('Command failed: git clone https://github.com/mboogerd/symphony.git ...');
      }
    });

    const response = await callTool(runtime, 'setup-bootstrap-error', 'setup_project', {
      name: 'Bootstrap Error Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-bootstrap-error');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:error'
    ]);
    assert.match(payload.setup.steps[1].error.message, /git clone https:\/\/github\.com\/mboogerd\/symphony\.git/);
    assert.equal(payload.setup.project, undefined);
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
      githubUrl: fixture.project.repo.remoteUrl
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
    assert.deepEqual(calls.map((call) => call.method), ['teams', 'project']);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration rejects setup for a non-GitHub URL', async () => {
  const fixture = createProjectFixture('mrb96-no-remote-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-invalid-url', 'setup_project', {
      name: 'Invalid URL Project',
      teamKey: 'MRB',
      githubUrl: 'https://example.test/repo.git'
    });

    assertJsonRpcOk(response, 'setup-invalid-url');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:error'
    ]);
    assert.equal(payload.setup.steps[2].error.code, 'github_url_invalid');
    assert.equal(payload.setup.steps[2].error.field, 'githubUrl');
    assert.match(payload.setup.steps[2].error.message, /GitHub repository URL/);
    assert.equal(payload.setup.project, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('setup_project resolves workspaceRoot from DEFAULT_SYMPHONY_WORKSPACES env var', async () => {
  const fixture = createProjectFixture('mrb121-workspace-env-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });
    const workspaceBase = join(fixture.root, 'custom', 'ws');
    runtime.env.DEFAULT_SYMPHONY_WORKSPACES = workspaceBase;

    const response = await callTool(runtime, 'setup-workspace-env', 'setup_project', {
      name: 'Dummy',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-workspace-env');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.workflow.workspaceRoot, join(workspaceBase, 'dummy'));
    assert.equal(payload.setup.project.symphony.workspaceRoot, join(workspaceBase, 'dummy'));
  } finally {
    fixture.cleanup();
  }
});

test('setup_project fails gracefully when Linear has duplicate project names', async () => {
  const fixture = createProjectFixture('mrb121-duplicate-linear-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls, { duplicateProjectName: 'Duplicate Project' }) })
    });

    const response = await callTool(runtime, 'setup-duplicate-linear', 'setup_project', {
      name: 'Duplicate Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-duplicate-linear');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'invalid');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:error'
    ]);
    assert.equal(payload.setup.steps[0].error.code, 'duplicate_project_name');
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration derives githubUrl without exposing repo fields', async () => {
  const fixture = createProjectFixture('mrb101-explicit-remote-');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-github-remote', 'setup_project', {
      name: 'GitHub Remote Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-github-remote');
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:ok',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(payload.setup.project.githubUrl, fixture.project.repo.remoteUrl);
    assert.equal(payload.setup.project.repo, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration bootstraps missing workflow during project setup', async () => {
  const fixture = createProjectFixture('mrb71-partial-', { writeWorkflow: false });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup', 'setup_project', {
      name: 'Partial Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, false);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.project.id, 'partial-project');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:ok',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(payload.setup.workflow.workflowPath, join(tmpdir(), 'symphony-workspaces', 'partial-project', 'WORKFLOW.md'));
    assert.equal(existsSync(payload.setup.workflow.workflowPath), true);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration does not create or require a local repo during project setup', async () => {
  const fixture = createProjectFixture('mrb80-repo-file-', { writeWorkflow: false });
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];

  try {
    rmSync(fixture.repoPath, { recursive: true, force: true });
    const runtime = runtimeFor(fixture.configPath, {
      createLinearService: () => new LinearService({ client: mockLinearClient(calls) })
    });

    const response = await callTool(runtime, 'setup-repo-file', 'setup_project', {
      name: 'Repo File Project',
      teamKey: 'MRB',
      githubUrl: fixture.project.repo.remoteUrl
    });

    assertJsonRpcOk(response, 'setup-repo-file');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, false);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.setup.project.id, 'repo-file-project');
    assert.deepEqual(payload.setup.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:ok',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(existsSync(fixture.repoPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('MCP integration bootstraps missing workflow during generation', async () => {
  const fixture = createProjectFixture('mrb20-missing-workflow-', { writeWorkflow: false });

  try {
    const runtime = runtimeFor(fixture.configPath);
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const response = await callTool(runtime, 'render', 'generate_workflow', { projectId: fixture.project.id });

    assertJsonRpcOk(response, 'render');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.isError, false);
    const payload = toolPayload(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.workflow.workflowPath, join(fixture.workspacePath, 'WORKFLOW.md'));
    assert.equal(existsSync(payload.workflow.workflowPath), true);
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
    assert.deepEqual(codes.sort(), ['runner_port_unavailable']);
    assert.deepEqual(checkedPorts, [4310]);
  } finally {
    fixture.cleanup();
  }
});

test('MCP server startup starts idle runners for all registered projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb120-startup-idle-'));
  const configPath = join(root, 'registry.yaml');
  const calls: string[] = [];

  try {
    writeFileSync(configPath, registryYaml(['alpha-project', 'beta-project']));
    const runtime = runtimeFor(configPath, {
      createRunnerManager: () => startupRunnerManager(calls, {
        'alpha-project': 'idle',
        'beta-project': 'stopped'
      })
    });

    await startAllRunners(runtime, testLogger());

    assert.deepEqual(calls, [
      'status:alpha-project',
      'start:alpha-project',
      'status:beta-project',
      'start:beta-project'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server startup skips runner for project with enabled: false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb122-startup-disabled-'));
  const configPath = join(root, 'registry.yaml');
  const calls: string[] = [];

  try {
    writeFileSync(configPath, registryYaml(['disabled-project']).replace('    githubUrl:', '    enabled: false\n    githubUrl:'));
    const runtime = runtimeFor(configPath, {
      createRunnerManager: () => startupRunnerManager(calls, {
        'disabled-project': 'idle'
      })
    });

    await startAllRunners(runtime, testLogger());

    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server startup starts projects with enabled true or absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb122-startup-enabled-'));
  const configPath = join(root, 'registry.yaml');
  const calls: string[] = [];

  try {
    writeFileSync(configPath, registryYaml(['explicit-project', 'default-project']).replace('    githubUrl:', '    enabled: true\n    githubUrl:'));
    const runtime = runtimeFor(configPath, {
      createRunnerManager: () => startupRunnerManager(calls, {
        'explicit-project': 'idle',
        'default-project': 'idle'
      })
    });

    await startAllRunners(runtime, testLogger());

    assert.deepEqual(calls, [
      'status:explicit-project',
      'start:explicit-project',
      'status:default-project',
      'start:default-project'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart_runner works even when project is disabled', async () => {
  const fixture = createProjectFixture('mrb122-restart-disabled-');
  const runnerCalls: string[] = [];
  fixture.project.enabled = false;

  try {
    const runtime = runtimeFor(fixture.configPath, {
      createRunnerManager: () => mockRunnerManager(runnerCalls)
    });
    await callTool(runtime, 'register', 'register_project', { project: fixture.project });

    const restarted = await callTool(runtime, 'restart', 'restart_runner', { projectId: fixture.project.id });

    assertJsonRpcOk(restarted, 'restart');
    assert.equal(toolPayload(restarted).runner.status.state, 'running');
    assert.deepEqual(runnerCalls, ['restart:meta-orchestrator']);
  } finally {
    fixture.cleanup();
  }
});

test('tools/list does not include start_runner or stop_runner', async () => {
  const runtime = runtimeFor(join(mkdtempSync(join(tmpdir(), 'mrb122-tools-')), 'registry.yaml'));
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'tools',
    method: 'tools/list'
  }, runtime);

  assert.ok(response);
  assertJsonRpcOk(response, 'tools');
  const tools = ((response.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
  assert.equal(tools.includes('enable_project'), true);
  assert.equal(tools.includes('disable_project'), true);
  assert.equal(tools.includes('start_runner'), false);
  assert.equal(tools.includes('stop_runner'), false);
});

test('MCP server startup skips runners already in running state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb120-startup-running-'));
  const configPath = join(root, 'registry.yaml');
  const calls: string[] = [];

  try {
    writeFileSync(configPath, registryYaml(['running-project', 'starting-project']));
    const runtime = runtimeFor(configPath, {
      createRunnerManager: () => startupRunnerManager(calls, {
        'running-project': 'running',
        'starting-project': 'starting'
      })
    });

    await startAllRunners(runtime, testLogger());

    assert.deepEqual(calls, [
      'status:running-project',
      'status:starting-project'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server startup continues when one runner start fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb120-startup-failure-'));
  const configPath = join(root, 'registry.yaml');
  const calls: string[] = [];

  try {
    writeFileSync(configPath, registryYaml(['broken-project', 'healthy-project']));
    const runtime = runtimeFor(configPath, {
      createRunnerManager: () => startupRunnerManager(calls, {
        'broken-project': 'idle',
        'healthy-project': 'idle'
      }, new Set(['broken-project']))
    });

    await startAllRunners(runtime, testLogger());

    assert.deepEqual(calls, [
      'status:broken-project',
      'start:broken-project',
      'status:healthy-project',
      'start:healthy-project'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

function configureGitOrigin(repoPath: string): void {
  initGitRepo(repoPath);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://example.test/repo.git']);
}

function initGitRepo(repoPath: string): void {
  rmSync(join(repoPath, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-b', 'main', repoPath]);
}

function runtimeFor(configPath: string, services: NonNullable<Parameters<typeof handleMcpMessage>[1]['mcpServices']> = {}) {
  return {
    ...createRuntimeConfig({ env: {}, argv: ['--config', configPath], cwd: process.cwd() }),
    mcpServices: {
      runnerBootstrap: async () => ({
        command: process.execPath,
        args: [join(process.cwd(), 'test-symphony', 'bin', 'symphony'), '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
        cwd: join(process.cwd(), 'test-symphony')
      }),
      ...services
    }
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

async function runtimeRegistryProject(runtime: Parameters<typeof handleMcpMessage>[1], projectId: string): Promise<ManagedProject> {
  const project = (await createProjectRegistryService(runtime.configPath).list()).find((candidate) => candidate.id === projectId);
  assert.ok(project);
  return project;
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

function startupRunnerManager(
  calls: string[],
  states: Record<string, RunnerProcessState>,
  startFailures = new Set<string>()
): RunnerManager {
  return {
    async start(project: ManagedProject) {
      calls.push(`start:${project.id}`);
      if (startFailures.has(project.id)) {
        throw new Error(`failed to start ${project.id}`);
      }
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
      return runnerStatus(project, states[project.id] ?? 'idle');
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

function runnerStatus(project: ManagedProject, state: RunnerProcessState) {
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

function registryYaml(projectIds: string[]): string {
  return [
    'version: 3',
    'projects:',
    ...projectIds.flatMap((projectId) => [
      `  - id: ${projectId}`,
      `    name: ${projectId}`,
      `    githubUrl: https://github.com/example/${projectId}.git`,
      '    workflow:',
      '      source: generated',
      '      template: default',
      '    codex:',
      '      threadSandbox: workspace-write',
      '      turnSandbox:',
      '        type: workspaceWrite',
      '        networkAccess: true'
    ]),
    ''
  ].join('\n');
}

function testLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function mockLinearClient(calls: Array<{ method: string; input: Record<string, unknown> }>, options: { duplicateProjectName?: string } = {}): LinearSdkClient {
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
    async project(id) {
      calls.push({ method: 'project', input: { id } });
      if (id === 'existing-project-id') {
        return {
          id: 'existing-project-id',
          name: 'Existing Project',
          slugId: '97e46de28c13',
          url: 'https://linear.example/project/existing-project-97e46de28c13',
          team: { id: 'linear-team-id', key: 'MRB', name: 'MRB' }
        };
      }
      if (id === 'linear-project-id') {
        return {
          id: 'linear-project-id',
          name: 'Meta Orchestrator',
          slugId: 'meta-orchestrator-slug',
          url: 'https://linear.example/project/meta-orchestrator-slug',
          team: { id: 'linear-team-id', key: 'MRB', name: 'MRB' }
        };
      }
      return undefined;
    },
    async createProject(input) {
      calls.push({ method: 'createProject', input });
      return { project: { id: 'project-id', name: String(input.name), slugId: '97e46de28c13', url: 'https://linear.example/project/dummy-project-97e46de28c13' } };
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
      return { issueRelation: { id: 'relation-1', type: 'blocks' } };
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
      return {
        nodes: [{
          id: 'linear-team-id',
          key: 'MRB',
          name: 'MRB',
          async projects(projectsInput) {
            calls.push({ method: 'team.projects', input: projectsInput ?? {} });
            if (projectsInput?.filter?.id?.eq === 'existing-project-id') {
              return {
                nodes: [{
                  id: 'existing-project-id',
                  name: 'Existing Project',
                  slugId: '97e46de28c13',
                  url: 'https://linear.example/project/existing-project-97e46de28c13'
                }]
              };
            }
            if (projectsInput?.filter?.id?.eq === 'linear-project-id') {
              return {
                nodes: [{
                  id: 'linear-project-id',
                  name: 'Meta Orchestrator',
                  slugId: 'meta-orchestrator-slug',
                  url: 'https://linear.example/project/meta-orchestrator-slug'
                }]
              };
            }
            if (projectsInput?.filter?.name?.eqIgnoreCase === 'Existing Name Project') {
              return {
                nodes: [{
                  id: 'existing-name-project-id',
                  name: 'Existing Name Project',
                  slugId: 'existing-name-project-slug',
                  url: 'https://linear.example/project/existing-name-project-slug'
                }]
              };
            }
            if (projectsInput?.filter?.name?.eqIgnoreCase === options.duplicateProjectName) {
              return {
                nodes: [
                  {
                    id: 'duplicate-project-1',
                    name: options.duplicateProjectName,
                    slugId: 'duplicate-project-1',
                    url: 'https://linear.example/project/duplicate-project-1'
                  },
                  {
                    id: 'duplicate-project-2',
                    name: options.duplicateProjectName,
                    slugId: 'duplicate-project-2',
                    url: 'https://linear.example/project/duplicate-project-2'
                  }
                ]
              };
            }
            return { nodes: [] };
          }
        }]
      };
    },
    async workflowStates(input) {
      calls.push({ method: 'workflowStates', input: input ?? {} });
      return { nodes: [{ id: 'state-backlog', name: 'Backlog', type: 'backlog' }] };
    }
  };
}
