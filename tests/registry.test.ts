import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
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
  linear: {
    teamKey: 'MRB',
    projectId: 'linear-project-id'
  },
  repo: {
    path: '/tmp/symphony-meta-orchestrator-mcp',
    remote: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
    branch: 'main'
  },
  symphony: {
    workspacePath: '/tmp/symphony-workspaces/meta-orchestrator',
    mcpPort: 4100,
    runnerPort: 4101
  }
};

test('registry creates, persists, loads, lists, and updates YAML managed projects', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mrb8-registry-'));
  const configPath = join(cwd, 'symphony.registry.yaml');
  const registry = createProjectRegistryService(configPath);

  try {
    await registry.create(baseProject);

    assert.match(readFileSync(configPath, 'utf8'), /linear:\n\s+teamKey: MRB/);
    assert.deepEqual(await registry.list(), [baseProject]);

    const updated = await registry.update(baseProject.id, {
      symphony: { workspacePath: baseProject.symphony.workspacePath, mcpPort: 4200 }
    });

    assert.equal(updated.symphony.mcpPort, 4200);
    assert.equal(updated.symphony.runnerPort, 4101);
    assert.equal((await registry.load()).projects[0]?.symphony.mcpPort, 4200);
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
        linear: { teamKey: 'MRB' },
        symphony: { workspacePath: baseProject.symphony.workspacePath, mcpPort: 70000 }
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /projects\[0\]\.id: expected a non-empty string/);
        assert.match((error as Error).message, /projects\[0\]\.linear: expected projectId or projectKey/);
        assert.match((error as Error).message, /projects\[0\]\.symphony\.mcpPort/);
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
        repo: { path: baseProject.repo.path },
        symphony: {
          workspacePath: baseProject.symphony.workspacePath,
          mcpPort: baseProject.symphony.runnerPort ?? 4101
        }
      }),
      (error) => {
        assert.equal(error instanceof ProjectRegistryValidationError, true);
        assert.match((error as Error).message, /duplicate Linear identity also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate repo path also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate workspace path also used by projects\[0\]/);
        assert.match((error as Error).message, /duplicate port also used by projects\[0\]\.symphony\.runnerPort/);
        return true;
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
