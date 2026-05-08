import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { renderProjectWorkflow, validateProjectWorkflowSetup, writeProjectWorkflow } from '../src/index.ts';
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

    const workflow = await writeProjectWorkflow(managedProject({ repoPath, workspaceRoot, logsRoot }));
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
    assert.equal(parsed.frontMatter.codex.turn_sandbox_policy, 'workspace-write');
    assert.equal(parsed.frontMatter.custom.keep, true);
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

test('repo-owned workflow reports missing template path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb15-workflow-missing-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    const validation = await validateProjectWorkflowSetup(managedProject({ repoPath, workspaceRoot, logsRoot }));

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.workflow.errors[0]?.code, 'workflow_path_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation groups valid setup warnings by subsystem', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-valid-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', '-b', 'main', repoPath], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/example/repo.git'], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));

    const validation = await validateProjectWorkflowSetup(managedProject({ repoPath, workspaceRoot, logsRoot }));

    assert.equal(validation.ok, true);
    assert.equal(validation.subsystems.registry.ok, true);
    assert.equal(validation.subsystems.repo.ok, true);
    assert.equal(validation.subsystems.workflow.ok, true);
    assert.equal(validation.subsystems.runner.ok, true);
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

    const validation = await validateProjectWorkflowSetup(managedProject({ repoPath, workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs') }));

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

    const validation = await validateProjectWorkflowSetup(project, { validateLinear: true, env: { LINEAR_API_KEY: 'token' } });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.linear.errors[0]?.code, 'linear_project_slug_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation detects unavailable runner port', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb17-port-'));

  try {
    const project = managedProject({ repoPath: join(cwd, 'repo'), workspaceRoot: join(cwd, 'workspace'), logsRoot: join(cwd, 'logs'), runnerPort: 4310 });
    spawnSync('git', ['init', project.repo.path], { encoding: 'utf8' });
    writeFileSync(join(project.repo.path, 'WORKFLOW.md'), 'Prompt body.');

    const checkedPorts: number[] = [];
    const validation = await validateProjectWorkflowSetup(project, {
      portAvailable: async (port) => {
        checkedPorts.push(port);
        return false;
      }
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.runner.errors[0]?.code, 'runner_port_unavailable');
    assert.deepEqual(checkedPorts, [4310]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('operational validation detects missing runner command and read-only turn sandbox', async () => {
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
    project.codex.turnSandbox = 'read-only';

    const validation = await validateProjectWorkflowSetup(project);

    assert.equal(validation.ok, false);
    assert.equal(validation.subsystems.runner.errors[0]?.code, 'runner_command_missing');
    assert.equal(validation.subsystems.codexPolicy.errors[0]?.code, 'codex_turn_sandbox_missing');
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
