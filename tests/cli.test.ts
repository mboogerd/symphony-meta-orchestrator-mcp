import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { managedProject, managedProjectYaml } from './project-fixtures.ts';

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
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: '/tmp/meta-orchestrator',
      workspaceRoot: '/tmp/workspaces/meta-orchestrator'
    })));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'projects:list', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.projects[0].tracker.teamKey, 'MRB');
    assert.equal(output.projects[0].repo.path, '/tmp/meta-orchestrator');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI projects list reads managed projects from YAML registry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb13-cli-projects-list-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: '/tmp/meta-orchestrator',
      workspaceRoot: '/tmp/workspaces/meta-orchestrator'
    })));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'projects', 'list', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.projects[0].id, 'meta-orchestrator');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI projects:validate fails with structured setup output for missing repo path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-cli-invalid-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: join(cwd, 'missing-repo'),
      workspaceRoot: join(cwd, 'workspace')
    })));

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

test('CLI project validate fails with structured setup output for missing repo path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb13-cli-project-invalid-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: join(cwd, 'missing-repo'),
      workspaceRoot: join(cwd, 'workspace')
    })));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'project', 'validate', '--config', configPath], {
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

test('CLI workflows:render writes project workflow with required runtime front matter', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb9-cli-render-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const configPath = join(cwd, 'registry.yaml');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    writeFileSync(configPath, managedProjectYaml(managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath })));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'workflows:render', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.workflow.projectId, 'meta-orchestrator');
    assert.equal(output.workflow.workflowPath, join(workspacePath, 'WORKFLOW.md'));
    const frontMatter = parseWorkflowFrontMatter(output.workflow.content);
    assert.equal(frontMatter.tracker.project_slug, 'meta-orchestrator');
    assert.equal(frontMatter.workspace.root, workspacePath);
    assert.equal(frontMatter.hooks.after_create, 'git clone git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git .');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI workflow render then project validate covers local registry smoke path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb13-cli-render-validate-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const configPath = join(cwd, 'registry.yaml');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    writeFileSync(configPath, managedProjectYaml(managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath })));

    const render = spawnSync(process.execPath, ['src/cli/index.ts', 'workflow', 'render', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });
    assert.equal(render.status, 0, render.stderr);

    const validate = spawnSync(process.execPath, ['src/cli/index.ts', 'project', 'validate', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).status, 'ok');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI project validate defaults to workspace phase and --live reports runner failures', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb24-cli-live-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const configPath = join(cwd, 'registry.yaml');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath,
      workspaceRoot: workspacePath,
      logsRoot: logsPath,
      command: 'definitely-missing-symphony-runner'
    })));

    const env = { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' };
    const workspace = spawnSync(process.execPath, ['src/cli/index.ts', 'project', 'validate', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(workspace.status, 0, workspace.stderr);
    assert.equal(JSON.parse(workspace.stdout).setup[0].phase, 'workspace');

    const live = spawnSync(process.execPath, ['src/cli/index.ts', 'project', 'validate', '--live', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(live.status, 1);
    const output = JSON.parse(live.stdout);
    assert.equal(output.setup[0].phase, 'live');
    assert.equal(output.setup[0].issues[0].code, 'runner_command_missing');
    assert.equal(output.setup[0].issues[0].phase, 'live');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI runner start status stop covers local runner smoke path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb13-cli-runner-'));
  const repoPath = join(cwd, 'repo');
  const runnerPath = join(cwd, 'fake-runner.js');
  const configPath = join(cwd, 'registry.yaml');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    writeFileSync(runnerPath, [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      'const args = process.argv.slice(2);',
      "const port = Number(args[args.indexOf('--port') + 1]);",
      'const workflowPath = args.at(-1);',
      "http.createServer((req, res) => {",
      "  res.setHeader('content-type', 'application/json');",
      "  res.end(JSON.stringify({ projectId: 'meta-orchestrator', workflowPath, state: 'ready' }));",
      "}).listen(port, '127.0.0.1');",
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    chmodSync(runnerPath, 0o755);
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath,
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs'),
      command: runnerPath
    })));

    const env = { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' };
    const start = spawnSync(process.execPath, ['src/cli/index.ts', 'runner', 'start', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(start.status, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).runner.status.state, 'running');

    const status = spawnSync(process.execPath, ['src/cli/index.ts', 'runner', 'status', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).runner.state, 'running');

    const stop = spawnSync(process.execPath, ['src/cli/index.ts', 'runner', 'stop', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).runner.state, 'stopped');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function parseWorkflowFrontMatter(content: string): Record<string, any> {
  const endIndex = content.indexOf('\n---\n', 4);
  assert.notEqual(endIndex, -1);
  return YAML.parse(content.slice(4, endIndex)) as Record<string, any>;
}
