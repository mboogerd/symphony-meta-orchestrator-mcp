import { IssueRelationType, LinearClient } from '@linear/sdk';
import type { ManagedProject } from '../registry/index.ts';

export type LinearIssueReference = {
  id?: string;
  identifier: string;
  url: string;
};

export type LinearProjectReference = {
  id: string;
  name: string;
  slugId: string;
  url: string;
  teamId: string;
};

export type LinearProjectLookupResult = LinearProjectReference & {
  teamId: string;
};

export type FindLinearProjectInput = {
  name?: string;
  slugId?: string;
};

export type LinearTeamReference = {
  id: string;
  key: string;
  name?: string;
  description?: string;
};

export type LinearWorkflowStateReference = {
  id: string;
  name: string;
  type?: string;
};

export type CreateLinearProjectInput = {
  name: string;
  teamId?: string;
  teamKey?: string;
  description?: string;
  leadId?: string;
};

export type CreateLinearIssueInput = {
  title: string;
  teamId?: string;
  teamKey?: string;
  description?: string;
  projectId?: string;
  stateId?: string;
  stateName?: string;
  assigneeId?: string;
  priority?: number;
  labelIds?: string[];
};

export type CreateLinearIssueBatchInput = {
  issues: CreateLinearIssueInput[];
};
export type CreateLinearIssueBatchServiceInput = CreateLinearIssueBatchInput | CreateLinearIssueInput[];

export type CreateLinearDependencyInput = {
  blockingIssueId: string;
  blockedIssueId: string;
};

export type CreateProjectIssueInput = Omit<CreateLinearIssueInput, 'teamId' | 'teamKey' | 'projectId'>;

export type PlannedIssueInput = CreateProjectIssueInput & {
  key: string;
};

export type PlannedIssueDependencyInput = {
  from: string;
  blocks: string;
};

export type CreatePlannedIssueBatchInput = {
  issues: PlannedIssueInput[];
  dependencies?: PlannedIssueDependencyInput[];
};

export type CreateLinearProjectPlannedIssueBatchInput = CreatePlannedIssueBatchInput & {
  teamId?: string;
  teamKey?: string;
  linearProjectId: string;
};

export type PlannedIssueResult = {
  key: string;
  issue: LinearIssueReference;
};

export type PlannedIssueDependencyResult = PlannedIssueDependencyInput & {
  dependency: {
    id: string;
    type: string;
  };
};

export type PlannedIssueBatchResult = {
  issues: PlannedIssueResult[];
  dependencies: PlannedIssueDependencyResult[];
};

export type PlannedIssueBatchPartialResult = PlannedIssueBatchResult & {
  failed: {
    phase: 'issue' | 'dependency';
    key?: string;
    edge?: PlannedIssueDependencyInput;
    error: Record<string, unknown>;
  };
};

export type LinearServiceOptions = {
  apiKey?: string;
  client?: LinearSdkClient;
};

type MaybePromise<T> = T | Promise<T>;
type MaybeLazy<T> = MaybePromise<T> | (() => MaybePromise<T>);

export type LinearSdkClient = {
  issue(id: string): Promise<LinearIssueLike | undefined>;
  createProject(input: Record<string, unknown>): Promise<LinearPayload<'project', LinearProjectLike>>;
  createIssue(input: Record<string, unknown>): Promise<LinearPayload<'issue', LinearIssueLike>>;
  createIssueBatch(input: Record<string, unknown>): Promise<LinearPayload<'issues', LinearIssueLike[]>>;
  createIssueRelation(input: Record<string, unknown>): Promise<LinearPayload<'issueRelation', LinearRelationLike>>;
  updateIssue(id: string, input: Record<string, unknown>): Promise<LinearPayload<'issue', LinearIssueLike>>;
  projects(variables?: Record<string, unknown>): Promise<LinearConnection<LinearProjectLike>>;
  teams(variables?: Record<string, unknown>): Promise<LinearConnection<LinearTeamLike>>;
  workflowStates(variables?: Record<string, unknown>): Promise<LinearConnection<LinearWorkflowStateLike>>;
};

