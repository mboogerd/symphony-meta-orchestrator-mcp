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
  return {
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
      path: paths.repoPath,
      remoteUrl: 'https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git',
      defaultBranch: 'main',
      cloneSource: 'git@github.com:mboogerd/symphony-meta-orchestrator-mcp.git'
    },
    workflow: {
      source: 'repo',
      path: 'WORKFLOW.md'
    },
    symphony: {
      command: paths.command ?? process.execPath,
      args: paths.args,
      cwd: paths.cwd,
      runnerPort: paths.runnerPort ?? 4310,
      workspaceRoot: paths.workspaceRoot,
      logsRoot: paths.logsRoot ?? `${paths.workspaceRoot}/logs`
    },
    codex: {
      threadSandbox: 'workspace-write',
      turnSandbox: 'workspace-write'
    }
  };
}

export function managedProjectYaml(project: ManagedProject): string {
  const workflowBody = project.workflow.source === 'repo'
    ? [`      source: repo`, `      path: ${project.workflow.path}`]
    : [`      source: generated`, `      template: ${project.workflow.template}`];

  return [
    'version: 2',
    'projects:',
    `  - id: ${project.id}`,
    `    name: ${project.name}`,
    '    tracker:',
    '      kind: linear',
    `      teamKey: ${project.tracker.teamKey}`,
    `      teamId: ${project.tracker.teamId}`,
    `      projectId: ${project.tracker.projectId}`,
    `      projectSlug: ${project.tracker.projectSlug}`,
    '    repo:',
    `      path: ${project.repo.path}`,
    `      remoteUrl: ${project.repo.remoteUrl}`,
    `      defaultBranch: ${project.repo.defaultBranch}`,
    `      cloneSource: ${project.repo.cloneSource}`,
    '    workflow:',
    ...workflowBody,
    '    symphony:',
    `      command: ${project.symphony.command}`,
    ...(project.symphony.args === undefined ? [] : [
      '      args:',
      ...project.symphony.args.map((arg) => `        - ${JSON.stringify(arg)}`)
    ]),
    ...(project.symphony.cwd === undefined ? [] : [`      cwd: ${project.symphony.cwd}`]),
    `      runnerPort: ${project.symphony.runnerPort}`,
    `      workspaceRoot: ${project.symphony.workspaceRoot}`,
    `      logsRoot: ${project.symphony.logsRoot}`,
    ...(project.symphony.dashboardUrl === undefined ? [] : [`      dashboardUrl: ${project.symphony.dashboardUrl}`]),
    '    codex:',
    `      threadSandbox: ${project.codex.threadSandbox}`,
    `      turnSandbox: ${project.codex.turnSandbox}`,
    ''
  ].join('\n');
}
