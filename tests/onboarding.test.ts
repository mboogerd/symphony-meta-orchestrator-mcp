import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { bootstrapSymphonyRunner, setupManagedProject, setupProjectRecovery } from '../src/services/onboarding/index.ts';

test('bootstrapSymphonyRunner clones the OpenAI Symphony repository by default', async () => {
  const fixture = createBootstrapFixture('mrb116-default-repo-', `#!/bin/sh
printf '%s\\n' "$@" > "$GIT_ARGS_FILE"
mkdir -p "$3/elixir"
printf 'defmodule Symphony.MixProject do\\nend\\n' > "$3/elixir/mix.exs"
`);
  createMixShim(fixture, `#!/bin/sh
printf '%s\\n' "$@" >> "$MIX_ARGS_FILE"
if [ "$1" = "release" ]; then
  mkdir -p "_build/prod/rel/symphony/bin"
  printf '#!/bin/sh\\n' > "_build/prod/rel/symphony/bin/symphony"
  chmod +x "_build/prod/rel/symphony/bin/symphony"
fi
`);

  try {
    const result = await withBootstrapEnv(fixture, async () => {
      return bootstrapSymphonyRunner(process.cwd());
    });

    assert.equal(
      readFileSync(fixture.gitArgsFile, 'utf8').trim(),
      `clone\nhttps://github.com/openai/symphony.git\n${fixture.installPath}`
    );
    assert.equal(readFileSync(fixture.mixArgsFile, 'utf8').trim(), 'deps.get\nrelease');
    assert.equal(result.command, join(fixture.installPath, 'elixir', '_build', 'prod', 'rel', 'symphony', 'bin', 'symphony'));
    assert.deepEqual(result.args, ['--i-understand-that-this-will-be-running-without-the-usual-guardrails']);
    assert.equal(result.cwd, join(fixture.installPath, 'elixir'));
  } finally {
    fixture.cleanup();
  }
});

test('bootstrapSymphonyRunner fails clearly when cloned repository is not an Elixir Symphony project', async () => {
  const fixture = createBootstrapFixture('mrb134-missing-mix-', `#!/bin/sh
mkdir -p "$3"
`);

  try {
    await assert.rejects(
      withBootstrapEnv(fixture, async () => {
        await bootstrapSymphonyRunner(process.cwd());
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'SymphonyRunnerBootstrapError');
        assert.match(error.message, /Expected an Elixir\/Mix Symphony project/);
        assert.match(error.message, /mix\.exs was not found/);
        return true;
      }
    );
  } finally {
    fixture.cleanup();
  }
});

