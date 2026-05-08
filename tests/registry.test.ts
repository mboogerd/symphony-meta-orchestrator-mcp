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
  tracker: {
    kind: 'linear',
    teamKey: 'MRB',
    teamId: 'linear-team-id',
    projectId: 'linear-project-id',
    projectSlug: 'meta-orchestrator'
  },
  repo: {
    path: '/tmp/symphony-meta-orchestrator-mcp',
    remoteUrl: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
    defaultBranch: 'main',
    cloneSource: 'git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git'
  },
  workflow: {
    source: 'repo',
    path: 'WORKFLOW.md'
  },
  symphony: {
    command: 'mise',
    args: [
      'exec',
      '--',
      './bin/symphony',
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
    ],
    cwd: '/tmp/symphony',
    runnerPort: 4101,
    workspaceRoot: '/tmp/symphony-workspaces/meta-orchestrator',
    logsRoot: '/tmp/symphony-logs/meta-orchestrator'
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

    assert.match(readFileSync(configPath, 'utf8'), /tracker:\n\s+kind: linear/);
    assert.deepEqual(await registry.list(), [baseProject]);

    const updated = await registry.update(baseProject.id, {
      symphony: { runnerPort: 4200 }
    });

    assert.equal(updated.symphony.runnerPort, 4200);
    assert.equal(updated.symphony.workspaceRoot, baseProject.symphony.workspaceRoot);
    assert.equal((await registry.load()).projects[0]?.symphony.runnerPort, 4200);
  } finally {
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
        tracker: { ...baseProject.tracker, projectSlug: '' },
        repo: { ...baseProject.repo, cloneSource: '' },
        symphony: { ...baseProject.symphony, command: '', runnerPort: 70000 }
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /projects\[0\]\.id: expected a non-empty string/);
        assert.match((error as Error).message, /projects\[0\]\.tracker\.projectSlug/);
        assert.match((error as Error).message, /projects\[0\]\.repo\.cloneSource/);
        assert.match((error as Error).message, /projects\[0\]\.symphony\.command/);
        assert.match((error as Error).message, /projects\[0\]\.symphony\.runnerPort/);
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
      'version: 2',
      'projects:',
      '  - id: meta-orchestrator',
      '    name: Meta Orchestrator',
      '    tracker:',
      '      kind: linear',
      '      teamKey: MRB',
      '      teamId: linear-team-id',
      '      projectId: linear-project-id',
      '      projectSlug: meta-orchestrator',
      '    repo:',
      '      path: /tmp/symphony-meta-orchestrator-mcp',
      '      remoteUrl: https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
      '      defaultBranch: main',
      '      cloneSource: git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git',
      '    workflow:',
      '      source: repo',
      '      path: WORKFLOW.md',
      '    symphony:',
      '      command: mise',
      '      runnerPort: 4101',
      '      workspaceRoot: /tmp/symphony-workspaces/meta-orchestrator',
      '      logsRoot: /tmp/symphony-logs/meta-orchestrator',
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

test('registry rejects duplicate identities, ports, and paths deterministically', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb8-registry-'));
  const registry = createProjectRegistryService(join(cwd, 'registry.yaml'));

  try {
    await registry.create(baseProject);

    await assert.rejects(
      registry.create({
        ...baseProject,
        id: 'duplicate',
        repo: { ...baseProject.repo, path: baseProject.repo.path },
        symphony: {
          ...baseProject.symphony,
          workspaceRoot: baseProject.symphony.workspaceRoot,
          runnerPort: baseProject.symphony.runnerPort
        }
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /duplicate Linear identity also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate repo path also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate workspace root also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate port also used by projects\[0\]\.symphony\.runnerPort/);
        return true;
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
