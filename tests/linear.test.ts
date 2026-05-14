import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinearService, LinearServiceError, type LinearSdkClient } from '../src/services/linear/index.ts';
import { managedProject } from './project-fixtures.ts';

const projectFixture = () => managedProject({ repoPath: '/tmp/repo', workspaceRoot: '/tmp/workspace' });

function fakeClient(overrides: Partial<LinearSdkClient> = {}): LinearSdkClient {
  return {
    async issue(id) {
      return {
        id,
        identifier: 'MRB-1',
        url: `https://linear.app/acme/issue/MRB-1/${id}`,
        team: { id: 'linear-team-id', key: 'MRB' },
        project: { id: 'linear-project-id', name: 'Meta' }
      };
    },
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
      return { nodes: [{ id: 'team-1', key: 'MRB', name: 'Mrboo', description: 'Main team' }] };
    },
    async projects() {
      return { nodes: [{ id: 'project-1', name: 'Meta', slugId: 'meta-123', url: 'https://linear.app/acme/project/meta-123' }] };
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
    url: 'https://linear.app/acme/project/meta-123',
    teamId: 'team-1'
  });
  assert.deepEqual(calls[0], { name: 'Meta', description: 'Milestone 1', leadId: undefined, teamIds: ['team-1'] });
});

test('Linear service lists accessible teams with keys for discovery', async () => {
  const queries: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async teams(variables) {
        queries.push(variables ?? {});
        return {
          nodes: [
            { id: 'team-1', key: 'MRB', name: 'Mrboo', description: 'Main team' },
            { id: 'team-2', key: 'OPS', name: 'Operations' }
          ]
        };
      }
    })
  });

  const teams = await service.listTeams();

  assert.deepEqual(teams, [
    { id: 'team-1', key: 'MRB', name: 'Mrboo', description: 'Main team' },
    { id: 'team-2', key: 'OPS', name: 'Operations', description: undefined }
  ]);
  assert.deepEqual(queries, [{}]);
});

test('Linear service resolves project slug metadata when create payload omits it', async () => {
  const projectQueries: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createProject() {
        return { project: { id: 'project-1', name: 'Meta' } };
      },
      async projects(variables) {
        projectQueries.push(variables ?? {});
        return { nodes: [{ id: 'project-1', name: 'Meta', slugId: 'meta-123', url: 'https://linear.app/acme/project/meta-123' }] };
      }
    })
  });

  const project = await service.createProject({ name: 'Meta', teamKey: 'MRB' });

  assert.deepEqual(project, {
    id: 'project-1',
    name: 'Meta',
    slugId: 'meta-123',
    url: 'https://linear.app/acme/project/meta-123',
    teamId: 'team-1'
  });
  assert.deepEqual(projectQueries[0], { filter: { id: { eq: 'project-1' } }, first: 1 });
});

test('Linear service finds projects by case-insensitive name substring and slug', async () => {
  const projectQueries: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async projects(variables) {
        projectQueries.push(variables ?? {});
        return {
          nodes: [{
            id: 'project-1',
            name: 'Symphony Meta-Orchestrator MCP',
            slugId: 'symphony-meta-orchestrator-mcp-d4c50743a53d',
            url: 'https://linear.app/mrboo/project/symphony-meta-orchestrator-mcp-d4c50743a53d',
            teams: { nodes: [{ id: 'team-1', key: 'MRB' }] }
          }]
        };
      }
    })
  });

  const projects = await service.findProjects({ name: 'meta-orchestrator', slugId: 'symphony-meta-orchestrator-mcp-d4c50743a53d' });

  assert.deepEqual(projectQueries[0], {
    filter: {
      name: { containsIgnoreCase: 'meta-orchestrator' },
      slugId: { eq: 'symphony-meta-orchestrator-mcp-d4c50743a53d' }
    },
    first: 50,
    includeArchived: true
  });
  assert.deepEqual(projects, [{
    id: 'project-1',
    name: 'Symphony Meta-Orchestrator MCP',
    slugId: 'symphony-meta-orchestrator-mcp-d4c50743a53d',
    url: 'https://linear.app/mrboo/project/symphony-meta-orchestrator-mcp-d4c50743a53d',
    teamId: 'team-1'
  }]);
});

