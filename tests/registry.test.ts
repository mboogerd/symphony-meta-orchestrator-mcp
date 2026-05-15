import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createProjectRegistryService,
  ProjectRegistryValidationError,
  type ManagedProject
} from '../src/index.ts';

const baseProject: ManagedProject = {
  id: 'meta-orchestrator',
  name: 'Meta Orchestrator',
  githubUrl: 'git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git',
  workflow: {
    source: 'repo',
    path: 'WORKFLOW.md'
  },
  codex: {
    threadSandbox: 'workspace-write',
    turnSandbox: {
      type: 'workspaceWrite',
      networkAccess: true
    }
  }
};

test('registry creates, persists, loads, lists, and updates YAML managed projects', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb8-registry-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    await registry.create(baseProject);

    const written = readFileSync(configPath, 'utf8');
    assert.match(written, /version: 3/);
    assert.match(written, /githubUrl:/);
    assert.doesNotMatch(written, /tracker:|repo:|symphony:/);
    assert.deepEqual(await registry.list(), [baseProject]);

    const updated = await registry.update(baseProject.id, {
      githubUrl: 'https://github.com/example/updated.git'
    });

    assert.equal(updated.githubUrl, 'https://github.com/example/updated.git');
    assert.equal((await registry.load()).projects[0]?.githubUrl, 'https://github.com/example/updated.git');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry round-trips enabled: false correctly', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb122-registry-disabled-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    await registry.create({ ...baseProject, enabled: false });

    assert.equal((await registry.load()).projects[0]?.enabled, false);
    assert.match(readFileSync(configPath, 'utf8'), /enabled: false/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry treats absent enabled as true default and omits enabled true from YAML', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb122-registry-enabled-default-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    await registry.create(baseProject);
    assert.equal((await registry.load()).projects[0]?.enabled, undefined);
    assert.doesNotMatch(readFileSync(configPath, 'utf8'), /enabled: true/);

    await registry.update(baseProject.id, { enabled: true });
    assert.equal((await registry.load()).projects[0]?.enabled, undefined);
    assert.doesNotMatch(readFileSync(configPath, 'utf8'), /enabled: true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry runtime hints omit runner command and runnerPort when env does not configure them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb128-registry-runner-port-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);
  const previousCommand = process.env.SYMPHONY_RUNNER_COMMAND;

  try {
    delete process.env.SYMPHONY_RUNNER_COMMAND;
    await registry.create(baseProject);

    const project = (await registry.load()).projects[0] as ManagedProject & {
      symphony?: { command?: string; runnerPort?: number; workspaceRoot?: string; logsRoot?: string };
    };

    assert.equal(project.symphony?.command, undefined);
    assert.equal(project.symphony?.runnerPort, undefined);
    assert.equal(project.symphony?.workspaceRoot, join(cwd, 'workspace'));
    assert.equal(project.symphony?.logsRoot, join(cwd, 'logs'));
  } finally {
    if (previousCommand === undefined) {
      delete process.env.SYMPHONY_RUNNER_COMMAND;
    } else {
      process.env.SYMPHONY_RUNNER_COMMAND = previousCommand;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry runtime hints do not synthesize Linear tracker data', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb140-registry-tracker-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    await registry.create(baseProject);

    const project = (await registry.load()).projects[0] as ManagedProject & {
      tracker?: { projectId?: string; projectSlug?: string };
    };

    assert.equal(Object.prototype.hasOwnProperty.call(project, 'tracker'), false);
    assert.equal(project.tracker, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry runtime hints preserve explicit runner command from env', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb133-registry-runner-command-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);
  const previousCommand = process.env.SYMPHONY_RUNNER_COMMAND;

  try {
    process.env.SYMPHONY_RUNNER_COMMAND = 'custom-symphony';
    await registry.create(baseProject);

    const project = (await registry.load()).projects[0] as ManagedProject & {
      symphony?: { command?: string; workspaceRoot?: string; logsRoot?: string };
    };

    assert.equal(project.symphony?.command, 'custom-symphony');
    assert.equal(project.symphony?.workspaceRoot, join(cwd, 'workspace'));
    assert.equal(project.symphony?.logsRoot, join(cwd, 'logs'));
  } finally {
    if (previousCommand === undefined) {
      delete process.env.SYMPHONY_RUNNER_COMMAND;
    } else {
      process.env.SYMPHONY_RUNNER_COMMAND = previousCommand;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry rejects invalid entries with clear validation errors', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb8-registry-'));
  const registry = createProjectRegistryService(join(cwd, 'registry.yaml'));

  try {
    await assert.rejects(
      registry.create({
        ...baseProject,
        id: '',
        githubUrl: ''
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /projects\[0\]\.id: expected a non-empty string/);
        assert.match((error as Error).message, /projects\[0\]\.githubUrl/);
        return true;
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry normalizes legacy string turn sandbox policies', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb23-registry-policy-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    writeFileSync(configPath, [
      'version: 3',
      'projects:',
      '  - id: meta-orchestrator',
      '    name: Meta Orchestrator',
      '    githubUrl: git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git',
      '    workflow:',
      '      source: repo',
      '      path: WORKFLOW.md',
      '    codex:',
      '      threadSandbox: workspace-write',
      '      turnSandbox: workspace-write',
      ''
    ].join('\n'));

    assert.deepEqual((await registry.load()).projects[0]?.codex.turnSandbox, {
      type: 'workspaceWrite'
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry persists configurable workflow runtime settings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb25-registry-runtime-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);
  const project: ManagedProject = {
    ...baseProject,
    workflow: {
      ...baseProject.workflow,
      runtime: {
        tracker: {
          activeStates: ['Queued', 'Running'],
          terminalStates: ['Finished']
        },
        agent: {
          maxConcurrentAgents: 2,
          maxTurns: 5
        },
        codex: {
          command: 'codex --profile custom app-server',
          approvalPolicy: 'on-request'
        },
        hooks: {
          afterCreate: {
            type: 'gitClone',
            cloneSource: 'https://example.test/repo with spaces.git',
            target: 'repo dir'
          },
          beforeRemove: 'true'
        }
      }
    }
  };

  try {
    await registry.create(project);

    assert.deepEqual((await registry.load()).projects[0]?.workflow, project.workflow);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry rejects invalid workflow runtime settings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb25-registry-runtime-invalid-'));
  const registry = createProjectRegistryService(join(cwd, 'registry.yaml'));

  try {
    await assert.rejects(
      registry.create({
        ...baseProject,
        workflow: {
          ...baseProject.workflow,
          runtime: {
            tracker: { activeStates: [] },
            agent: { maxTurns: 0 }
          }
        }
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /projects\[0\]\.workflow\.runtime\.tracker\.activeStates/);
        assert.match((error as Error).message, /projects\[0\]\.workflow\.runtime\.agent\.maxTurns/);
        return true;
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry rejects duplicate id and githubUrl deterministically', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb8-registry-'));
  const registry = createProjectRegistryService(join(cwd, 'registry.yaml'));

  try {
    await registry.create(baseProject);

    await assert.rejects(
      registry.create({
        ...baseProject,
        id: baseProject.id
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /duplicate project id also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate githubUrl also used by projects\[0\]/);
        return true;
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry rejects version 2 with migration error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb119-registry-v2-'));
  const configPath = join(cwd, 'registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    writeFileSync(configPath, ['version: 2', 'projects: []', ''].join('\n'));
    await assert.rejects(registry.load(), /version 2.*migrat/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
