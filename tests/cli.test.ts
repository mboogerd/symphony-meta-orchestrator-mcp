import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
