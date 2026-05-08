import { IssueRelationType, LinearClient } from '@linear/sdk';

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
};

export type CreateLinearIssueBatchInput = {
  issues: CreateLinearIssueInput[];
};

export type CreateLinearDependencyInput = {
  blockingIssueId: string;
  blockedIssueId: string;
};

export type LinearServiceOptions = {
  apiKey?: string;
  client?: LinearSdkClient;
};

export type LinearSdkClient = {
  createProject(input: Record<string, unknown>): Promise<LinearPayload<'project', LinearProjectLike>>;
  createIssue(input: Record<string, unknown>): Promise<LinearPayload<'issue', LinearIssueLike>>;
  createIssueBatch(input: Record<string, unknown>): Promise<LinearPayload<'issues', LinearIssueLike[]>>;
  createIssueRelation(input: Record<string, unknown>): Promise<LinearPayload<'relation', LinearRelationLike>>;
  updateIssue(id: string, input: Record<string, unknown>): Promise<LinearPayload<'issue', LinearIssueLike>>;
  teams(variables?: Record<string, unknown>): Promise<LinearConnection<LinearTeamLike>>;
  workflowStates(variables?: Record<string, unknown>): Promise<LinearConnection<LinearWorkflowStateLike>>;
};

type LinearPayload<Key extends string, Value> = { success?: boolean } & { [K in Key]?: Value };
type LinearConnection<Node> = { nodes: Node[] };
type LinearTeamLike = { id: string; key?: string; name?: string };
type LinearProjectLike = { id: string; name: string; slugId?: string; url?: string };
type LinearIssueLike = { id: string; identifier: string; url?: string; state?: Promise<LinearWorkflowStateLike> | LinearWorkflowStateLike };
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
      const teamIds = [input.teamId ?? await this.findTeamId(input.teamKey)];
      const payload = await this.client.createProject({
        name: input.name,
        description: input.description,
        leadId: input.leadId,
        teamIds
      });
      const project = requireEntity(payload.project, 'project', 'create_project');
      return {
        id: project.id,
        name: project.name,
        slugId: requireString(project.slugId, 'project.slugId', 'create_project'),
        url: requireString(project.url, 'project.url', 'create_project')
      };
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
        priority: input.priority
      });
      return toIssueReference(requireEntity(payload.issue, 'issue', 'create_issue'));
    });
  }

  async createIssueBatch(input: CreateLinearIssueBatchInput): Promise<LinearIssueReference[]> {
    return this.wrap('create_issue_batch', async () => {
      const issues = await Promise.all(input.issues.map(async (issue) => {
        const teamId = issue.teamId ?? await this.findTeamId(issue.teamKey);
        const stateId = issue.stateId ?? await this.findStateId(teamId, issue.stateName ?? 'Backlog');
        return {
          title: issue.title,
          description: issue.description,
          teamId,
          projectId: issue.projectId,
          stateId,
          assigneeId: issue.assigneeId,
          priority: issue.priority
        };
      }));
      const payload = await this.client.createIssueBatch({ issues });
      return requireEntity(payload.issues, 'issues', 'create_issue_batch').map(toIssueReference);
    });
  }

  async moveIssueToState(issueId: string, stateNameOrId: string, teamId?: string): Promise<LinearIssueReference> {
    return this.wrap('move_issue_state', async () => {
      const stateId = isUuidLike(stateNameOrId) ? stateNameOrId : await this.findStateId(teamId, stateNameOrId);
      const payload = await this.client.updateIssue(issueId, { stateId });
      return toIssueReference(requireEntity(payload.issue, 'issue', 'move_issue_state'));
    });
  }

  async createDependency(input: CreateLinearDependencyInput): Promise<{ id: string; type: string }> {
    return this.wrap('create_dependency', async () => {
      const payload = await this.client.createIssueRelation({
        issueId: input.blockingIssueId,
        relatedIssueId: input.blockedIssueId,
        type: IssueRelationType.Blocks
      });
      const relation = requireEntity(payload.relation, 'relation', 'create_dependency');
      return { id: relation.id, type: relation.type };
    });
  }

  private async findTeamId(teamKey: string | undefined): Promise<string> {
    if (!teamKey) {
      throw new LinearServiceError('missing_team', 'resolve_team', 'teamId or teamKey is required');
    }

    const teams = await this.client.teams({ filter: { key: { eq: teamKey } }, first: 1 });
    const team = teams.nodes[0];
    if (!team) {
      throw new LinearServiceError('team_not_found', 'resolve_team', `Linear team "${teamKey}" was not found`, { teamKey });
    }

    return team.id;
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

export function createLinearService(options: LinearServiceOptions = {}): LinearService {
  return new LinearService(options);
}

export function formatLinearIssueReference(issue: LinearIssueReference): string {
  return `${issue.identifier} (${issue.url})`;
}

function toIssueReference(issue: LinearIssueLike): LinearIssueReference {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: requireString(issue.url, 'issue.url', 'issue')
  };
}

function requireEntity<T>(entity: T | undefined, path: string, operation: string): T {
  if (entity === undefined || entity === null) {
    throw new LinearServiceError('missing_payload_entity', operation, `Linear response did not include ${path}`, { path });
  }

  return entity;
}

function requireString(value: unknown, path: string, operation: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LinearServiceError('missing_payload_field', operation, `Linear response did not include ${path}`, { path });
  }

  return value;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
