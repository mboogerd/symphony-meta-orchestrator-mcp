export const setupProjectDescription = [
  'Set up a new managed project end-to-end from name, teamKey, and githubUrl: find and reuse an existing same-name Linear project for the resolved team or create one when none exists, resolve workspace/log paths, bootstrap the runner configuration, register defaults, generate workflow, and optionally start the runner.',
  'Preconditions: githubUrl must point to a GitHub repository; workspaceRoot and logsRoot are resolved from DEFAULT_SYMPHONY_WORKSPACES/DEFAULT_SYMPHONY_LOGS or OS temp directories; the runner uses SYMPHONY_RUNNER_COMMAND or bootstrap access to SYMPHONY_RUNNER_REPOSITORY.',
  'If multiple same-name Linear projects exist or the automatic match is not the intended project, pass linearProjectId to attach the exact Linear project explicitly.',
  'For full manual control or when these preconditions are not available, call describe_project_schema and then register_project with an explicit managed project object.',
  'Partial failures are not automatically rolled back: when setup_project returns status invalid, it includes recovery with the failed step, concrete actions, and retry input. If Linear project creation succeeds but registry, workflow, or runner setup fails, retry with recovery.retry.input.linearProjectId to reuse the created project or clean up the orphaned Linear/local state before retrying.'
].join(' ');
