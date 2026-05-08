import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('CLI health command returns JSON status', () => {
  const result = spawnSync(process.execPath, ['src/cli/index.ts', 'health'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
  });

  assert.equal(result.status, 0, result.stderr);
  const health = JSON.parse(result.stdout);
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'symphony-meta-orchestrator-mcp');
});

test('CLI version flag returns package version', () => {
  const result = spawnSync(process.execPath, ['src/cli/index.ts', '--version'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^0\.1\.0\n$/);
});

test('CLI projects:list reads managed projects from YAML registry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb8-cli-'));
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

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'projects:list', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.projects[0].linear.teamKey, 'MRB');
    assert.equal(output.projects[0].repo.path, '/tmp/meta-orchestrator');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI projects:validate fails with structured setup output for missing repo path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-cli-invalid-'));
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

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'projects:validate', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'invalid');
    assert.equal(output.setup[0].issues[0].code, 'repo_path_missing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI workflows:render writes project workflow with required handoff paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-cli-render-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const configPath = join(cwd, 'registry.yaml');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(configPath, [
      'version: 1',
      'projects:',
      '  - id: meta-orchestrator',
      '    name: Meta Orchestrator',
      '    linear:',
      '      teamKey: MRB',
      '      projectKey: META',
      '    repo:',
      `      path: ${repoPath}`,
      '    symphony:',
      `      workspacePath: ${workspacePath}`,
      `      logsPath: ${logsPath}`,
      '      mcpPort: 4100'
    ].join('\n'));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'workflows:render', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.workflow.projectId, 'meta-orchestrator');
    assert.match(output.workflow.content, /project_slug: "meta-orchestrator"/);
    assert.match(output.workflow.content, new RegExp(escapeRegExp(repoPath)));
    assert.match(output.workflow.content, new RegExp(escapeRegExp(workspacePath)));
    assert.match(output.workflow.content, new RegExp(escapeRegExp(logsPath)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
