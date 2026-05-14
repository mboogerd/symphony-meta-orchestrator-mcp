import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

test('createRuntimeConfig defaults to YAML registry config path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb99-config-default-'));

  try {
    const runtime = createRuntimeConfig({ cwd, env: {}, argv: [] });

    assert.equal(runtime.configPath, join(homedir(), '.config', 'symphony-meta-orchestrator', 'registry.yaml'));
    assert.equal(runtime.configExists, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('createRuntimeConfig SYMPHONY_CONFIG_PATH env var overrides the XDG default', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb99-config-env-'));

  try {
    const runtime = createRuntimeConfig({
      cwd,
      env: { SYMPHONY_CONFIG_PATH: join(cwd, 'custom.yaml') },
      argv: []
    });

    assert.equal(runtime.configPath, join(cwd, 'custom.yaml'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('createRuntimeConfig --config argv overrides the XDG default', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb99-config-argv-'));

  try {
    const runtime = createRuntimeConfig({ cwd, env: {}, argv: ['--config', './custom.yaml'] });

    assert.equal(runtime.configPath, join(cwd, 'custom.yaml'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('createRuntimeConfig preserves explicit JSON config path override', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mrb99-config-json-'));

  try {
    const runtime = createRuntimeConfig({ cwd, env: {}, argv: ['--config', 'custom.json'] });

    assert.equal(runtime.configPath, join(cwd, 'custom.json'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
