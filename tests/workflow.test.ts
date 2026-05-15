import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { renderProjectWorkflow, validateProjectWorkflowSetup, writeProjectWorkflow } from '../src/index.ts';
import type { WorkflowSetupValidationOptions } from '../src/services/workflow/index.ts';
import { managedProject } from './project-fixtures.ts';

test('repo-owned workflow preserves prompt body and injects runtime front matter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb15-workflow-repo-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  kind: github',
      '  project_slug: stale',
      'workspace:',
      '  root: /tmp/stale',
      'custom:',
      '  keep: true',
      '---',
      '',
      'Prompt line one.',
      'Prompt line two.'
    ].join('\n'));

    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    const workflow = await writeProjectWorkflow(project, mockRepoWorkflowOptions(project));
    const parsed = parseWorkflow(workflow.content);

    assert.equal(workflow.workflowPath, join(workspaceRoot, 'WORKFLOW.md'));
    assert.equal(existsSync(join(repoPath, 'WORKFLOW.md')), true);
    assert.equal(parsed.body, 'Prompt line one.\nPrompt line two.');
    assert.equal(parsed.frontMatter.tracker.kind, 'linear');
    assert.equal(parsed.frontMatter.tracker.project_slug, 'meta-orchestrator');
    assert.deepEqual(parsed.frontMatter.tracker.active_states, ['Todo', 'In Progress', 'In Review']);
    assert.deepEqual(parsed.frontMatter.tracker.terminal_states, ['Done', 'Duplicate', 'Canceled', 'Cancelled', 'Closed']);
    assert.equal(parsed.frontMatter.workspace.root, workspaceRoot);
    assert.equal(parsed.frontMatter.hooks.after_create, 'git clone git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git .');
    assert.equal(parsed.frontMatter.hooks.before_remove, 'true');
    assert.equal(parsed.frontMatter.agent.max_concurrent_agents, 10);
    assert.equal(parsed.frontMatter.agent.max_turns, 20);
    assert.equal(parsed.frontMatter.codex.approval_policy, 'never');
    assert.equal(parsed.frontMatter.codex.thread_sandbox, 'workspace-write');
    assert.deepEqual(parsed.frontMatter.codex.turn_sandbox_policy, {
      type: 'workspaceWrite',
      networkAccess: true
    });
    assert.equal(parsed.frontMatter.custom.keep, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow front matter uses Linear project slug when it differs from registry id', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb139-workflow-slug-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');

    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    project.id = 'dummy';
    project.tracker.projectSlug = 'dummy-bc9511ed1883';

    const workflow = await writeProjectWorkflow(project, mockRepoWorkflowOptions(project));
    const parsed = parseWorkflow(workflow.content);

    assert.equal(parsed.frontMatter.tracker.project_slug, 'dummy-bc9511ed1883');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeProjectWorkflow renders when runner port is occupied', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb24-workflow-port-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');
  const runnerPort = 45_110 + Math.trunc(Math.random() * 1000);
  const server = createServer();

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(runnerPort, '127.0.0.1', resolvePromise);
    });
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');

    const project = managedProject({ repoPath, workspaceRoot, logsRoot, runnerPort });
    const workflow = await writeProjectWorkflow(project, mockRepoWorkflowOptions(project));

    assert.equal(workflow.workflowPath, join(workspaceRoot, 'WORKFLOW.md'));
    assert.equal(existsSync(workflow.workflowPath), true);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeProjectWorkflow bootstraps missing repo-owned workflow path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb79-workflow-bootstrap-'));
  const repoPath = join(cwd, 'repo');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });

    const project = managedProject({ repoPath, workspaceRoot: repoPath, logsRoot });
    const workflow = await writeProjectWorkflow(project, mockRepoWorkflowOptions(project));
    const parsed = parseWorkflow(workflow.content);

    assert.equal(workflow.workflowPath, join(repoPath, 'WORKFLOW.md'));
    assert.equal(existsSync(workflow.workflowPath), true);
    assert.equal(parsed.frontMatter.tracker.kind, 'linear');
    assert.equal(parsed.frontMatter.workspace.root, repoPath);
    assert.match(parsed.body, /You are working on a Linear ticket/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow safely quotes clone sources and targets in generated hook commands', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb25-workflow-quote-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot });
    project.repo.cloneSource = "https://example.test/repos/name with spaces'and-quotes.git?x=$(touch bad)";
    project.workflow.runtime = {
      hooks: {
        afterCreate: {
          type: 'gitClone',
          target: 'repo dir'
        }
      }
    };

    const parsed = parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content);

    assert.equal(
      parsed.frontMatter.hooks.after_create,
      'git clone \'https://example.test/repos/name with spaces\'"\'"\'and-quotes.git?x=$(touch bad)\' \'repo dir\''
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow renders custom tracker, agent, Codex command, and hook settings', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb25-workflow-runtime-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), [
      '---',
      'tracker:',
      '  active_states:',
      '    - Stale',
      'agent:',
      '  max_turns: 1',
      'codex:',
      '  command: stale',
      '---',
      '',
      'Repo prompt body.'
    ].join('\n'));
    const project = managedProject({ repoPath, workspaceRoot });
    project.workflow.runtime = {
      tracker: {
        activeStates: ['Queued', 'Executing'],
        terminalStates: ['Shipped', 'Abandoned']
      },
      agent: {
        maxConcurrentAgents: 3,
        maxTurns: 7
      },
      codex: {
        command: 'codex --profile nightly app-server',
        approvalPolicy: 'on-request'
      },
      hooks: {
        afterCreate: { type: 'none' },
        beforeRemove: 'rm -rf .cache'
      }
    };

    const parsed = parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content);

    assert.equal(parsed.body, 'Repo prompt body.');
    assert.deepEqual(parsed.frontMatter.tracker.active_states, ['Queued', 'Executing']);
    assert.deepEqual(parsed.frontMatter.tracker.terminal_states, ['Shipped', 'Abandoned']);
    assert.equal(parsed.frontMatter.agent.max_concurrent_agents, 3);
    assert.equal(parsed.frontMatter.agent.max_turns, 7);
    assert.equal(parsed.frontMatter.codex.command, 'codex --profile nightly app-server');
    assert.equal(parsed.frontMatter.codex.approval_policy, 'on-request');
    assert.equal(parsed.frontMatter.hooks.after_create, 'true');
    assert.equal(parsed.frontMatter.hooks.before_remove, 'rm -rf .cache');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('generated workflow renders valid Symphony front matter and prompt body', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb15-workflow-generated-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    project.workflow = { source: 'generated', template: 'default' };

    const workflow = await renderProjectWorkflow(project);
    const parsed = parseWorkflow(workflow.content);

    assert.equal(workflow.workflowPath, join(workspaceRoot, 'WORKFLOW.md'));
    assert.equal(parsed.frontMatter.tracker.kind, 'linear');
    assert.equal(parsed.frontMatter.workspace.root, workspaceRoot);
    assert.equal(parsed.frontMatter.hooks.after_create, 'git clone git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git .');
    assert.match(parsed.body, /You are working on a Linear ticket/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('generated workflow clones the registered githubUrl into the workspace root', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb121-workflow-github-url-'));
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');
  const githubUrl = 'https://github.com/org/repo.git';

  try {
    const project = {
      id: 'github-url-project',
      name: 'GitHub URL Project',
      githubUrl,
      workflow: { source: 'generated', template: 'default' },
      codex: {
        threadSandbox: 'workspace-write',
        turnSandbox: { type: 'workspaceWrite', networkAccess: true }
      }
    } as const;
    Object.defineProperty(project, 'symphony', {
      enumerable: false,
      value: { workspaceRoot, logsRoot }
    });

    const parsed = parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content);

    assert.equal(parsed.frontMatter.hooks.after_create, `git clone ${githubUrl} .`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('generated workflow validation does not require repo path to exist', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb80-generated-missing-repo-'));
  const repoPath = join(cwd, 'missing-repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    project.workflow = { source: 'generated', template: 'default' };

    const validation = await validateProjectWorkflowSetup(project);

    assert.equal(validation.ok, true);
    assert.equal(existsSync(repoPath), false);
    assert.deepEqual(validation.subsystems.repo.errors, []);
    assert.ok(validation.workflow);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('repo-owned workflow falls back when template path is missing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb15-workflow-missing-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    const validation = await validateProjectWorkflowSetup(project, mockRepoWorkflowOptions(project));

    assert.equal(validation.ok, true);
    assert.match(validation.workflow?.content ?? '', /You are working on a Linear ticket/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace validation groups valid setup warnings by subsystem and phase', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-valid-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/example/repo.git'], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));

    const project = managedProject({ repoPath, workspaceRoot, logsRoot });
    const validation = await validateProjectWorkflowSetup(project, mockRepoWorkflowOptions(project));

    assert.equal(validation.ok, true);
    assert.equal(validation.phase, 'workspace');
    assert.equal(validation.subsystems.registry.ok, true);
    assert.equal(validation.subsystems.repo.ok, true);
    assert.equal(validation.subsystems.workflow.ok, true);
    assert.equal(validation.subsystems.runner.ok, true);
    assert.equal(validation.phases.workspace.ok, true);
    assert.equal(validation.phases.live.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation detects invalid workflow front matter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-invalid-workflow-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', '- nope', '---', '', 'Prompt body.'].join('\n'));

    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });
    const validation = await validateProjectWorkflowSetup(project, mockRepoWorkflowOptions(project));

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.workflow.errors[0]?.code, 'workflow_render_failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation requires Linear slug when Linear validation is requested', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-linear-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });
    project.tracker.projectSlug = '';

    const validation = await validateProjectWorkflowSetup(project, { validateLinear: true, env: { LINEAR_API_KEY: 'token' }, ...mockRepoWorkflowOptions(project) });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.linear.errors[0]?.code, 'linear_project_slug_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation rejects unresolved Linear project slug', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb129-linear-unresolved-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ id: 'dummy', repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });
    project.tracker.projectId = 'linear-project-id';
    project.tracker.projectSlug = 'dummy';

    const validation = await validateProjectWorkflowSetup(project, {
      validateLinear: true,
      env: { LINEAR_API_KEY: 'token' },
      linear: { resolveProjectSlug: async () => undefined },
      ...mockRepoWorkflowOptions(project)
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.linear.errors[0]?.code, 'linear_project_not_found');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation accepts a resolved Linear project slug', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb129-linear-resolved-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });

    const validation = await validateProjectWorkflowSetup(project, {
      validateLinear: true,
      env: { LINEAR_API_KEY: 'token' },
      linear: {
        resolveProjectSlug: async (projectSlug) => ({
          id: 'linear-project-id',
          name: 'Meta Orchestrator',
          slugId: projectSlug,
          url: `https://linear.example/project/${projectSlug}`,
          teamId: 'linear-team-id'
        })
      },
      ...mockRepoWorkflowOptions(project)
    });

    assert.equal(validation.subsystems.linear.ok, true);
    assert.deepEqual(validation.subsystems.linear.errors, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('render validation skips live runner port checks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb24-render-phase-'));

  try {
    const project = managedProject({ repoPath: join(cwd, 'repo'), workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs'), runnerPort: 4310 });
    spawnSync('git', ['init', project.repo.path], { encoding: 'utf8' });
    writeFileSync(join(project.repo.path, 'WORKFLOW.md'), 'Prompt body.');

    const checkedPorts: number[] = [];
    const validation = await validateProjectWorkflowSetup(project, {
      phase: 'render',
      ...mockRepoWorkflowOptions(project),
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return false;
      }
    });

    assert.equal(validation.ok, true);
    assert.equal(validation.phase, 'render');
    assert.deepEqual(validation.subsystems.runner.errors, []);
    assert.deepEqual(checkedPorts, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live validation ignores unavailable project runnerPort when using dynamic allocation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-port-'));

  try {
    const project = managedProject({ repoPath: join(cwd, 'repo'), workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs'), runnerPort: 4310 });
    spawnSync('git', ['init', project.repo.path], { encoding: 'utf8' });
    writeFileSync(join(project.repo.path, 'WORKFLOW.md'), 'Prompt body.');

    const checkedPorts: number[] = [];
    const validation = await validateProjectWorkflowSetup(project, {
      phase: 'live',
      ...mockRepoWorkflowOptions(project),
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return false;
      }
    });

    assert.equal(validation.ok, true);
    assert.equal(validation.phase, 'live');
    assert.deepEqual(validation.subsystems.runner.errors, []);
    assert.deepEqual(validation.phases.live.errors, []);
    assert.deepEqual(checkedPorts, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live validation still detects unavailable explicit environment runner port', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb128-env-port-'));
  const previousRunnerPort = process.env.SYMPHONY_RUNNER_PORT;

  try {
    const project = managedProject({ repoPath: join(cwd, 'repo'), workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });
    spawnSync('git', ['init', project.repo.path], { encoding: 'utf8' });
    writeFileSync(join(project.repo.path, 'WORKFLOW.md'), 'Prompt body.');
    process.env.SYMPHONY_RUNNER_PORT = '4310';

    const checkedPorts: number[] = [];
    const validation = await validateProjectWorkflowSetup(project, {
      phase: 'live',
      ...mockRepoWorkflowOptions(project),
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return false;
      }
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.phase, 'live');
    assert.equal(validation.subsystems.runner.errors[0]?.code, 'runner_port_unavailable');
    assert.equal(validation.phases.live.errors[0]?.code, 'runner_port_unavailable');
    assert.deepEqual(checkedPorts, [4310]);
  } finally {
    if (previousRunnerPort === undefined) {
      delete process.env.SYMPHONY_RUNNER_PORT;
    } else {
      process.env.SYMPHONY_RUNNER_PORT = previousRunnerPort;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live validation warns when runner command exits during compatibility probe', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb115-runner-probe-'));
  const repoPath = join(cwd, 'repo');
  const runnerPort = 42_110 + Math.trunc(Math.random() * 1000);

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({
      repoPath,
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs'),
      runnerPort,
      command: process.execPath,
      args: ['--i-understand-that-this-will-be-running-without-the-usual-guardrails', '--port', String(runnerPort)]
    });

    const validation = await validateProjectWorkflowSetup(project, { phase: 'live', ...mockRepoWorkflowOptions(project) });

    assert.equal(validation.ok, true);
    assert.equal(validation.subsystems.runner.ok, true);
    assert.equal(validation.subsystems.runner.errors.length, 0);
    assert.equal(validation.subsystems.runner.warnings[0]?.code, 'runner_command_probe_failed');
    assert.equal(validation.phases.live.warnings[0]?.code, 'runner_command_probe_failed');
    assert.match(validation.subsystems.runner.warnings[0]?.message ?? '', /bad option: --i-understand-that-this-will-be-running-without-the-usual-guardrails/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live validation detects missing runner command and render validation detects read-only turn sandbox', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-command-policy-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Use git and GitHub.');
    const project = managedProject({
      repoPath,
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs'),
      command: 'definitely-missing-symphony-runner'
    });
    project.codex.turnSandbox = { type: 'readOnly' };

    const validation = await validateProjectWorkflowSetup(project, { phase: 'live', ...mockRepoWorkflowOptions(project) });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.runner.errors[0]?.code, 'runner_command_missing');
    assert.equal(validation.subsystems.codexPolicy.errors[0]?.code, 'codex_turn_sandbox_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow renders network-enabled workspace-write and danger-full-access turn policies', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb23-workflow-policy-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot });

    project.codex.turnSandbox = {
      type: 'workspaceWrite',
      networkAccess: true,
      writableRoots: ['/tmp/cache']
    };
    assert.deepEqual(parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content).frontMatter.codex.turn_sandbox_policy, {
      type: 'workspaceWrite',
      networkAccess: true,
      writableRoots: ['/tmp/cache']
    });

    project.codex.threadSandbox = 'danger-full-access';
    project.codex.turnSandbox = { type: 'dangerFullAccess' };
    assert.deepEqual(parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content).frontMatter.codex.turn_sandbox_policy, {
      type: 'dangerFullAccess'
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation requires network access for git and GitHub workflows', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb23-policy-network-'));
  const repoPath = join(cwd, 'repo');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Use git and GitHub.');
    const project = managedProject({
      repoPath,
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs')
    });
    project.codex.turnSandbox = { type: 'workspaceWrite' };

    const validation = await validateProjectWorkflowSetup(project, mockRepoWorkflowOptions(project));

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.codexPolicy.errors[0]?.field, 'codex.turnSandbox.networkAccess');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('uses fetched repo WORKFLOW.md when present', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-repo-workflow-'));
  const repoPath = join(cwd, 'repo');
  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Fetched repo prompt.');
    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });

    const parsed = parseWorkflow((await renderProjectWorkflow(project, mockRepoWorkflowOptions(project))).content);

    assert.equal(parsed.body, 'Fetched repo prompt.');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('falls back to Symphony shipped default when repo file absent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-shipped-workflow-'));
  const repoPath = join(cwd, 'repo');
  const installDir = join(cwd, 'symphony');
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    mkdirSync(join(installDir, 'elixir'), { recursive: true });
    writeFileSync(join(installDir, 'elixir', 'WORKFLOW.md'), 'Shipped default prompt.');
    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });

    const parsed = parseWorkflow((await renderProjectWorkflow(project, {
      ...mockRepoWorkflowOptions(project),
      env: { SYMPHONY_RUNNER_INSTALL_DIR: installDir },
      logger: captureInfo(logs)
    })).content);

    assert.equal(parsed.body, 'Shipped default prompt.');
    assert.equal(logs.some((entry) => entry.fields?.source === 'repo'), true);
    assert.equal(logs.some((entry) => entry.fields?.source === 'symphony_shipped_default'), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('falls back to built-in default when neither source available', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-builtin-workflow-'));
  const repoPath = join(cwd, 'repo');
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    const project = managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') });

    const parsed = parseWorkflow((await renderProjectWorkflow(project, {
      ...mockRepoWorkflowOptions(project),
      env: { SYMPHONY_RUNNER_INSTALL_DIR: join(cwd, 'missing-symphony') },
      logger: captureInfo(logs)
    })).content);

    assert.match(parsed.body, /You are working on a Linear ticket/);
    assert.equal(logs.some((entry) => entry.fields?.source === 'built_in_default'), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('records workflow_fetch_auth_required on 401', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-auth-workflow-'));
  try {
    const project = repoProjectWithoutLocalPath(cwd);
    const validation = await validateProjectWorkflowSetup(project, {
      fetch: async () => new Response('{}', { status: 401 }),
      sparseCloneWorkflowFile: async () => 'unused'
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.workflow.errors[0]?.code, 'workflow_fetch_auth_required');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('records workflow_fetch_failed on clone error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-clone-workflow-'));
  try {
    const project = repoProjectWithoutLocalPath(cwd);
    const validation = await validateProjectWorkflowSetup(project, {
      fetch: async () => Response.json({ default_branch: 'main' }),
      sparseCloneWorkflowFile: async () => {
        throw new Error('clone failed');
      }
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.workflow.errors[0]?.code, 'workflow_fetch_failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('defaults workflow.path to WORKFLOW.md when omitted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb124-default-path-'));
  const seenPaths: string[] = [];
  try {
    const project = repoProjectWithoutLocalPath(cwd);
    project.workflow = { source: 'repo' } as ManagedProject['workflow'];

    const parsed = parseWorkflow((await renderProjectWorkflow(project, {
      fetch: async () => Response.json({ default_branch: 'main' }),
      sparseCloneWorkflowFile: async (_githubUrl, workflowPath) => {
        seenPaths.push(workflowPath);
        return 'Default path prompt.';
      },
      logger: captureInfo([])
    })).content);

    assert.equal(parsed.body, 'Default path prompt.');
    assert.deepEqual(seenPaths, ['WORKFLOW.md']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function parseWorkflow(content: string): { frontMatter: Record<string, any>; body: string } {
  assert.match(content, /^---\n/);
  const endIndex = content.indexOf('\n---\n', 4);
  assert.notEqual(endIndex, -1);
  return {
    frontMatter: YAML.parse(content.slice(4, endIndex)) as Record<string, any>,
    body: content.slice(endIndex + '\n---\n'.length).trim()
  };
}

function mockRepoWorkflowOptions(project: ManagedProject, seenPaths: string[] = []): WorkflowSetupValidationOptions {
  return {
    fetch: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, undefined);
      return Response.json({ default_branch: 'main' });
    },
    sparseCloneWorkflowFile: async (_githubUrl, workflowPath) => {
      seenPaths.push(workflowPath);
      return readFileSync(join((project as ManagedProject & { repo?: { path?: string } }).repo?.path ?? '', workflowPath), 'utf8');
    },
    logger: captureInfo([])
  };
}

function repoProjectWithoutLocalPath(cwd: string): ManagedProject {
  const project = {
    id: 'meta-orchestrator',
    name: 'Meta Orchestrator',
    githubUrl: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
    workflow: { source: 'repo', path: 'WORKFLOW.md' },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: { type: 'workspaceWrite', networkAccess: true }
    }
  } as ManagedProject;
  Object.defineProperty(project, 'symphony', {
    enumerable: false,
    value: { workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') }
  });
  return project;
}

function captureInfo(entries: Array<{ message: string; fields?: Record<string, unknown> }>): WorkflowSetupValidationOptions['logger'] {
  return {
    info: (message, fields) => entries.push({ message, fields })
  };
}
