import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Environment = Record<string, string | undefined>;

export type LoadedEnvironment = {
  path: string;
  loaded: boolean;
  keys: string[];
};

export type LoadEnvironmentOptions = {
  cwd?: string;
  env?: Environment;
  fileName?: string;
  override?: boolean;
};

export function loadEnvironment(options: LoadEnvironmentOptions = {}): LoadedEnvironment {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const path = resolve(cwd, options.fileName ?? '.env');

  if (!existsSync(path)) {
    return { path, loaded: false, keys: [] };
  }

  const values = parseDotEnv(readFileSync(path, 'utf8'));
  const keys: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (options.override === true || env[key] === undefined) {
      env[key] = value;
      keys.push(key);
    }
  }

  return { path, loaded: true, keys };
}

export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    values[key] = unquoteValue(value);
  }

  return values;
}

function unquoteValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\');
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentStart = value.indexOf(' #');
  return commentStart === -1 ? value : value.slice(0, commentStart).trimEnd();
}
