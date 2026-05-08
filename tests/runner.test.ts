import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createRunnerManager } from '../src/index.ts';
import { managedProject, managedProjectYaml } from './project-fixtures.ts';

test('runner manager starts, reports, prevents duplicate starts, stops, and restarts one project process', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb10-runner-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: persistentNodeRunnerArgs()
    });

    const started = await manager.start(project);
    assert.equal(started.started, true);
    assert.equal(started.status.state, 'running');
    assert.equal(started.status.port, 4310);
    assert.equal(started.status.dashboardUrl, 'http://localhost:4310');
    assert.equal(started.status.workflowPath, join(workspacePath, 'WORKFLOW.md'));
    assert.equal(started.status.logPath, join(logsPath, 'meta-orchestrator.runner.log'));
    assert.equal(existsSync(started.status.statePath), true);
    assert.equal(existsSync(started.status.workflowPath), true);

    const duplicate = await manager.start(project);
    assert.equal(duplicate.started, false);
    assert.equal(duplicate.status.pid, started.status.pid);
    assert.match(duplicate.status.details.message, /already running/);

    const status = await manager.status(project);
    assert.equal(status.state, 'running');
    assert.equal(status.pid, started.status.pid);
    assert.equal(typeof status.latestHeartbeat, 'string');

    const stopped = await manager.stop(project);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pid, started.status.pid);

    const restarted = await manager.restart(project);
    assert.equal(restarted.started, true);
    assert.equal(restarted.status.state, 'running');
    assert.notEqual(restarted.status.pid, started.status.pid);

    await manager.stop(project);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner status returns idle details before a project has been started', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb10-runner-idle-'));

  try {
    const project = managedProject({
      repoPath: join(cwd, 'repo'),
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs')
    });
    const manager = createRunnerManager({ command: process.execPath, commandArgs: persistentNodeRunnerArgs() });

    const status = await manager.status(project);
    assert.equal(status.state, 'idle');
    assert.equal(status.port, 4310);
    assert.equal(status.dashboardUrl, 'http://localhost:4310');
    assert.equal(status.workflowPath, join(cwd, 'workspace', 'WORKFLOW.md'));
    assert.match(status.details.message, /No runner state file/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager tails bounded log lines', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb12-runner-logs-'));
  const logsPath = join(cwd, 'logs');

  try {
    const project = managedProject({
      repoPath: join(cwd, 'repo'),
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: logsPath
    });
    const manager = createRunnerManager({ command: process.execPath, commandArgs: persistentNodeRunnerArgs() });
    mkdirSync(logsPath, { recursive: true });
    writeFileSync(join(logsPath, 'meta-orchestrator.runner.log'), 'one\ntwo\nthree\n');

    const logs = await manager.tailLogs(project, 2);

    assert.deepEqual(logs.lines, ['two', 'three']);
    assert.equal(logs.lineCount, 3);
    assert.equal(logs.truncated, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function persistentNodeRunnerArgs(): string[] {
  return ['-e', 'setInterval(() => {}, 1000)', '--'];
}

test('runner manager builds exact Elixir Symphony CLI argv from structured registry fields', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb16-runner-command-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const installPath = join(cwd, 'symphony-install');
  const binPath = join(cwd, 'bin');
  const previousPath = process.env.PATH;
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), ['---', 'tracker:', '  kind: linear', '---', '', 'Prompt body.'].join('\n'));
    mkdirSync(installPath, { recursive: true });
    mkdirSync(binPath, { recursive: true });
    writeFileSync(join(binPath, 'mise'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binPath, 'mise'), 0o755);
    process.env.PATH = `${binPath}${delimiter}${previousPath ?? ''}`;
    const project = managedProject({
      repoPath,
      workspaceRoot: workspacePath,
      logsRoot: logsPath,
      command: 'mise',
      args: [
        'exec',
        '--',
        './bin/symphony',
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
      ],
      cwd: installPath
    });
    const manager = createRunnerManager({
      spawnProcess: ((command, args, options) => {
        calls.push({ command, args: args ?? [], cwd: options?.cwd?.toString() });
        return {
          pid: 12345,
          unref() {}
        };
      }) as never
    });

    const started = await manager.start(project);
    assert.equal(calls[0]?.command, 'mise');
    assert.deepEqual(calls[0]?.args, [
      'exec',
      '--',
      './bin/symphony',
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails',
      '--port',
      '4310',
      '--logs-root',
      logsPath,
      join(workspacePath, 'WORKFLOW.md')
    ]);
    assert.equal(calls[0]?.cwd, installPath);
    assert.equal(started.status.command, 'mise');
    assert.deepEqual(started.status.args, calls[0]?.args);
    assert.equal(started.status.cwd, installPath);
    assert.equal(started.status.workflowPath, join(workspacePath, 'WORKFLOW.md'));
    assert.equal(started.status.logPath, join(logsPath, 'meta-orchestrator.runner.log'));
  } finally {
    process.env.PATH = previousPath;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI runners:status reports runner lifecycle fields from the registry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb10-cli-runner-'));
  const configPath = join(cwd, 'registry.yaml');

  try {
    writeFileSync(configPath, managedProjectYaml(managedProject({
      repoPath: join(cwd, 'repo'),
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: join(cwd, 'logs')
    })));

    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'runners:status', '--config', configPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_LOG_LEVEL: 'silent' }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.runner.state, 'idle');
    assert.equal(output.runner.dashboardUrl, 'http://localhost:4310');
    assert.equal(output.runner.workflowPath, join(cwd, 'workspace', 'WORKFLOW.md'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