type LinearPayload<Key extends string, Value> = { success?: boolean } & { [K in Key]?: MaybeLazy<Value> };
type LinearConnection<Node> = { nodes: Node[] };
type LinearTeamLike = {
  id: string;
  key?: string;
  name?: string;
  description?: string;
  projects?: MaybePromise<LinearConnection<LinearProjectLike>> | ((variables?: Record<string, unknown>) => Promise<LinearConnection<LinearProjectLike>>);
};
type LinearProjectLike = {
  id: string;
  name: string;
  slugId?: string;
  url?: string;
  team?: MaybePromise<LinearTeamLike>;
  teams?: MaybePromise<LinearConnection<LinearTeamLike>> | ((variables?: Record<string, unknown>) => Promise<LinearConnection<LinearTeamLike>>);
  teamIds?: string[];
};
type LinearIssueLike = {
  id: string;
  identifier: string;
  url?: string;
  state?: Promise<LinearWorkflowStateLike> | LinearWorkflowStateLike;
  team?: Promise<LinearTeamLike> | LinearTeamLike;
  project?: Promise<LinearProjectLike | undefined> | LinearProjectLike;
};
type LinearRelationLike = { id: string; type: string; issueId?: string; relatedIssueId?: string };
type LinearWorkflowStateLike = { id: string; name: string; type?: string };

export class LinearServiceError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly causeError: unknown;
  readonly details: Record<string, unknown>;

  constructor(code: string, operation: string, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(message);
    this.name = 'LinearServiceError';
    this.code = code;
    this.operation = operation;
    this.details = details;
    this.causeError = cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      message: this.message,
      details: this.details
    };
  }
}

export class LinearService {
  private readonly client: LinearSdkClient;

  constructor(options: LinearServiceOptions = {}) {
    if (options.client) {
      this.client = options.client;
      return;
    }

    if (!options.apiKey) {
      throw new LinearServiceError('missing_api_key', 'constructor', 'Linear API key is required');
    }

    this.client = new LinearClient({ apiKey: options.apiKey }) as unknown as LinearSdkClient;
  }

  async createProject(input: CreateLinearProjectInput): Promise<LinearProjectReference> {
    return this.wrap('create_project', async () => {
      const teamId = input.teamId ?? await this.findTeamId(input.teamKey);
      const teamIds = [teamId];
      const payload = await this.client.createProject({
        name: input.name,
        description: input.description,
        leadId: input.leadId,
        teamIds
      });
      const project = await requirePayloadEntity(payload.project, 'project', 'create_project');
      return {
        ...this.toProjectReference(await this.hydrateProjectReference(project, 'create_project'), 'create_project'),
        teamId
      };
    });
  }

  async resolveTeam(teamKey: string): Promise<LinearTeamReference> {
    return this.wrap('resolve_team', async () => {
      const team = await this.findTeam(teamKey);
      return this.toTeamReference(team, 'resolve_team');
    });
  }

  async listTeams(): Promise<LinearTeamReference[]> {
    return this.wrap('list_teams', async () => {
      const teams = await this.client.teams();
      return teams.nodes.map((team) => this.toTeamReference(team, 'list_teams'));
    });
  }

  async createIssue(input: CreateLinearIssueInput): Promise<LinearIssueReference> {
    return this.wrap('create_issue', async () => {
      const teamId = input.teamId ?? await this.findTeamId(input.teamKey);
      const stateId = input.stateId ?? await this.findStateId(teamId, input.stateName ?? 'Backlog');
      const payload = await this.client.createIssue({
        title: input.title,
        description: input.description,
        teamId,
        projectId: input.projectId,
        stateId,
        assigneeId: input.assigneeId,
        priority: input.priority,
        labelIds: input.labelIds
      });
      return this.toIssueReference(await requirePayloadEntity(payload.issue, 'issue', 'create_issue'), 'create_issue');
    });
  }

  async resolveProjectSlug(slugId: string): Promise<LinearProjectReference | undefined> {
    return this.wrap('resolve_project', async () => {
      const projects = await this.client.projects({ filter: { slugId: { eq: linearProjectSlugId(slugId) } }, first: 1 });
      const project = projects.nodes[0];
      return project === undefined ? undefined : this.toProjectReference(project, 'resolve_project');
    });
  }

