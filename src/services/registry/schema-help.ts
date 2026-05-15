import type { ManagedProject } from './index.ts';

export const projectSchemaGuidance = {
  summary: 'register_project expects a complete managed project object. For guided onboarding, prefer setup_project when Linear project creation/attachment is available.',
  requiredTopLevelFields: ['id', 'name', 'githubUrl', 'workflow', 'codex'],
  validValues: {
    'workflow.source': ['repo'],
    'codex.threadSandbox': ['read-only', 'workspace-write', 'danger-full-access'],
    'codex.turnSandbox': ['read-only', 'workspace-write', 'danger-full-access', 'custom policy object']
  },
  notes: [
    'Use describe_project_schema to fetch this annotated template from the MCP server.',
    'Use setup_project with name, teamKey, and githubUrl to generate this object from defaults.',
    'For workflow.source=repo, provide workflow.path.'
  ]
} as const;

export const exampleManagedProject: ManagedProject = {
  id: 'meta-orchestrator',
  name: 'Meta Orchestrator',
  githubUrl: 'https://github.com/example/meta-orchestrator.git',
  workflow: {
    source: 'repo',
    path: 'WORKFLOW.md'
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