test('Linear service resolves project team from SDK lazy teams relation', async () => {
  const projectTeamQueries: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async projects() {
        return {
          nodes: [{
            id: 'project-1',
            name: 'Symphony',
            slugId: 'symphony',
            url: 'https://linear.app/mrboo/project/symphony',
            async teams(variables) {
              projectTeamQueries.push(variables ?? {});
              return { nodes: [{ id: 'team-1', key: 'MRB' }] };
            }
          }]
        };
      }
    })
  });

  const projects = await service.findProjects({ name: 'Symphony' });

  assert.deepEqual(projectTeamQueries, [{ first: 1 }]);
  assert.deepEqual(projects, [{
    id: 'project-1',
    name: 'Symphony',
    slugId: 'symphony',
    url: 'https://linear.app/mrboo/project/symphony',
    teamId: 'team-1'
  }]);
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

test('Linear service resolves lazy SDK issue payloads', async () => {
  const service = createLinearService({
    client: fakeClient({
      async createIssue() {
        return {
          issue: Promise.resolve({ id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' })
        };
      },
      async updateIssue(id) {
        return {
          issue: Promise.resolve({ id, identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' })
        };
      }
    })
  });

  const created = await service.createIssue({ title: 'test', teamKey: 'MRB' });
  const moved = await service.moveIssueToState('issue-1', 'Todo', 'team-1');

  assert.deepEqual(created, { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' });
  assert.deepEqual(moved, { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' });
});

test('Linear service hydrates created issues when SDK payload omits url', async () => {
  const service = createLinearService({
    client: fakeClient({
      async createIssue() {
        return { issue: { id: 'issue-1', identifier: 'MRB-1' } };
      },
      async issue(id) {
        return { id, identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' };
      }
    })
  });

  const created = await service.createIssue({ title: 'test', teamKey: 'MRB' });

  assert.deepEqual(created, { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' });
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

test('Linear service accepts raw issue arrays for batch creation', async () => {
  const batches: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssueBatch(input) {
        batches.push(input);
        return {
          issues: [
            { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/a' }
          ]
        };
      }
    })
  });

  const issues = await service.createIssueBatch([{ title: 'a', teamKey: 'MRB' }]);

  assert.deepEqual(issues.map((issue) => issue.identifier), ['MRB-1']);
  assert.equal((batches[0]?.issues as Array<Record<string, unknown>>)[0]?.title, 'a');
});

test('Linear service creates project issues using managed project defaults', async () => {
  const created: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssue(input) {
        created.push(input);
        return { issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } };
      }
    })
  });

  await service.createProjectIssue(projectFixture(), { title: 'managed issue', priority: 2, labelIds: ['label-1'] });

  assert.equal(created[0]?.teamId, 'linear-team-id');
  assert.equal(created[0]?.projectId, 'linear-project-id');
  assert.equal(created[0]?.stateId, 'state-backlog');
  assert.equal(created[0]?.priority, 2);
  assert.deepEqual(created[0]?.labelIds, ['label-1']);
});

test('Linear service creates planned issue batch and dependencies by stable keys', async () => {
  const created: Record<string, unknown>[] = [];
  const relations: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssue(input) {
        created.push(input);
        const index = created.length;
        return { issue: { id: `issue-${index}`, identifier: `MRB-${index}`, url: `https://linear.app/acme/issue/MRB-${index}/test` } };
      },
      async createIssueRelation(input) {
        relations.push(input);
        return { relation: { id: `relation-${relations.length}`, type: 'blocks' } };
      },
      async workflowStates(variables) {
        const filter = variables?.filter as { name?: { eq?: string } };
        return { nodes: [{ id: `state-${filter.name?.eq ?? 'unknown'}`, name: filter.name?.eq ?? 'unknown' }] };
      }
    })
  });

  const batch = await service.createPlannedIssueBatch(projectFixture(), {
    issues: [
      { key: 'api', title: 'Build API' },
      { key: 'ui', title: 'Build UI', stateName: 'Todo' }
    ],
    dependencies: [{ from: 'api', blocks: 'ui' }]
  });

  assert.deepEqual(batch.issues.map((issue) => issue.key), ['api', 'ui']);
  assert.deepEqual(created.map((issue) => issue.stateId), ['state-Backlog', 'state-Todo']);
  assert.deepEqual(created.map((issue) => issue.projectId), ['linear-project-id', 'linear-project-id']);
  assert.deepEqual(relations[0], { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'blocks' });
  assert.deepEqual(batch.dependencies, [{ from: 'api', blocks: 'ui', dependency: { id: 'relation-1', type: 'blocks' } }]);
});

test('Linear service links dependencies only when both issues belong to managed project', async () => {
  const relations: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssueRelation(input) {
        relations.push(input);
        return { relation: { id: 'relation-1', type: 'blocks' } };
      }
    })
  });

  const dependency = await service.linkProjectIssueDependency(projectFixture(), { blockingIssueId: 'issue-1', blockedIssueId: 'issue-2' });

  assert.deepEqual(dependency, { id: 'relation-1', type: 'blocks' });
  assert.deepEqual(relations[0], { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'blocks' });
});

