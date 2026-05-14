import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { bootstrapSymphonyRunner, setupManagedProject } from '../src/services/onboarding/index.ts';

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

test('setupManagedProject derives repo fields and default roots from githubUrl', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb117-setup-'));
  const workspaceBase = join(root, 'workspaces');
  const logsBase = join(root, 'logs');
  let createdProject: unknown;

  try {
    const result = await setupManagedProject({
      name: 'Meta Orchestrator',
      teamKey: 'MRB',
      githubUrl: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git'
    }, {
      env: {
        DEFAULT_SYMPHONY_WORKSPACES: workspaceBase,
        DEFAULT_SYMPHONY_LOGS: logsBase,
        SYMPHONY_RUNNER_COMMAND: 'node'
      },
      linear: fakeLinear(),
      registry: {
        load: async () => ({ version: 3, projects: [] }),
        create: async (project: unknown) => {
          createdProject = project;
          return project as never;
        }
      } as never,
      runnerManager: { start: async () => ({}) } as never
    });

    assert.equal(result.steps.map((step) => `${step.name}:${step.status}`).join(','), 'linearProject:ok,bootstrap:ok,registry:ok,workflow:ok,runner:skipped');
    assert.equal(result.project?.githubUrl, 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git');
    assert.equal('repo' in (result.project ?? {}), false);
    assert.equal(result.project?.symphony.workspaceRoot, join(workspaceBase, 'meta-orchestrator'));
    assert.equal(result.project?.symphony.logsRoot, join(logsBase, 'meta-orchestrator'));
    assert.equal(existsSync(join(workspaceBase, 'meta-orchestrator', 'mboogerd-symphony-meta-orchestrator-mcp')), false);
    assert.equal(createdProject, result.project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setupManagedProject falls back to OS temp roots when roots are omitted', async () => {
  const result = await setupManagedProject({
    name: 'Temp Root Project',
    teamKey: 'MRB',
    githubUrl: 'git@github.com:mboogerd/example.git'
  }, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: fakeLinear(),
    registry: {
      load: async () => ({ version: 3, projects: [] }),
      create: async (project: unknown) => project as never
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.equal(result.project?.symphony.workspaceRoot, join(tmpdir(), 'symphony-workspaces', 'temp-root-project'));
  assert.equal(result.project?.symphony.logsRoot, join(tmpdir(), 'symphony-logs', 'temp-root-project'));
  assert.equal('repo' in (result.project ?? {}), false);
});

test('setupManagedProject rejects duplicate registry id before creating a Linear project', async () => {
  let createProjectCalls = 0;

  const result = await setupManagedProject({
    name: 'Dummy Project',
    teamKey: 'MRB',
    githubUrl: 'https://github.com/mboogerd/new-dummy.git'
  }, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: {
      ...fakeLinear(),
      findProjectByNameForTeam: async () => undefined,
      createProject: async () => {
        createProjectCalls += 1;
        return { id: 'created-project', name: 'Dummy Project', url: 'https://linear.app/mrboo/project/dummy-project-created' };
      }
    } as never,
    registry: {
      load: async () => ({
        version: 3,
        projects: [managedProject({ id: 'dummy-project', githubUrl: 'https://github.com/mboogerd/existing.git' })]
      }),
      create: async () => {
        throw new Error('registry create should not be called');
      }
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.equal(createProjectCalls, 0);
  assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), ['linearProject:error']);
  assert.equal(result.steps[0]?.error?.code, 'project_registry_conflict');
  assert.deepEqual(result.steps[0]?.error?.fields, ['id']);
});

test('setupManagedProject rejects duplicate registry githubUrl before creating a Linear project', async () => {
  let createProjectCalls = 0;

  const result = await setupManagedProject({
    name: 'Fresh Name',
    teamKey: 'MRB',
    githubUrl: 'https://github.com/mboogerd/dummy.git'
  }, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: {
      ...fakeLinear(),
      findProjectByNameForTeam: async () => undefined,
      createProject: async () => {
        createProjectCalls += 1;
        return { id: 'created-project', name: 'Fresh Name', url: 'https://linear.app/mrboo/project/fresh-name-created' };
      }
    } as never,
    registry: {
      load: async () => ({
        version: 3,
        projects: [managedProject({ id: 'existing-dummy', githubUrl: 'https://github.com/mboogerd/dummy.git' })]
      }),
      create: async () => {
        throw new Error('registry create should not be called');
      }
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.equal(createProjectCalls, 0);
  assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), ['linearProject:error']);
  assert.equal(result.steps[0]?.error?.code, 'project_registry_conflict');
  assert.deepEqual(result.steps[0]?.error?.fields, ['githubUrl']);
});

test('setupManagedProject resumes an existing registry project with Linear linkage without creating a duplicate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb127-resume-'));
  let createProjectCalls = 0;
  let registryCreateCalls = 0;
  const existingProject = managedProject({
    id: 'dummy-project',
    githubUrl: 'https://github.com/mboogerd/dummy.git',
    linearProjectId: 'existing-linear-project'
  });

  try {
    const result = await setupManagedProject({
      name: 'Dummy Project',
      teamKey: 'MRB',
      githubUrl: 'https://github.com/mboogerd/dummy.git'
    }, {
      env: {
        SYMPHONY_RUNNER_COMMAND: 'node',
        DEFAULT_SYMPHONY_WORKSPACES: join(root, 'workspaces'),
        DEFAULT_SYMPHONY_LOGS: join(root, 'logs')
      },
      linear: {
        ...fakeLinear(),
        findProjectByNameForTeam: async () => undefined,
        createProject: async () => {
          createProjectCalls += 1;
          return { id: 'created-project', name: 'Dummy Project', url: 'https://linear.app/mrboo/project/dummy-project-created' };
        },
        resolveProjectForTeam: async (projectId: string) => ({
          id: projectId,
          name: 'Dummy Project',
          url: 'https://linear.app/mrboo/project/dummy-project-existing'
        })
      } as never,
      registry: {
        load: async () => ({ version: 3, projects: [existingProject] }),
        create: async () => {
          registryCreateCalls += 1;
          throw new Error('registry create should not be called');
        }
      } as never,
      runnerManager: { start: async () => ({}) } as never
    });

    assert.equal(createProjectCalls, 0);
    assert.equal(registryCreateCalls, 0);
    assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:skipped',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(result.linearProject?.id, 'existing-linear-project');
    assert.equal(result.project?.id, 'dummy-project');
    assert.equal(result.project?.tracker.projectId, 'existing-linear-project');
  } finally {
    rmSync(root, { recursive: true, force: true });
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

function fakeLinear() {
  return {
    resolveTeam: async () => ({ id: 'team-1', key: 'MRB', name: 'Mr Boo' }),
    findProjectByNameForTeam: async () => ({ id: 'project-1', name: 'Meta Orchestrator', url: 'https://linear.app/mrboo/project/meta-orchestrator-abc123' }),
    createProject: async () => ({ id: 'project-1', name: 'Meta Orchestrator', url: 'https://linear.app/mrboo/project/meta-orchestrator-abc123' }),
    resolveProjectForTeam: async () => ({ id: 'project-1', name: 'Meta Orchestrator', url: 'https://linear.app/mrboo/project/meta-orchestrator-abc123' })
  } as never;
}

function managedProject(input: { id: string; githubUrl: string; linearProjectId?: string }) {
  const project = {
    id: input.id,
    name: 'Dummy Project',
    githubUrl: input.githubUrl,
    workflow: { source: 'generated', template: 'default' },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: { type: 'workspaceWrite', networkAccess: true }
    }
  };

  if (input.linearProjectId !== undefined) {
    Object.defineProperty(project, 'tracker', {
      enumerable: false,
      value: {
        kind: 'linear',
        teamKey: 'MRB',
        teamId: 'team-1',
        projectId: input.linearProjectId,
        projectSlug: 'dummy-project-existing'
      }
    });
  }

  return project;
}