  async findProjects(input: FindLinearProjectInput): Promise<LinearProjectLookupResult[]> {
    return this.wrap('find_project', async () => {
      const filter: Record<string, unknown> = {};
      const name = input.name?.trim();
      const slugId = input.slugId?.trim();

      if (name) {
        filter.name = { containsIgnoreCase: name };
      }

      if (slugId) {
        filter.slugId = { eq: slugId };
      }

      const projects = await this.client.projects({
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        first: 50,
        includeArchived: true
      });
      return Promise.all(projects.nodes.map(async (project) => this.toProjectLookupResult(project, 'find_project')));
    });
  }

  async resolveProjectForTeam(projectId: string, teamId: string): Promise<LinearProjectReference> {
    return this.wrap('resolve_project', async () => {
      const teams = await this.client.teams({ filter: { id: { eq: teamId } }, first: 1 });
      const team = teams.nodes[0];
      const projects = team?.projects === undefined
        ? { nodes: [] }
        : typeof team.projects === 'function'
          ? await team.projects({ filter: { id: { eq: projectId } }, first: 1 })
          : await team.projects;
      const project = projects.nodes[0];
      if (!project) {
        throw new LinearServiceError(
          'project_not_found',
          'resolve_project',
          `Linear project "${projectId}" was not found in the resolved team`,
          { projectId, teamId }
        );
      }

      return {
        ...this.toProjectReference(await this.hydrateProjectReference(project, 'resolve_project'), 'resolve_project'),
        teamId
      };
    });
  }

  async findProjectByNameForTeam(name: string, teamId: string): Promise<LinearProjectReference | undefined> {
    return this.wrap('find_project_for_team', async () => {
      const projectName = name.trim();
      if (!projectName) {
        return undefined;
      }

      const teams = await this.client.teams({ filter: { id: { eq: teamId } }, first: 1 });
      const team = teams.nodes[0];
      const projects = team?.projects === undefined
        ? { nodes: [] }
        : typeof team.projects === 'function'
          ? await team.projects({ filter: { name: { eqIgnoreCase: projectName } }, first: 2 })
          : await team.projects;
      const matchingProjects = projects.nodes.filter((project) => project.name.localeCompare(projectName, undefined, { sensitivity: 'accent' }) === 0);

      if (matchingProjects.length > 1) {
        throw new LinearServiceError(
          'duplicate_project_name',
          'find_project_for_team',
          `Multiple Linear projects named "${projectName}" were found in the resolved team`,
          { name: projectName, teamId, count: matchingProjects.length }
        );
      }

      const project = matchingProjects[0];
      return project === undefined
        ? undefined
        : {
            ...this.toProjectReference(await this.hydrateProjectReference(project, 'find_project_for_team'), 'find_project_for_team'),
            teamId
          };
    });
  }

  async createIssueBatch(input: CreateLinearIssueBatchServiceInput): Promise<LinearIssueReference[]> {
    return this.wrap('create_issue_batch', async () => {
      const inputIssues = Array.isArray(input) ? input : input.issues;
      const issues = await Promise.all(inputIssues.map(async (issue) => {
        const teamId = issue.teamId ?? await this.findTeamId(issue.teamKey);
        const stateId = issue.stateId ?? await this.findStateId(teamId, issue.stateName ?? 'Backlog');
        return {
          title: issue.title,
          description: issue.description,
          teamId,
          projectId: issue.projectId,
          stateId,
          assigneeId: issue.assigneeId,
          priority: issue.priority,
          labelIds: issue.labelIds
        };
      }));
      const payload = await this.client.createIssueBatch({ issues });
      const createdIssues = await requirePayloadEntity(payload.issues, 'issues', 'create_issue_batch');
      return Promise.all(createdIssues.map(async (issue) => this.toIssueReference(await issue, 'create_issue_batch')));
    });
  }

  async createProjectIssue(project: ManagedProject, input: CreateProjectIssueInput): Promise<LinearIssueReference> {
    return this.createIssue({
      ...input,
      teamId: project.tracker.teamId,
      projectId: project.tracker.projectId
    });
  }

  async createPlannedIssueBatch(project: ManagedProject, input: CreatePlannedIssueBatchInput): Promise<PlannedIssueBatchResult> {
    return this.createPlannedIssueBatchForScope({
      operation: 'create_planned_issue_batch',
      teamId: project.tracker.teamId,
      projectId: project.tracker.projectId
    }, input, true);
  }

