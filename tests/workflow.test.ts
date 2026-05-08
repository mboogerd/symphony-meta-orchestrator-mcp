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

test('repo-owned workflow reports missing template path as render failure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb15-workflow-missing-'));
  const repoPath = join(cwd, 'repo');
  const workspaceRoot = join(cwd, 'workspace');
  const logsRoot = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    const validation = await validateProjectWorkflowSetup(managedProject({ repoPath, workspaceRoot, logsRoot }));

    assert.equal(validation.ok, false);
    assert.equal(validation.issues[0]?.code, 'workflow_render_failed');
    assert.match(validation.issues[0]?.message ?? '', /ENOENT/);
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
