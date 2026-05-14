import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { bootstrapSymphonyRunner } from '../src/services/onboarding/index.ts';

test('bootstrapSymphonyRunner clones the OpenAI Symphony repository by default', async () => {
  const fixture = createBootstrapFixture('mrb116-default-repo-', `#!/bin/sh
printf '%s\\n' "$@" > "$GIT_ARGS_FILE"
mkdir -p "$3"
`);

  try {
    await withBootstrapEnv(fixture, async () => {
      await bootstrapSymphonyRunner(process.cwd());
    });

    assert.equal(
      readFileSync(fixture.gitArgsFile, 'utf8').trim(),
      `clone\nhttps://github.com/openai/symphony.git\n${fixture.installPath}`
    );
  } finally {
    fixture.cleanup();
  }
});

test('bootstrapSymphonyRunner wraps clone failures with runner remediation guidance', async () => {
  const fixture = createBootstrapFixture('mrb116-bootstrap-error-', `#!/bin/sh
printf '%s\\n' "$@" > "$GIT_ARGS_FILE"
echo 'fatal: repository not found' >&2
exit 128
`);

  try {
    await assert.rejects(
      withBootstrapEnv(fixture, async () => {
        process.env.SYMPHONY_RUNNER_REPOSITORY = 'https://example.invalid/private/symphony.git';
        await bootstrapSymphonyRunner(process.cwd());
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'SymphonyRunnerBootstrapError');
        assert.match(error.message, /Bootstrap failed while cloning Symphony runner/);
        assert.match(error.message, /setup_project runnerCommand/);
        assert.match(error.message, /SYMPHONY_RUNNER_COMMAND/);
        assert.match(error.message, /SYMPHONY_RUNNER_REPOSITORY/);
        assert.match(error.message, /fatal: repository not found/);
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

type BootstrapFixture = {
  root: string;
  binDir: string;
  gitArgsFile: string;
  installPath: string;
  cleanup: () => void;
};

function createBootstrapFixture(prefix: string, gitScript: string): BootstrapFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(root, 'bin');
  const installPath = join(root, 'install', 'symphony');
  const gitArgsFile = join(root, 'git-args.txt');
  const gitPath = join(binDir, 'git');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(gitPath, gitScript);
  chmodSync(gitPath, 0o755);

  return {
    root,
    binDir,
    gitArgsFile,
    installPath,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

async function withBootstrapEnv<T>(fixture: BootstrapFixture, callback: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  const previousInstallDir = process.env.SYMPHONY_RUNNER_INSTALL_DIR;
  const previousRepository = process.env.SYMPHONY_RUNNER_REPOSITORY;
  const previousGitArgsFile = process.env.GIT_ARGS_FILE;

  try {
    process.env.PATH = `${fixture.binDir}${delimiter}${previousPath ?? ''}`;
    process.env.SYMPHONY_RUNNER_INSTALL_DIR = fixture.installPath;
    process.env.GIT_ARGS_FILE = fixture.gitArgsFile;
    delete process.env.SYMPHONY_RUNNER_REPOSITORY;
    return await callback();
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('SYMPHONY_RUNNER_INSTALL_DIR', previousInstallDir);
    restoreEnv('SYMPHONY_RUNNER_REPOSITORY', previousRepository);
    restoreEnv('GIT_ARGS_FILE', previousGitArgsFile);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