  async createLinearProjectPlannedIssueBatch(input: CreateLinearProjectPlannedIssueBatchInput): Promise<PlannedIssueBatchResult> {
    const teamId = input.teamId ?? await this.findTeamId(input.teamKey);
    await this.resolveProjectForTeam(input.linearProjectId, teamId);
    return this.createPlannedIssueBatchForScope({
      operation: 'create_linear_project_planned_issue_batch',
      teamId,
      projectId: input.linearProjectId
    }, input, false);
  }

  private async createPlannedIssueBatchForScope(
    scope: { operation: string; teamId: string; projectId: string },
    input: CreatePlannedIssueBatchInput,
    managedProjectDependencyValidation: boolean
  ): Promise<PlannedIssueBatchResult> {
    const issues: PlannedIssueResult[] = [];
    const dependencies: PlannedIssueDependencyResult[] = [];
    const issueIdsByKey = new Map<string, string>();

    for (const issue of input.issues) {
      if (issueIdsByKey.has(issue.key)) {
        throw partialBatchError('issue', issues, dependencies, new LinearServiceError(
          'duplicate_issue_key',
          scope.operation,
          `Duplicate issue key "${issue.key}"`,
          { key: issue.key }
        ), scope.operation, undefined, issue.key);
      }

      try {
        const created = await this.createIssue({
          ...issue,
          teamId: scope.teamId,
          projectId: scope.projectId
        });
        if (!created.id) {
          throw new LinearServiceError('missing_issue_id', scope.operation, `Created issue for key "${issue.key}" did not include an id`, { key: issue.key });
        }

        issueIdsByKey.set(issue.key, created.id);
        issues.push({ key: issue.key, issue: created });
      } catch (error) {
        throw partialBatchError('issue', issues, dependencies, error, scope.operation, undefined, issue.key);
      }
    }

    for (const edge of input.dependencies ?? []) {
      const blockingIssueId = issueIdsByKey.get(edge.from);
      const blockedIssueId = issueIdsByKey.get(edge.blocks);

      if (!blockingIssueId || !blockedIssueId) {
        const missingKeys = [!blockingIssueId ? edge.from : undefined, !blockedIssueId ? edge.blocks : undefined].filter((key): key is string => key !== undefined);
        throw partialBatchError('dependency', issues, dependencies, new LinearServiceError(
          'invalid_dependency_key',
          scope.operation,
          `Dependency references unknown issue key(s): ${missingKeys.join(', ')}`,
          { edge, missingKeys }
        ), scope.operation, edge);
      }

      try {
        const dependency = managedProjectDependencyValidation
          ? await this.linkScopedIssueDependency(scope, { blockingIssueId, blockedIssueId }, 'link_project_issue_dependency')
          : await this.linkScopedIssueDependency(scope, { blockingIssueId, blockedIssueId }, 'link_linear_project_issue_dependency');
        dependencies.push({ ...edge, dependency });
      } catch (error) {
        throw partialBatchError('dependency', issues, dependencies, error, scope.operation, edge);
      }
    }

    return { issues, dependencies };
  }

  async promoteReadyIssue(project: ManagedProject, issueId: string): Promise<LinearIssueReference> {
    await this.assertManagedProjectIssue(project, issueId, 'promote_ready_issue');
    return this.moveIssueToState(issueId, 'Todo', project.tracker.teamId);
  }

  async linkProjectIssueDependency(project: ManagedProject, input: CreateLinearDependencyInput): Promise<{ id: string; type: string }> {
    return this.linkScopedIssueDependency({
      operation: 'link_project_issue_dependency',
      teamId: project.tracker.teamId,
      projectId: project.tracker.projectId
    }, input, 'link_project_issue_dependency');
  }

  private async linkScopedIssueDependency(
    scope: { teamId: string; projectId: string },
    input: CreateLinearDependencyInput,
    operation: string
  ): Promise<{ id: string; type: string }> {
    if (input.blockingIssueId === input.blockedIssueId) {
      throw new LinearServiceError(
        'invalid_dependency_direction',
        operation,
        'Dependency direction must reference two distinct project issues',
        { blockingIssueId: input.blockingIssueId, blockedIssueId: input.blockedIssueId }
      );
    }

    await this.assertScopedProjectIssue(scope, input.blockingIssueId, operation, 'blockingIssueId');
    await this.assertScopedProjectIssue(scope, input.blockedIssueId, operation, 'blockedIssueId');
    return this.createDependency(input);
  }

