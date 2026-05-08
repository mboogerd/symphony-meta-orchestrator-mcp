#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRuntimeConfig } from '../config/runtime.ts';
import { createLogger } from '../logging/logger.ts';
import { handleMcpMessage, jsonRpcError } from './protocol.ts';

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

  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    try {
      const response = await handleMcpMessage(JSON.parse(trimmed), runtime);

      if (response !== undefined) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    } catch (errorValue) {
      logger.warn('failed to handle mcp message', {
        error: errorValue instanceof Error ? errorValue.message : String(errorValue)
      });
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))}\n`);
    }
  }

  logger.info('mcp stdio server stopped');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcpStdio();
}
