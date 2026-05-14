export const setupProjectDescription = [
  'Set up a new managed project end-to-end from name, teamKey, and githubUrl: create or attach a Linear project, resolve workspace/log paths, bootstrap the runner configuration, register defaults, generate workflow, and optionally start the runner.',
  'Preconditions: githubUrl must point to a GitHub repository; workspaceRoot and logsRoot are resolved from DEFAULT_SYMPHONY_WORKSPACES/DEFAULT_SYMPHONY_LOGS or OS temp directories; the runner uses SYMPHONY_RUNNER_COMMAND or bootstrap access to SYMPHONY_RUNNER_REPOSITORY.',
  'For full manual control or when these preconditions are not available, call describe_project_schema and then register_project with an explicit managed project object.',
  'Partial failures are not automatically rolled back: if Linear project creation succeeds but registry, workflow, or runner setup fails, callers must inspect the returned steps/error and clean up any created Linear or local state themselves.'
].join(' ');