  async moveIssueToState(issueId: string, stateNameOrId: string, teamId?: string): Promise<LinearIssueReference> {
    return this.wrap('move_issue_state', async () => {
      const stateId = isUuidLike(stateNameOrId) ? stateNameOrId : await this.findStateId(teamId, stateNameOrId);
      const payload = await this.client.updateIssue(issueId, { stateId });
      return this.toIssueReference(await requirePayloadEntity(payload.issue, 'issue', 'move_issue_state'), 'move_issue_state');
    });
  }

  async createDependency(input: CreateLinearDependencyInput): Promise<{ id: string; type: string }> {
    return this.wrap('create_dependency', async () => {
      const payload = await this.client.createIssueRelation({
        issueId: input.blockingIssueId,
        relatedIssueId: input.blockedIssueId,
        type: IssueRelationType.Blocks
      });
      const relation = await requirePayloadEntity(payload.issueRelation, 'issueRelation', 'create_dependency');
      return { id: relation.id, type: relation.type };
    });
  }

  private async findTeamId(teamKey: string | undefined): Promise<string> {
    return (await this.findTeam(teamKey)).id;
  }

  private async findTeam(teamKey: string | undefined): Promise<LinearTeamLike> {
    if (!teamKey) {
      throw new LinearServiceError('missing_team', 'resolve_team', 'teamId or teamKey is required');
    }

    const teams = await this.client.teams({ filter: { key: { eq: teamKey } }, first: 1 });
    const team = teams.nodes[0];
    if (!team) {
      throw new LinearServiceError('team_not_found', 'resolve_team', `Linear team "${teamKey}" was not found`, { teamKey });
    }

    return team;
  }

  private async findStateId(teamId: string | undefined, stateName: string): Promise<string> {
    const filter: Record<string, unknown> = { name: { eq: stateName } };
    if (teamId) {
      filter.team = { id: { eq: teamId } };
    }

    const states = await this.client.workflowStates({ filter, first: 1 });
    const state = states.nodes[0];
    if (!state) {
      throw new LinearServiceError('state_not_found', 'resolve_state', `Linear workflow state "${stateName}" was not found`, { stateName, teamId });
    }

    return state.id;
  }

  private async assertManagedProjectIssue(project: ManagedProject, issueId: string, operation: string, role = 'issueId'): Promise<void> {
    return this.assertScopedProjectIssue({
      teamId: project.tracker.teamId,
      projectId: project.tracker.projectId
    }, issueId, operation, role);
  }

  private async assertScopedProjectIssue(scope: { teamId: string; projectId: string }, issueId: string, operation: string, role = 'issueId'): Promise<void> {
    const issue = await this.client.issue(issueId);
    if (!issue) {
      throw new LinearServiceError('missing_issue', operation, `Linear issue "${issueId}" was not found`, { issueId, role });
    }

    const team = await issue.team;
    if (!team || team.id !== scope.teamId) {
      const expectedScope = operation === 'link_project_issue_dependency' || operation === 'promote_ready_issue'
        ? 'managed'
        : 'expected';
      throw new LinearServiceError(
        'wrong_team',
        operation,
        `Linear issue "${issueId}" is not in the ${expectedScope} team`,
        { issueId, role, expectedTeamId: scope.teamId, actualTeamId: team?.id }
      );
    }

    const issueProject = await issue.project;
    if (!issueProject || issueProject.id !== scope.projectId) {
      const expectedScope = operation === 'link_project_issue_dependency' || operation === 'promote_ready_issue'
        ? 'managed'
        : 'expected';
      throw new LinearServiceError(
        'wrong_project',
        operation,
        `Linear issue "${issueId}" is not in the ${expectedScope} project`,
        { issueId, role, expectedProjectId: scope.projectId, actualProjectId: issueProject?.id }
      );
    }
  }

