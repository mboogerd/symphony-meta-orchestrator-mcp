import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinearService, LinearServiceError, type LinearSdkClient } from '../src/services/linear/index.ts';

function fakeClient(overrides: Partial<LinearSdkClient> = {}): LinearSdkClient {
  return {
    async createProject(input) {
      return { project: { id: 'project-1', name: String(input.name), slugId: 'meta-123', url: 'https://linear.app/acme/project/meta-123' } };
    },
    async createIssue(input) {
      return { issue: { id: 'issue-1', identifier: 'MRB-1', url: `https://linear.app/acme/issue/MRB-1/${input.title}` } };
    },
    async createIssueBatch(input) {
      const issues = input.issues as Array<{ title: string }>;
      return {
        issues: issues.map((issue, index) => ({
          id: `issue-${index + 1}`,
          identifier: `MRB-${index + 1}`,
          url: `https://linear.app/acme/issue/MRB-${index + 1}/${issue.title}`
        }))
      };
    },
    async createIssueRelation() {
      return { relation: { id: 'relation-1', type: 'blocks' } };
    },
    async updateIssue() {
      return { issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } };
    },
    async teams() {
      return { nodes: [{ id: 'team-1', key: 'MRB' }] };
    },
    async workflowStates() {
      return { nodes: [{ id: 'state-backlog', name: 'Backlog', type: 'backlog' }] };
    },
    ...overrides
  };
}

test('Linear service creates projects and returns slug metadata', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createProject(input) {
        calls.push(input);
        return { project: { id: 'project-1', name: 'Meta', slugId: 'meta-123', url: 'https://linear.app/acme/project/meta-123' } };
      }
    })
  });

  const project = await service.createProject({ name: 'Meta', teamKey: 'MRB', description: 'Milestone 1' });

  assert.deepEqual(project, {
    id: 'project-1',
    name: 'Meta',
    slugId: 'meta-123',
    url: 'https://linear.app/acme/project/meta-123'
  });
  assert.deepEqual(calls[0], { name: 'Meta', description: 'Milestone 1', leadId: undefined, teamIds: ['team-1'] });
});

test('Linear service creates issues in Backlog by default and can move state', async () => {
  const created: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssue(input) {
        created.push(input);
        return { issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } };
      },
      async workflowStates(variables) {
        const filter = variables?.filter as { name?: { eq?: string } };
        return { nodes: [{ id: `state-${filter.name?.eq ?? 'unknown'}`, name: filter.name?.eq ?? 'unknown' }] };
      },
      async updateIssue(id, input) {
        updated.push({ id, input });
        return { issue: { id, identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } };
      }
    })
  });

  await service.createIssue({ title: 'test', teamKey: 'MRB' });
  await service.moveIssueToState('issue-1', 'In Progress', 'team-1');

  assert.equal(created[0]?.stateId, 'state-Backlog');
  assert.deepEqual(updated[0], { id: 'issue-1', input: { stateId: 'state-In Progress' } });
});

test('Linear service creates issue batches with resolved Backlog states', async () => {
  const batches: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssueBatch(input) {
        batches.push(input);
        return {
          issues: [
            { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/a' },
            { id: 'issue-2', identifier: 'MRB-2', url: 'https://linear.app/acme/issue/MRB-2/b' }
          ]
        };
      }
    })
  });

  const issues = await service.createIssueBatch({ issues: [{ title: 'a', teamKey: 'MRB' }, { title: 'b', teamKey: 'MRB' }] });

  assert.deepEqual(issues.map((issue) => issue.identifier), ['MRB-1', 'MRB-2']);
  assert.deepEqual((batches[0]?.issues as Array<Record<string, unknown>>).map((issue) => issue.stateId), ['state-backlog', 'state-backlog']);
});

test('Linear service creates deterministic dependency links', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssueRelation(input) {
        calls.push(input);
        return { relation: { id: 'relation-1', type: 'blocks' } };
      }
    })
  });

  await service.createDependency({ blockingIssueId: 'issue-b', blockedIssueId: 'issue-a' });

  assert.deepEqual(calls[0], { issueId: 'issue-b', relatedIssueId: 'issue-a', type: 'blocks' });
});

test('Linear service exposes structured errors for callers', async () => {
  const service = createLinearService({
    client: fakeClient({
      async createIssue() {
        throw new Error('network unavailable');
      }
    })
  });

  await assert.rejects(
    service.createIssue({ title: 'test', teamKey: 'MRB' }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'linear_sdk_error');
      assert.equal(error.operation, 'create_issue');
      assert.deepEqual(error.toJSON(), {
        name: 'LinearServiceError',
        code: 'linear_sdk_error',
        operation: 'create_issue',
        message: 'network unavailable',
        details: {}
      });
      return true;
    }
  );
});