test('Linear service rejects dependency links across projects', async () => {
  const service = createLinearService({
    client: fakeClient({
      async issue(id) {
        return {
          id,
          identifier: 'MRB-1',
          url: `https://linear.app/acme/issue/MRB-1/${id}`,
          team: { id: 'linear-team-id', key: 'MRB' },
          project: { id: id === 'issue-2' ? 'other-project-id' : 'linear-project-id', name: 'Meta' }
        };
      },
      async createIssueRelation() {
        assert.fail('createIssueRelation should not be called for cross-project dependencies');
      }
    })
  });

  await assert.rejects(
    service.linkProjectIssueDependency(projectFixture(), { blockingIssueId: 'issue-1', blockedIssueId: 'issue-2' }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'wrong_project');
      assert.equal(error.operation, 'link_project_issue_dependency');
      assert.deepEqual(error.details, {
        issueId: 'issue-2',
        role: 'blockedIssueId',
        expectedProjectId: 'linear-project-id',
        actualProjectId: 'other-project-id'
      });
      return true;
    }
  );
});

test('Linear service rejects dependency links across teams', async () => {
  const service = createLinearService({
    client: fakeClient({
      async issue(id) {
        return {
          id,
          identifier: 'MRB-1',
          url: `https://linear.app/acme/issue/MRB-1/${id}`,
          team: { id: id === 'issue-1' ? 'other-team-id' : 'linear-team-id', key: 'OTHER' },
          project: { id: 'linear-project-id', name: 'Meta' }
        };
      },
      async createIssueRelation() {
        assert.fail('createIssueRelation should not be called for cross-team dependencies');
      }
    })
  });

  await assert.rejects(
    service.linkProjectIssueDependency(projectFixture(), { blockingIssueId: 'issue-1', blockedIssueId: 'issue-2' }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'wrong_team');
      assert.equal(error.operation, 'link_project_issue_dependency');
      assert.deepEqual(error.details, {
        issueId: 'issue-1',
        role: 'blockingIssueId',
        expectedTeamId: 'linear-team-id',
        actualTeamId: 'other-team-id'
      });
      return true;
    }
  );
});

