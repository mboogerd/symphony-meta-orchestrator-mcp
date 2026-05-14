import { basename, resolve } from 'node:path';
import type { LinearProjectReference, LinearService, LinearTeamReference } from '../linear/index.ts';
import type { ManagedProject, ProjectRegistryService } from '../registry/index.ts';
import type { RunnerManager, RunnerStartResult } from '../runner/index.ts';
import { writeProjectWorkflow, type WorkflowRenderResult } from '../workflow/index.ts';

export type SetupProjectInput = {
  name: string;
  teamKey: string;
  repoPath: string;
  runnerPort: number;
  workspaceRoot: string;
  logsRoot: string;
  startRunner?: boolean;
};

export type SetupProjectStepName = 'linearProject' | 'registry' | 'workflow' | 'runner';

export type SetupProjectStepResult = {
  name: SetupProjectStepName;
  status: 'ok' | 'skipped' | 'error';
  output?: unknown;
  error?: Record<string, unknown>;
};

export type SetupProjectResult = {
  project?: ManagedProject;
  linearProject?: LinearProjectReference;
  team?: LinearTeamReference;
  workflow?: WorkflowRenderResult;
  runner?: RunnerStartResult;
  steps: SetupProjectStepResult[];
};

export type SetupProjectServices = {
  linear: LinearService;
  registry: ProjectRegistryService;
  runnerManager: RunnerManager;
};

export async function setupManagedProject(input: SetupProjectInput, services: SetupProjectServices): Promise<SetupProjectResult> {
  const steps: SetupProjectStepResult[] = [];
  let team: LinearTeamReference | undefined;
  let linearProject: LinearProjectReference | undefined;
  let project: ManagedProject | undefined;
  let workflow: WorkflowRenderResult | undefined;
  let runner: RunnerStartResult | undefined;

  try {
    team = await services.linear.resolveTeam(input.teamKey);
    linearProject = await services.linear.createProject({ name: input.name, teamId: team.id });
    steps.push({ name: 'linearProject', status: 'ok', output: { team, project: linearProject } });
  } catch (error) {
    steps.push({ name: 'linearProject', status: 'error', error: structuredError(error) });
    return { team, linearProject, steps };
  }

  try {
    project = buildManagedProject(input, team, linearProject);
    project = await services.registry.create(project);
    steps.push({ name: 'registry', status: 'ok', output: { project } });
  } catch (error) {
    steps.push({ name: 'registry', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, steps };
  }

  try {
    workflow = await writeProjectWorkflow(project);
    steps.push({ name: 'workflow', status: 'ok', output: { workflow } });
  } catch (error) {
    steps.push({ name: 'workflow', status: 'error', error: structuredError(error) });
    return { team, linearProject, project, workflow, steps };
  }

  if (input.startRunner === true) {
    try {
      runner = await services.runnerManager.start(project);
      steps.push({ name: 'runner', status: 'ok', output: { runner } });
    } catch (error) {
      steps.push({ name: 'runner', status: 'error', error: structuredError(error) });
      return { team, linearProject, project, workflow, runner, steps };
    }
  } else {
    steps.push({ name: 'runner', status: 'skipped', output: { reason: 'startRunner was not true' } });
  }

  return { team, linearProject, project, workflow, runner, steps };
}

function buildManagedProject(input: SetupProjectInput, team: LinearTeamReference, linearProject: LinearProjectReference): ManagedProject {
  const repoPath = resolve(input.repoPath);
  const workspaceRoot = resolve(input.workspaceRoot);
  const logsRoot = resolve(input.logsRoot);

  return {
    id: slugify(input.name),
    name: input.name,
    tracker: {
      kind: 'linear',
      teamKey: team.key,
      teamId: team.id,
      projectId: linearProject.id,
      projectSlug: linearProject.slugId
    },
    repo: {
      path: repoPath,
      remoteUrl: repoPath,
      defaultBranch: 'main',
      cloneSource: repoPath
    },
    workflow: {
      source: 'generated',
      template: 'default'
    },
    symphony: {
      command: 'mise',
      args: [
        'exec',
        '--',
        './bin/symphony',
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
      ],
      cwd: repoPath,
      runnerPort: input.runnerPort,
      workspaceRoot,
      logsRoot,
      dashboardUrl: `http://localhost:${input.runnerPort}`
    },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: {
        type: 'workspaceWrite',
        networkAccess: true
      }
    }
  };
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : basename(process.cwd());
}

function structuredError(error: unknown): Record<string, unknown> {
  if (error !== null && typeof error === 'object' && 'toJSON' in error && typeof error.toJSON === 'function') {
    return error.toJSON() as Record<string, unknown>;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: 'Error',
    message: String(error)
  };
}
