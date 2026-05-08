import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeConfig, parseDotEnv } from '../src/index.ts';

test('parseDotEnv handles comments and quoted values', () => {
  assert.deepEqual(parseDotEnv([
    '# comment',
    'SYMPHONY_LOG_LEVEL=debug',
    'PLAIN=value # trailing comment',
    'QUOTED="two words"',
    "SINGLE='literal value'"
  ].join('\n')), {
    SYMPHONY_LOG_LEVEL: 'debug',
    PLAIN: 'value',
    QUOTED: 'two words',
    SINGLE: 'literal value'
  });
});

test('createRuntimeConfig loads .env and resolves config path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb7-config-'));
  const env: Record<string, string | undefined> = {};

  try {
    writeFileSync(join(cwd, '.env'), 'SYMPHONY_CONFIG_PATH=custom.json\nSYMPHONY_LOG_LEVEL=debug\n');
    writeFileSync(join(cwd, 'custom.json'), '{}\n');

    const runtime = createRuntimeConfig({ cwd, env, argv: [] });

    assert.equal(runtime.logLevel, 'debug');
    assert.equal(runtime.envFile.loaded, true);
    assert.equal(runtime.configPath, join(cwd, 'custom.json'));
    assert.equal(runtime.configExists, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