test('Linear service rejects dependency links for missing issues', async () => {
  const service = createLinearService({
    client: fakeClient({
      async issue(id) {
        return id === 'issue-2'
          ? undefined
          : {
            id,
            identifier: 'MRB-1',
            url: `https://linear.app/acme/issue/MRB-1/${id}`,
            team: { id: 'linear-team-id', key: 'MRB' },
            project: { id: 'linear-project-id', name: 'Meta' }
          };
      }
    })
  });

  await assert.rejects(
    service.linkProjectIssueDependency(projectFixture(), { blockingIssueId: 'issue-1', blockedIssueId: 'issue-2' }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'missing_issue');
      assert.equal(error.operation, 'link_project_issue_dependency');
      assert.deepEqual(error.details, { issueId: 'issue-2', role: 'blockedIssueId' });
      return true;
    }
  );
});

test('Linear service rejects invalid dependency direction', async () => {
  const service = createLinearService({ client: fakeClient() });

  await assert.rejects(
    service.linkProjectIssueDependency(projectFixture(), { blockingIssueId: 'issue-1', blockedIssueId: 'issue-1' }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'invalid_dependency_direction');
      assert.equal(error.operation, 'link_project_issue_dependency');
      return true;
    }
  );
});

test('Linear service returns partial batch output for invalid dependency keys', async () => {
  const service = createLinearService({
    client: fakeClient({
      async createIssue(input) {
        return { issue: { id: `issue-${input.title}`, identifier: `MRB-${input.title}`, url: `https://linear.app/acme/issue/MRB-${input.title}/test` } };
      }
    })
  });

  await assert.rejects(
    service.createPlannedIssueBatch(projectFixture(), {
      issues: [{ key: 'api', title: '1' }],
      dependencies: [{ from: 'api', blocks: 'ui' }]
    }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'planned_issue_batch_partial_failure');
      const partial = error.details.partial as Record<string, unknown>;
      assert.equal((partial.issues as unknown[]).length, 1);
      assert.deepEqual(partial.dependencies, []);
      assert.deepEqual((partial.failed as Record<string, unknown>).edge, { from: 'api', blocks: 'ui' });
      assert.equal(((partial.failed as Record<string, unknown>).error as Record<string, unknown>).code, 'invalid_dependency_key');
      return true;
    }
  );
});

test('Linear service explicitly promotes managed project issues to Todo', async () => {
  const updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  const service = createLinearService({
    client: fakeClient({
      async workflowStates(variables) {
        const filter = variables?.filter as { name?: { eq?: string }; team?: { id?: { eq?: string } } };
        assert.equal(filter.team?.id?.eq, 'linear-team-id');
        return { nodes: [{ id: `state-${filter.name?.eq ?? 'unknown'}`, name: filter.name?.eq ?? 'unknown' }] };
      },
      async updateIssue(id, input) {
        updated.push({ id, input });
        return { issue: { id, identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } };
      }
    })
  });

  await service.promoteReadyIssue(projectFixture(), 'issue-1');

  assert.deepEqual(updated[0], { id: 'issue-1', input: { stateId: 'state-Todo' } });
});

test('Linear service rejects promotion for issues outside the managed project', async () => {
  const service = createLinearService({
    client: fakeClient({
      async issue(id) {
        return {
          id,
          identifier: 'MRB-1',
          url: `https://linear.app/acme/issue/MRB-1/${id}`,
          team: { id: 'linear-team-id', key: 'MRB' },
          project: { id: 'other-project-id', name: 'Other' }
        };
      },
      async updateIssue() {
        assert.fail('updateIssue should not be called for cross-project promotion');
      }
    })
  });

  await assert.rejects(
    service.promoteReadyIssue(projectFixture(), 'issue-1'),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'wrong_project');
      assert.equal(error.operation, 'promote_ready_issue');
      return true;
    }
  );
});

