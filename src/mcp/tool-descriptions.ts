export const setupProjectDescription = [
  'Set up a new managed project end-to-end: create or attach a Linear project, resolve or bootstrap the runner, register defaults, generate workflow, and optionally start the runner.',
  'Preconditions: repoPath must point to a git repository with an origin remote unless remoteUrl and cloneSource are supplied; the runner must be provided with runnerCommand/runnerArgs/runnerCwd, SYMPHONY_RUNNER_COMMAND, repo bin/symphony, or bootstrap access to SYMPHONY_RUNNER_REPOSITORY.',
  'For full manual control or when these preconditions are not available, call describe_project_schema and then register_project with an explicit managed project object.',
  'Partial failures are not automatically rolled back: if Linear project creation succeeds but registry, workflow, or runner setup fails, callers must inspect the returned steps/error and clean up any created Linear or local state themselves.'
].join(' ');