  private async hydrateProjectReference(project: LinearProjectLike, operation: string): Promise<LinearProjectLike> {
    if (project.slugId !== undefined && project.url !== undefined) {
      return project;
    }

    const projects = await this.client.projects({ filter: { id: { eq: project.id } }, first: 1 });
    const hydrated = requireEntity(projects.nodes[0], 'project', operation);
    return { ...project, ...hydrated };
  }

  private toProjectReference(project: LinearProjectLike, operation: string): LinearProjectReference {
    return {
      id: project.id,
      name: project.name,
      slugId: requireString(project.slugId, 'project.slugId', operation),
      url: requireString(project.url, 'project.url', operation)
    };
  }

  private toTeamReference(team: LinearTeamLike, operation: string): LinearTeamReference {
    return {
      id: team.id,
      key: requireString(team.key, 'team.key', operation),
      name: team.name,
      description: team.description
    };
  }

  private async toProjectLookupResult(project: LinearProjectLike, operation: string): Promise<LinearProjectLookupResult> {
    return {
      ...this.toProjectReference(project, operation),
      teamId: await this.projectTeamId(project, operation)
    };
  }

  private async projectTeamId(project: LinearProjectLike, operation: string): Promise<string> {
    const teams = typeof project.teams === 'function'
      ? await project.teams({ first: 1 })
      : await project.teams;
    const teamId = project.teamIds?.[0] ?? (await project.team)?.id ?? teams?.nodes[0]?.id;
    return requireString(teamId, 'project.teamId', operation);
  }

  private async toIssueReference(issue: LinearIssueLike, operation: string): Promise<LinearIssueReference> {
    const hydrated = issue.url === undefined ? { ...issue, ...await requirePayloadEntity(this.client.issue(issue.id), 'issue', operation) } : issue;
    return {
      id: hydrated.id,
      identifier: hydrated.identifier,
      url: requireString(hydrated.url, 'issue.url', operation)
    };
  }

  private async wrap<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof LinearServiceError) {
        throw error;
      }

      throw new LinearServiceError('linear_sdk_error', operation, error instanceof Error ? error.message : String(error), {}, error);
    }
  }
}

export function linearProjectUrlSlug(project: Pick<LinearProjectReference, 'slugId' | 'url'>): string {
  try {
    const url = new URL(project.url);
    const slug = url.pathname.split('/').filter(Boolean).at(-1)?.trim();
    return slug && slug !== 'project' ? slug : project.slugId;
  } catch {
    return project.slugId;
  }
}

function linearProjectSlugId(projectSlug: string): string {
  const slug = projectSlug.trim();
  return slug.includes('-') ? slug.slice(slug.lastIndexOf('-') + 1) : slug;
}

export function createLinearService(options: LinearServiceOptions = {}): LinearService {
  return new LinearService(options);
}

export function formatLinearIssueReference(issue: LinearIssueReference): string {
  return `${issue.identifier} (${issue.url})`;
}

function requireEntity<T>(entity: T | undefined, path: string, operation: string): T {
  if (entity === undefined || entity === null) {
    throw new LinearServiceError('missing_payload_entity', operation, `Linear response did not include ${path}`, { path });
  }

  return entity;
}

async function requirePayloadEntity<T>(entity: MaybeLazy<T | undefined> | undefined, path: string, operation: string): Promise<T> {
  const resolved = typeof entity === 'function' ? await entity() : await entity;
  return requireEntity(resolved, path, operation);
}

function requireString(value: unknown, path: string, operation: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LinearServiceError('missing_payload_field', operation, `Linear response did not include ${path}`, { path });
  }

  return value;
}

function partialBatchError(
  phase: 'issue' | 'dependency',
  issues: PlannedIssueResult[],
  dependencies: PlannedIssueDependencyResult[],
  error: unknown,
  operation: string,
  edge?: PlannedIssueDependencyInput,
  key?: string
): LinearServiceError {
  const structuredError = error instanceof LinearServiceError
    ? error.toJSON()
    : { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };

  return new LinearServiceError(
    'planned_issue_batch_partial_failure',
    operation,
    `Failed to create planned issue batch during ${phase} creation`,
    {
      partial: {
        issues,
        dependencies,
        failed: {
          phase,
          key,
          edge,
          error: structuredError
        }
      } satisfies PlannedIssueBatchPartialResult
    },
    error
  );
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