test('Linear service partial batch failures include created issue references and failed operation details', async () => {
  const created: Record<string, unknown>[] = [];
  const service = createLinearService({
    client: fakeClient({
      async createIssue(input) {
        created.push(input);
        const index = created.length;
        return { issue: { id: `issue-${index}`, identifier: `MRB-${index}`, url: `https://linear.app/acme/issue/MRB-${index}/test` } };
      },
      async issue(id) {
        return {
          id,
          identifier: `MRB-${id}`,
          url: `https://linear.app/acme/issue/MRB-${id}/test`,
          team: { id: 'linear-team-id', key: 'MRB' },
          project: { id: id === 'issue-2' ? 'other-project-id' : 'linear-project-id', name: 'Meta' }
        };
      }
    })
  });

  await assert.rejects(
    service.createPlannedIssueBatch(projectFixture(), {
      issues: [
        { key: 'api', title: 'Build API' },
        { key: 'ui', title: 'Build UI' }
      ],
      dependencies: [{ from: 'api', blocks: 'ui' }]
    }),
    (error) => {
      assert.ok(error instanceof LinearServiceError);
      assert.equal(error.code, 'planned_issue_batch_partial_failure');
      const partial = error.details.partial as Record<string, unknown>;
      assert.deepEqual(partial.issues, [
        { key: 'api', issue: { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/test' } },
        { key: 'ui', issue: { id: 'issue-2', identifier: 'MRB-2', url: 'https://linear.app/acme/issue/MRB-2/test' } }
      ]);
      assert.deepEqual(partial.dependencies, []);
      assert.deepEqual(partial.failed, {
        phase: 'dependency',
        key: undefined,
        edge: { from: 'api', blocks: 'ui' },
        error: {
          name: 'LinearServiceError',
          code: 'wrong_project',
          operation: 'link_project_issue_dependency',
          message: 'Linear issue "issue-2" is not in the managed project',
          details: {
            issueId: 'issue-2',
            role: 'blockedIssueId',
            expectedProjectId: 'linear-project-id',
            actualProjectId: 'other-project-id'
          }
        }
      });
      return true;
    }
  );
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

test('Linear service resolves lazy dependency relation accessors', async () => {
  const service = createLinearService({
    client: fakeClient({
      async createIssueRelation() {
        return { relation: async () => ({ id: 'relation-1', type: 'blocks' }) };
      }
    })
  });

  const dependency = await service.createDependency({ blockingIssueId: 'issue-b', blockedIssueId: 'issue-a' });

  assert.deepEqual(dependency, { id: 'relation-1', type: 'blocks' });
});

test('Linear service smoke creates project, issue batch, and dependency link', async () => {
  const calls: Record<string, unknown[]> = { projects: [], batches: [], dependencies: [] };
  const service = createLinearService({
    client: fakeClient({
      async createProject(input) {
        calls.projects.push(input);
        return { project: { id: 'project-1', name: 'Meta', slugId: 'meta-123', url: 'https://linear.app/acme/project/meta-123' } };
      },
      async createIssueBatch(input) {
        calls.batches.push(input);
        return {
          issues: [
            { id: 'issue-1', identifier: 'MRB-1', url: 'https://linear.app/acme/issue/MRB-1/a' },
            { id: 'issue-2', identifier: 'MRB-2', url: 'https://linear.app/acme/issue/MRB-2/b' }
          ]
        };
      },
      async createIssueRelation(input) {
        calls.dependencies.push(input);
        return { relation: { id: 'relation-1', type: 'blocks' } };
      }
    })
  });

  const project = await service.createProject({ name: 'Meta', teamKey: 'MRB' });
  const issues = await service.createIssueBatch({
    issues: [
      { title: 'first', teamKey: 'MRB', projectId: project.id },
      { title: 'second', teamKey: 'MRB', projectId: project.id }
    ]
  });
  const dependency = await service.createDependency({
    blockingIssueId: issues[0].id ?? '',
    blockedIssueId: issues[1].id ?? ''
  });

  assert.equal(project.id, 'project-1');
  assert.deepEqual(issues.map((issue) => issue.identifier), ['MRB-1', 'MRB-2']);
  assert.deepEqual(calls.dependencies[0], { issueId: 'issue-1', relatedIssueId: 'issue-2', type: 'blocks' });
  assert.deepEqual(dependency, { id: 'relation-1', type: 'blocks' });
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
