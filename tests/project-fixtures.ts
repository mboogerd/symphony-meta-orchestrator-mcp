import type { ManagedProject } from '../src/index.ts';

export function managedProject(paths: {
  repoPath: string;
  workspaceRoot: string;
  logsRoot?: string;
  runnerPort?: number;
  command?: string;
  args?: string[];
  cwd?: string;
}): ManagedProject {
  const project = {
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
  } as ManagedProject;

  Object.defineProperties(project, {
    tracker: {
      enumerable: false,
      value: {
        kind: 'linear',
        teamKey: 'MRB',
        teamId: 'linear-team-id',
        projectId: 'linear-project-id',
        projectSlug: 'meta-orchestrator'
      }
    },
    repo: {
      enumerable: false,
      value: {
        path: paths.repoPath,
        remoteUrl: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
        defaultBranch: 'main',
        cloneSource: 'git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git'
      }
    },
    symphony: {
      enumerable: false,
      value: {
        command: paths.command ?? process.execPath,
        args: paths.args,
        cwd: paths.cwd,
        runnerPort: paths.runnerPort ?? 4310,
        workspaceRoot: paths.workspaceRoot,
        logsRoot: paths.logsRoot ?? `${paths.workspaceRoot}/logs`
      }
    }
  });

  return project;
}

export function managedProjectYaml(project: ManagedProject): string {
  const workflowBody = project.workflow.source === 'repo'
    ? [`      source: repo`, `      path: ${project.workflow.path}`]
    : [`      source: generated`, `      template: ${project.workflow.template}`];

  return [
    'version: 3',
    'projects:',
    `  - id: ${project.id}`,
    `    name: ${project.name}`,
    ...(project.enabled === false ? ['    enabled: false'] : []),
    `    githubUrl: ${project.githubUrl}`,
    '    workflow:',
    ...workflowBody,
    '    codex:',
    `      threadSandbox: ${project.codex.threadSandbox}`,
    '      turnSandbox:',
    ...renderTurnSandboxYaml(project.codex.turnSandbox, 8),
    ''
  ].join('\n');
}

function renderTurnSandboxYaml(value: ManagedProject['codex']['turnSandbox'], spaces: number): string[] {
  const indent = ' '.repeat(spaces);
  return Object.entries(value).flatMap(([key, entry]) => {
    if (Array.isArray(entry)) {
      return [`${indent}${key}:`, ...entry.map((item) => `${indent}  - ${item}`)];
    }

    return [`${indent}${key}: ${entry}`];
  });
}
