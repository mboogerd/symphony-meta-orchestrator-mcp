#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createRuntimeConfig } from '../config/runtime.ts';
import { createLogger } from '../logging/logger.ts';
import { packageInfo } from '../package-info.ts';

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  stdout = process.stdout,
  stderr = process.stderr
): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    stdout.write(`${packageInfo.version}\n`);
    return 0;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(helpText());
    return 0;
  }

  const command = readCommand(argv) ?? 'health';
  const runtime = createRuntimeConfig({ argv, env });
  const logger = createLogger({ name: 'cli', level: runtime.logLevel, sink: stderr });
  logger.debug('loaded runtime configuration', {
    configPath: runtime.configPath,
    configExists: runtime.configExists,
    envFileLoaded: runtime.envFile.loaded
  });

  if (command === 'health') {
    stdout.write(`${JSON.stringify({
      status: 'ok',
      service: packageInfo.name,
      version: packageInfo.version,
      configPath: runtime.configPath,
      configExists: runtime.configExists,
      envFileLoaded: runtime.envFile.loaded,
      nodeEnv: runtime.nodeEnv
    }, null, 2)}\n`);
    return 0;
  }

  if (command === 'version') {
    stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
    return 0;
  }

  stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

function readCommand(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--config' || value === '--config-path') {
      index += 1;
      continue;
    }

    if (value.startsWith('-')) {
      continue;
    }

    return value;
  }

  return undefined;
}

function helpText(): string {
  return [
    'Usage: symphony-meta-orchestrator [command] [options]',
    '',
    'Commands:',
    '  health     Print runtime health information',
    '  version    Print package name and version',
    '',
    'Options:',
    '  --config, --config-path <path>  Override the config file path',
    '  -v, --version                  Print the version',
    '  -h, --help                     Print this help text',
    ''
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
