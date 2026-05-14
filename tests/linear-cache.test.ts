import assert from 'node:assert/strict';
import test from 'node:test';
import { LinearProjectCache } from '../src/services/linear/cache.ts';
import { LinearService, LinearServiceError, type LinearSdkClient } from '../src/services/linear/index.ts';

test('cache resolves project by name and memoises result', async () => {
  let projectCalls = 0;
  const service = new LinearService({ client: clientWithProjects(() => {
    projectCalls += 1;
    return [{ id: 'project-1', name: 'Dummy', slugId: 'dummy-slug', url: 'https://linear.test/project/dummy-slug' }];
  }) });
  const cache = new LinearProjectCache(service, 'MRB');

  assert.deepEqual(await cache.resolve('Dummy'), {
    teamId: 'team-1',
    teamKey: 'MRB',
    projectId: 'project-1',
    projectSlug: 'dummy-slug'
  });
  assert.deepEqual(await cache.resolve('Dummy'), {
    teamId: 'team-1',
    teamKey: 'MRB',
    projectId: 'project-1',
    projectSlug: 'dummy-slug'
  });
  assert.equal(projectCalls, 1);
});

test('cache throws duplicate_project_name when multiple Linear projects match', async () => {
  const service = new LinearService({ client: clientWithProjects(() => [
    { id: 'project-1', name: 'Dummy', slugId: 'dummy-1', url: 'https://linear.test/project/dummy-1' },
    { id: 'project-2', name: 'Dummy', slugId: 'dummy-2', url: 'https://linear.test/project/dummy-2' }
  ]) });
  const cache = new LinearProjectCache(service, 'MRB');

  await assert.rejects(cache.resolve('Dummy'), (error) => {
    assert.equal(error instanceof LinearServiceError, true);
    assert.equal((error as LinearServiceError).code, 'duplicate_project_name');
    return true;
  });
});

test('cache throws project_not_found when no Linear project matches', async () => {
  const service = new LinearService({ client: clientWithProjects(() => []) });
  const cache = new LinearProjectCache(service, 'MRB');

  await assert.rejects(cache.resolve('Dummy'), (error) => {
    assert.equal(error instanceof LinearServiceError, true);
    assert.equal((error as LinearServiceError).code, 'project_not_found');
    return true;
  });
});

function clientWithProjects(projects: () => Array<{ id: string; name: string; slugId: string; url: string }>): LinearSdkClient {
  return {
    teams: async () => ({
      nodes: [{
        id: 'team-1',
        key: 'MRB',
        projects: async () => ({ nodes: projects() })
      }]
    }),
    projects: async () => ({ nodes: [] }),
    issue: async () => undefined,
    project: async () => undefined,
    createProject: async () => ({}),
    createIssue: async () => ({}),
    createIssueBatch: async () => ({}),
    createIssueRelation: async () => ({}),
    updateIssue: async () => ({}),
    workflowStates: async () => ({ nodes: [] })
  };
}
