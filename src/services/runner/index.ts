export type RunnerStatus = {
  id: string;
  state: 'idle' | 'running' | 'stopped';
};

export function createIdleRunnerStatus(id: string): RunnerStatus {
  return { id, state: 'idle' };
}
