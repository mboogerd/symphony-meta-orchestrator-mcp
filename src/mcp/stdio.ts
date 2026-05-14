#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRuntimeConfig } from '../config/runtime.ts';
import { createLogger } from '../logging/logger.ts';
import { createMcpServer, startAllRunners } from './server.ts';

export type McpStdioOptions = {
  argv?: string[];
  env?: Record<string, string | undefined>;
  input?: typeof process.stdin;
  output?: typeof process.stdout;
  error?: typeof process.stderr;
};

export async function startMcpStdio(options: McpStdioOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const runtime = createRuntimeConfig({ argv, env });
  const logger = createLogger({ name: 'mcp-stdio', level: runtime.logLevel, sink: error });

  logger.info('mcp stdio server started', {
    configPath: runtime.configPath,
    configExists: runtime.configExists,
    envFileLoaded: runtime.envFile.loaded
  });

  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport(input, output);
  transport.onerror = (errorValue) => {
    logger.warn('mcp stdio transport error', { error: errorValue.message });
  };
  transport.onclose = () => {
    logger.info('mcp stdio server stopped');
  };

  await server.connect(transport);
  await startAllRunners(runtime, logger);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpStdio();
}
