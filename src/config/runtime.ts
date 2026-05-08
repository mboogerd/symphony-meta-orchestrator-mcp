import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvironment, type Environment, type LoadedEnvironment } from './env.ts';
import { normalizeLogLevel, type LogLevel } from '../logging/logger.ts';

export type RuntimeConfig = {
  cwd: string;
  configPath: string;
  configExists: boolean;
  envFile: LoadedEnvironment;
  logLevel: LogLevel;
  nodeEnv: string;
};

export type RuntimeConfigOptions = {
  argv?: string[];
  cwd?: string;
  env?: Environment;
};

export function createRuntimeConfig(options: RuntimeConfigOptions = {}): RuntimeConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envFile = loadEnvironment({ cwd, env });
  const configPath = resolveConfigPath(options.argv ?? process.argv.slice(2), env, cwd);

  return {
    cwd,
    configPath,
    configExists: existsSync(configPath),
    envFile,
    logLevel: normalizeLogLevel(env.SYMPHONY_LOG_LEVEL ?? env.LOG_LEVEL),
    nodeEnv: env.NODE_ENV ?? 'development'
  };
}

export function resolveConfigPath(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
  cwd: string = process.cwd()
): string {
  const argumentPath = readOption(argv, ['--config', '--config-path']);
  const configuredPath = argumentPath ?? env.SYMPHONY_CONFIG_PATH ?? 'symphony.config.json';
  return resolve(cwd, configuredPath);
}

function readOption(argv: string[], names: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    for (const name of names) {
      if (value === name) {
        return argv[index + 1];
      }

      if (value.startsWith(`${name}=`)) {
        return value.slice(name.length + 1);
      }
    }
  }

  return undefined;
}