test('bootstrapSymphonyRunner wraps mix release failures with runner remediation guidance', async () => {
  const fixture = createBootstrapFixture('mrb134-mix-error-', `#!/bin/sh
mkdir -p "$3/elixir"
printf 'defmodule Symphony.MixProject do\\nend\\n' > "$3/elixir/mix.exs"
`);
  createMixShim(fixture, `#!/bin/sh
echo 'mix release failed' >&2
exit 1
`);

  try {
    await assert.rejects(
      withBootstrapEnv(fixture, async () => {
        await bootstrapSymphonyRunner(process.cwd());
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'SymphonyRunnerBootstrapError');
        assert.match(error.message, /Bootstrap failed while preparing Symphony runner/);
        assert.match(error.message, /SYMPHONY_RUNNER_COMMAND/);
        assert.match(error.message, /mix release failed/);
        return true;
      }
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
        assert.match(error.message, /Bootstrap failed while preparing Symphony runner/);
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

test('setupManagedProject reuses an existing same-name Linear project before creating one', async () => {
  let findProjectCalls = 0;
  let createProjectCalls = 0;

  const result = await setupManagedProject({
    name: 'Reusable Project',
    teamKey: 'MRB',
    githubUrl: 'https://github.com/mboogerd/reusable-project.git'
  }, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: {
      ...fakeLinear(),
      findProjectByNameForTeam: async (name: string, teamId: string) => {
        findProjectCalls += 1;
        assert.equal(name, 'Reusable Project');
        assert.equal(teamId, 'team-1');
        return {
          id: 'reusable-linear-project',
          name: 'Reusable Project',
          url: 'https://linear.app/mrboo/project/reusable-project'
        };
      },
      createProject: async () => {
        createProjectCalls += 1;
        throw new Error('createProject should not be called when a same-name project exists');
      }
    } as never,
    registry: {
      load: async () => ({ version: 3, projects: [] }),
      create: async (project: unknown) => project as never
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.equal(findProjectCalls, 1);
  assert.equal(createProjectCalls, 0);
  assert.equal(result.linearProject?.id, 'reusable-linear-project');
  assert.equal(result.project?.tracker.projectId, 'reusable-linear-project');
  assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), [
    'linearProject:ok',
    'bootstrap:ok',
    'registry:ok',
    'workflow:ok',
    'runner:skipped'
  ]);
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

test('setupManagedProject does not resume duplicate registry entries without Linear linkage', async () => {
  let resolveProjectForTeamCalls = 0;

  const result = await setupManagedProject({
    name: 'Dummy Project',
    teamKey: 'MRB',
    githubUrl: 'https://github.com/mboogerd/dummy.git'
  }, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: {
      ...fakeLinear(),
      resolveProjectForTeam: async () => {
        resolveProjectForTeamCalls += 1;
        throw new Error('resolveProjectForTeam should not be called');
      }
    } as never,
    registry: {
      load: async () => ({
        version: 3,
        projects: [managedProject({ id: 'dummy-project', githubUrl: 'https://github.com/mboogerd/dummy.git' })]
      }),
      create: async () => {
        throw new Error('registry create should not be called');
      }
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.equal(resolveProjectForTeamCalls, 0);
  assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), ['linearProject:error']);
  assert.equal(result.steps[0]?.error?.code, 'project_registry_conflict');
  assert.deepEqual(result.steps[0]?.error?.fields, ['id', 'githubUrl']);
});

test('setupProjectRecovery guides registry failures after Linear project creation', async () => {
  const input = {
    name: 'Registry Failure Project',
    teamKey: 'MRB',
    githubUrl: 'https://github.com/mboogerd/registry-failure.git'
  };
  const result = await setupManagedProject(input, {
    env: { SYMPHONY_RUNNER_COMMAND: 'node' },
    linear: {
      ...fakeLinear(),
      findProjectByNameForTeam: async () => undefined,
      createProject: async () => ({
        id: 'created-linear-project',
        name: 'Registry Failure Project',
        url: 'https://linear.app/mrboo/project/registry-failure-created'
      })
    } as never,
    registry: {
      load: async () => ({ version: 3, projects: [] }),
      create: async () => {
        throw new Error('duplicate project id registry-failure-project');
      }
    } as never,
    runnerManager: { start: async () => ({}) } as never
  });

  assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), [
    'linearProject:ok',
    'bootstrap:ok',
    'registry:error'
  ]);
  const recovery = setupProjectRecovery(input, result);
  assert.equal(recovery?.failedStep, 'registry');
  assert.equal(recovery?.retry.input.linearProjectId, 'created-linear-project');
  assert.match(recovery?.summary ?? '', /Linear project may be orphaned/);
  assert.ok(recovery?.actions.some((action) => action.includes('duplicate id or githubUrl')));
  assert.ok(recovery?.actions.some((action) => action.includes('archive or delete it in Linear')));
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

test('setupManagedProject recovers stale registry Linear linkage with explicit project id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb135-explicit-'));
  const existingProject = managedProject({
    id: 'dummy-project',
    githubUrl: 'https://github.com/mboogerd/dummy.git',
    linearProjectId: 'stale-linear-project'
  });
  const resolvedProjectIds: string[] = [];

  try {
    const result = await setupManagedProject({
      name: 'Dummy Project',
      teamKey: 'MRB',
      githubUrl: 'https://github.com/mboogerd/dummy.git',
      linearProjectId: 'replacement-linear-project'
    }, {
      env: {
        SYMPHONY_RUNNER_COMMAND: 'node',
        DEFAULT_SYMPHONY_WORKSPACES: join(root, 'workspaces'),
        DEFAULT_SYMPHONY_LOGS: join(root, 'logs')
      },
      linear: {
        ...fakeLinear(),
        findProjectByNameForTeam: async () => {
          throw new Error('findProjectByNameForTeam should not be called');
        },
        createProject: async () => {
          throw new Error('createProject should not be called');
        },
        resolveProjectForTeam: async (projectId: string) => {
          resolvedProjectIds.push(projectId);
          if (projectId === 'stale-linear-project') {
            throw Object.assign(new Error('Entity not found: Project'), { code: 'linear_sdk_error' });
          }
          return {
            id: projectId,
            name: 'Dummy Project',
            url: 'https://linear.app/mrboo/project/dummy-project-replacement'
          };
        }
      } as never,
      registry: {
        load: async () => ({ version: 3, projects: [existingProject] }),
        create: async () => {
          throw new Error('registry create should not be called');
        }
      } as never,
      runnerManager: { start: async () => ({}) } as never
    });

    assert.deepEqual(resolvedProjectIds, ['replacement-linear-project']);
    assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:skipped',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(result.linearProject?.id, 'replacement-linear-project');
    assert.equal(result.project?.tracker.projectId, 'replacement-linear-project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setupManagedProject recovers stale registry Linear linkage with project name lookup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrb135-name-'));
  const existingProject = managedProject({
    id: 'dummy-project',
    githubUrl: 'https://github.com/mboogerd/dummy.git',
    linearProjectId: 'stale-linear-project'
  });
  let createProjectCalls = 0;

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
        findProjectByNameForTeam: async () => ({
          id: 'name-matched-linear-project',
          name: 'Dummy Project',
          url: 'https://linear.app/mrboo/project/dummy-project-name-matched'
        }),
        createProject: async () => {
          createProjectCalls += 1;
          return {
            id: 'created-project',
            name: 'Dummy Project',
            url: 'https://linear.app/mrboo/project/dummy-project-created'
          };
        },
        resolveProjectForTeam: async () => {
          throw Object.assign(new Error('Linear project "stale-linear-project" was not found in the resolved team'), { code: 'project_not_found' });
        }
      } as never,
      registry: {
        load: async () => ({ version: 3, projects: [existingProject] }),
        create: async () => {
          throw new Error('registry create should not be called');
        }
      } as never,
      runnerManager: { start: async () => ({}) } as never
    });

    assert.equal(createProjectCalls, 0);
    assert.deepEqual(result.steps.map((step) => `${step.name}:${step.status}`), [
      'linearProject:ok',
      'bootstrap:ok',
      'registry:skipped',
      'workflow:ok',
      'runner:skipped'
    ]);
    assert.equal(result.linearProject?.id, 'name-matched-linear-project');
    assert.equal(result.project?.tracker.projectId, 'name-matched-linear-project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type BootstrapFixture = {
  root: string;
  binDir: string;
  gitArgsFile: string;
  mixArgsFile: string;
  installPath: string;
  cleanup: () => void;
};

function createBootstrapFixture(prefix: string, gitScript: string): BootstrapFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(root, 'bin');
  const installPath = join(root, 'install', 'symphony');
  const gitArgsFile = join(root, 'git-args.txt');
  const mixArgsFile = join(root, 'mix-args.txt');
  const gitPath = join(binDir, 'git');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(gitPath, gitScript);
  chmodSync(gitPath, 0o755);

  return {
    root,
    binDir,
    gitArgsFile,
    mixArgsFile,
    installPath,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function createMixShim(fixture: BootstrapFixture, script: string): void {
  const mixPath = join(fixture.binDir, 'mix');
  writeFileSync(mixPath, script);
  chmodSync(mixPath, 0o755);
}

async function withBootstrapEnv<T>(fixture: BootstrapFixture, callback: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  const previousInstallDir = process.env.SYMPHONY_RUNNER_INSTALL_DIR;
  const previousRepository = process.env.SYMPHONY_RUNNER_REPOSITORY;
  const previousGitArgsFile = process.env.GIT_ARGS_FILE;
  const previousMixArgsFile = process.env.MIX_ARGS_FILE;

  try {
    process.env.PATH = `${fixture.binDir}${delimiter}${previousPath ?? ''}`;
    process.env.SYMPHONY_RUNNER_INSTALL_DIR = fixture.installPath;
    process.env.GIT_ARGS_FILE = fixture.gitArgsFile;
    process.env.MIX_ARGS_FILE = fixture.mixArgsFile;
    delete process.env.SYMPHONY_RUNNER_REPOSITORY;
    return await callback();
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('SYMPHONY_RUNNER_INSTALL_DIR', previousInstallDir);
    restoreEnv('SYMPHONY_RUNNER_REPOSITORY', previousRepository);
    restoreEnv('GIT_ARGS_FILE', previousGitArgsFile);
    restoreEnv('MIX_ARGS_FILE', previousMixArgsFile);
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
