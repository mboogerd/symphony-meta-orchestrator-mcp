import type { ManagedProject } from './index.ts';

export const projectSchemaGuidance = {
  summary: 'register_project expects a complete managed project object. For guided onboarding, prefer setup_project when Linear project creation/attachment is available.',
  requiredTopLevelFields: ['id', 'name', 'tracker', 'repo', 'workflow', 'symphony', 'codex'],
  validValues: {
    'tracker.kind': ['linear'],
    'workflow.source': ['repo', 'generated'],
    'codex.threadSandbox': ['read-only', 'workspace-write', 'danger-full-access'],
    'codex.turnSandbox': ['read-only', 'workspace-write', 'danger-full-access', 'custom policy object']
  },
  notes: [
    'Use describe_project_schema to fetch this annotated template from the MCP server.',
    'Use setup_project with name, teamKey, repoPath, runnerPort, workspaceRoot, and logsRoot to generate this object from defaults.',
    'For workflow.source=repo, provide workflow.path. For workflow.source=generated, provide workflow.template.'
  ]
} as const;

export const exampleManagedProject: ManagedProject = {
  id: 'meta-orchestrator',
  name: 'Meta Orchestrator',
  tracker: {
    kind: 'linear',
    teamKey: 'MRB',
    teamId: 'linear-team-id',
    projectId: 'linear-project-id',
    projectSlug: 'meta-orchestrator-abc123'
  },
  repo: {
    path: '/Users/example/code/meta-orchestrator',
    remoteUrl: 'https://github.com/example/meta-orchestrator.git',
    defaultBranch: 'main',
    cloneSource: 'https://github.com/example/meta-orchestrator.git'
  },
  workflow: {
    source: 'repo',
    path: 'WORKFLOW.md'
  },
  symphony: {
    command: 'npm',
    args: ['run', 'mcp'],
    runnerPort: 4310,
    workspaceRoot: '/Users/example/code/symphony-workspaces/meta-orchestrator',
    logsRoot: '/Users/example/Library/Logs/symphony/meta-orchestrator'
  },
  codex: {
    threadSandbox: 'workspace-write',
    turnSandbox: {
      type: 'workspace-write',
      networkAccess: true
    }
  }
};

export function projectSchemaHelp() {
  return {
    guidance: projectSchemaGuidance,
    example: exampleManagedProject
  };
}

export function projectSchemaErrorDetails(issues: string[]) {
  return {
    issues,
    schema: projectSchemaHelp()
  };
}
