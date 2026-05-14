import { createServer } from 'node:net';

export const DEFAULT_RUNNER_PORT = 4001;
const DEFAULT_PORT_ALLOCATION_ATTEMPTS = 100;

export async function allocatePort(startFrom = DEFAULT_RUNNER_PORT, options: { maxAttempts?: number } = {}): Promise<number> {
  const firstPort = Math.trunc(startFrom);
  const maxAttempts = Math.trunc(options.maxAttempts ?? DEFAULT_PORT_ALLOCATION_ATTEMPTS);
  if (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65_535) {
    throw new Error(`Invalid runner port allocation start: ${startFrom}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Invalid runner port allocation attempts: ${options.maxAttempts}`);
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = firstPort + offset;
    if (port > 65_535) {
      break;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available runner port found starting at ${firstPort} after ${maxAttempts} attempts`);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, '127.0.0.1');
  });
}
