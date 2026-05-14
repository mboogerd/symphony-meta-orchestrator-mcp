import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
    const runnerPort = 46_010 + Math.trunc(Math.random() * 1000);
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: readyNodeRunnerArgs(project.id),
      readinessPollIntervalMs: 10
    });

    const started = await manager.start(project);
    assert.equal(started.started, true);
    assert.equal(started.status.state, 'running');
    assert.equal(started.status.port, runnerPort);
    assert.equal(started.status.dashboardUrl, `http://localhost:${runnerPort}`);
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
    const manager = createRunnerManager({ command: process.execPath, commandArgs: readyNodeRunnerArgs('meta-orchestrator') });

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

test('runner status clears stale state for a missing process before returning registry details', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb90-runner-stale-state-'));
  const logsPath = join(cwd, 'logs');

  try {
    mkdirSync(logsPath, { recursive: true });
    const project = managedProject({
      repoPath: join(cwd, 'repo'),
      workspaceRoot: join(cwd, 'workspace'),
      logsRoot: logsPath,
      command: 'node',
      args: ['current']
    });
    const statePath = join(logsPath, `${project.id}.runner.json`);
    writeFileSync(statePath, JSON.stringify({
      projectId: project.id,
      pid: 1012,
      command: 'mise',
      args: ['old'],
      cwd: '/tmp/old',
      workflowPath: '/tmp/old/WORKFLOW.md',
      logPath: '/tmp/old/runner.log',
      startedAt: '2024-01-01T00:00:00.000Z',
      latestHeartbeat: '2024-01-01T00:00:00.000Z'
    }));
    const manager = createRunnerManager({
      now: () => new Date('2026-05-14T00:00:00.000Z'),
      isProcessAlive: () => false
    });

    const status = await manager.status(project);

    assert.equal(status.state, 'idle');
    assert.equal(status.command, 'node');
    assert.deepEqual(status.args, ['current']);
    assert.equal(status.pid, undefined);
    assert.equal(status.latestHeartbeat, undefined);
    assert.match(status.details.message, /Removed stale runner state/);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager start reports invalid setup when runner port is occupied', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb24-runner-port-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const runnerPort = 46_110 + Math.trunc(Math.random() * 1000);
  const server = createServer();

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(runnerPort, '127.0.0.1', resolvePromise);
    });
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');

    const manager = createRunnerManager({ command: process.execPath, commandArgs: readyNodeRunnerArgs('meta-orchestrator') });
    const result = await manager.start(managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort }));

    assert.equal(result.started, false);
    assert.equal(result.status.state, 'invalid');
    assert.match(result.status.details.message, /Runner port .* is already in use/);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager start reports readiness timeout with log path and excerpt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb26-runner-timeout-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort: 47_010 + Math.trunc(Math.random() * 1000) });
    mkdirSync(logsPath, { recursive: true });
    writeFileSync(join(logsPath, `${project.id}.runner.log`), 'waiting for dashboard\n');
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: persistentNodeRunnerArgs(),
      readinessTimeoutMs: 75,
      readinessPollIntervalMs: 5,
      readinessCheck: async () => ({ ready: false, state: 'not_ready', message: 'mock dashboard unavailable' })
    });

    const started = await manager.start(project);

    assert.equal(started.started, false);
    assert.equal(started.status.state, 'unhealthy');
    assert.equal(started.status.details.readiness, 'timeout');
    assert.match(started.status.details.message, /timed out/);
    assert.match(started.status.details.message, new RegExp(project.id));
    assert.ok(started.status.details.logExcerpt?.includes('waiting for dashboard'));
    await manager.stop(project);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager start reports early process exit with recent logs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb26-runner-exit-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort: 48_010 + Math.trunc(Math.random() * 1000) });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: ['-e', "console.error('startup failed: bad config'); process.exit(42)", '--'],
      readinessTimeoutMs: 500,
      readinessPollIntervalMs: 10
    });

    const started = await manager.start(project);

    assert.equal(started.started, false);
    assert.equal(started.status.state, 'unhealthy');
    assert.equal(started.status.details.readiness, 'exited');
    assert.match(started.status.details.message, /exited before readiness/);
    assert.deepEqual(started.status.details.logExcerpt, ['startup failed: bad config']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager status reports unhealthy when process exists but service is not ready', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb26-runner-unhealthy-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  let ready = true;

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort: 49_010 + Math.trunc(Math.random() * 1000) });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: persistentNodeRunnerArgs(),
      readinessTimeoutMs: 50,
      readinessPollIntervalMs: 5,
      readinessCheck: async () => ready
        ? { ready: true, state: 'ready', message: 'mock service ready' }
        : { ready: false, state: 'not_ready', message: 'mock service stopped responding' }
    });

    const started = await manager.start(project);
    assert.equal(started.status.state, 'running');

    ready = false;
    const status = await manager.status(project);
    assert.equal(status.state, 'unhealthy');
    assert.equal(status.details.readiness, 'not_ready');
    assert.match(status.details.message, /stopped responding/);
    await manager.stop(project);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager reports wrong workflow readiness signal', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb26-runner-wrong-workflow-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort: 50_010 + Math.trunc(Math.random() * 1000) });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: persistentNodeRunnerArgs(),
      readinessTimeoutMs: 25,
      readinessPollIntervalMs: 5,
      readinessCheck: async () => ({ ready: false, state: 'wrong_workflow', message: 'Runner is serving workflow "/tmp/other", expected rendered workflow' })
    });

    const started = await manager.start(project);

    assert.equal(started.status.state, 'unhealthy');
    assert.equal(started.status.details.readiness, 'wrong_workflow');
    assert.match(started.status.details.message, /wrong_workflow|serving workflow/);
    await manager.stop(project);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner manager reports wrong project readiness signal', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb26-runner-wrong-project-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');

  try {
    spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    writeFileSync(join(repoPath, 'WORKFLOW.md'), 'Prompt body.');
    const project = managedProject({ repoPath, workspaceRoot: workspacePath, logsRoot: logsPath, runnerPort: 52_010 + Math.trunc(Math.random() * 1000) });
    const manager = createRunnerManager({
      command: process.execPath,
      commandArgs: persistentNodeRunnerArgs(),
      readinessTimeoutMs: 25,
      readinessPollIntervalMs: 5,
      readinessCheck: async () => ({ ready: false, state: 'wrong_project', message: 'Runner is serving project "other-project", expected "meta-orchestrator"' })
    });

    const started = await manager.start(project);

    assert.equal(started.status.state, 'unhealthy');
    assert.equal(started.status.details.readiness, 'wrong_project');
    assert.match(started.status.details.message, /serving project/);
    await manager.stop(project);
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

function persistentNodeRunnerArgs(startupCode = ''): string[] {
  return ['-e', `${startupCode}; setInterval(() => {}, 1000)`, '--'];
}

function readyNodeRunnerArgs(projectId: string): string[] {
  return ['-e', [
    "const http = require('node:http');",
    "const args = process.argv.slice(1);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "const workflowPath = args.at(-1);",
    "http.createServer((req, res) => {",
    "  res.setHeader('content-type', 'application/json');",
    `  res.end(JSON.stringify({ projectId: ${JSON.stringify(projectId)}, workflowPath, state: 'ready' }));`,
    "}).listen(port, '127.0.0.1');",
    "setInterval(() => {}, 1000);"
  ].join(''), '--'];
}

test('runner manager builds exact Elixir Symphony CLI argv from structured registry fields', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb16-runner-command-'));
  const repoPath = join(cwd, 'repo');
  const workspacePath = join(cwd, 'workspace');
  const logsPath = join(cwd, 'logs');
  const installPath = join(cwd, 'symphony-install');
  const binPath = join(cwd, 'bin');
  const runnerPort = 51_010 + Math.trunc(Math.random() * 1000);
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
      cwd: installPath,
      runnerPort
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
      String(runnerPort),
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
