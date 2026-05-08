#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createRuntimeConfig } from '../config/runtime.ts';
import { createLogger } from '../logging/logger.ts';
import { packageInfo } from '../package-info.ts';
import { createProjectRegistryService, ProjectRegistryValidationError } from '../services/registry/index.ts';
import { createRunnerManager } from '../services/runner/index.ts';
import {
  validateProjectWorkflowSetups,
  WorkflowSetupValidationError,
  writeProjectWorkflow
} from '../services/workflow/index.ts';

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

  if (command === 'projects:list') {
    try {
      const projects = await createProjectRegistryService(runtime.configPath).list();
      stdout.write(`${JSON.stringify({ projects }, null, 2)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === 'project:validate') {
    try {
      const projectId = readOption(argv, ['--project', '--project-id']);
      const projects = await selectedProjects(runtime.configPath, argv);
      if (projects.length === 0) {
        stderr.write(`Project not found${projectId === undefined ? '' : `: ${projectId}`}\n`);
        return 1;
      }
      const setup = await validateProjectWorkflowSetups(projects);
      const ok = setup.every((validation) => validation.ok);
      stdout.write(`${JSON.stringify({ status: ok ? 'ok' : 'invalid', configPath: runtime.configPath, setup }, null, 2)}\n`);
      return ok ? 0 : 1;
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === 'workflow:render') {
    try {
      const projectId = readOption(argv, ['--project', '--project-id']);
      const projects = await createProjectRegistryService(runtime.configPath).list();
      const project = projectId === undefined ? projects[0] : projects.find((candidate) => candidate.id === projectId);

      if (project === undefined) {
        stderr.write(`Project not found${projectId === undefined ? '' : `: ${projectId}`}\n`);
        return 1;
      }

      const workflow = await writeProjectWorkflow(project);
      stdout.write(`${JSON.stringify({ status: 'ok', workflow }, null, 2)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command.startsWith('runner:')) {
    try {
      const project = await selectedProject(runtime.configPath, argv);
      if (project === undefined) {
        stderr.write(`Project not found${readOption(argv, ['--project', '--project-id']) === undefined ? '' : `: ${readOption(argv, ['--project', '--project-id'])}`}\n`);
        return 1;
      }

      const manager = createRunnerManager();
      if (command === 'runner:start') {
        stdout.write(`${JSON.stringify({ status: 'ok', runner: await manager.start(project) }, null, 2)}\n`);
        return 0;
      }
      if (command === 'runner:stop') {
        stdout.write(`${JSON.stringify({ status: 'ok', runner: await manager.stop(project) }, null, 2)}\n`);
        return 0;
      }
      if (command === 'runner:restart') {
        stdout.write(`${JSON.stringify({ status: 'ok', runner: await manager.restart(project) }, null, 2)}\n`);
        return 0;
      }
      if (command === 'runner:status') {
        stdout.write(`${JSON.stringify({ status: 'ok', runner: await manager.status(project) }, null, 2)}\n`);
        return 0;
      }
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

function readCommand(argv: string[]): string | undefined {
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--config' || value === '--config-path') {
      index += 1;
      continue;
    }

    if (value.startsWith('-')) {
      continue;
    }

    words.push(value);
    if (words.length === 2) {
      break;
    }
  }

  return normalizeCommand(words);
}

function normalizeCommand(words: string[]): string | undefined {
  const first = words[0];
  const second = words[1];

  if (first === undefined) {
    return undefined;
  }

  const aliases: Record<string, string> = {
    'projects:list': 'projects:list',
    'projects:validate': 'project:validate',
    'project:validate': 'project:validate',
    'workflows:render': 'workflow:render',
    'workflow:render': 'workflow:render',
    'runners:start': 'runner:start',
    'runners:stop': 'runner:stop',
    'runners:restart': 'runner:restart',
    'runners:status': 'runner:status',
    'runner:start': 'runner:start',
    'runner:stop': 'runner:stop',
    'runner:restart': 'runner:restart',
    'runner:status': 'runner:status'
  };

  if (aliases[first]) {
    return aliases[first];
  }

  if (second !== undefined) {
    const spaced = `${first}:${second}`;
    if (aliases[spaced]) {
      return aliases[spaced];
    }
  }

  return first;
}

function helpText(): string {
  return [
    'Usage: symphony-meta-orchestrator [command] [options]',
    '',
    'Commands:',
    '  health     Print runtime health information',
    '  projects list      List managed projects from the registry',
    '  project validate   Validate the managed-project registry and workflow setup',
    '  workflow render    Render WORKFLOW.md for a managed project',
    '  runner start       Start the Symphony runner for a managed project',
    '  runner stop        Stop the Symphony runner for a managed project',
    '  runner restart     Restart the Symphony runner for a managed project',
    '  runner status      Inspect the Symphony runner for a managed project',
    '  version    Print package name and version',
    '',
    'Options:',
    '  --config, --config-path <path>  Override the config file path',
    '  -v, --version                  Print the version',
    '  -h, --help                     Print this help text',
    ''
  ].join('\n');
}

async function selectedProject(configPath: string, argv: string[]) {
  const projects = await selectedProjects(configPath, argv);
  return projects[0];
}

async function selectedProjects(configPath: string, argv: string[]) {
  const projectId = readOption(argv, ['--project', '--project-id']);
  const projects = await createProjectRegistryService(configPath).list();
  return projectId === undefined ? projects : projects.filter((candidate) => candidate.id === projectId);
}

function formatError(error: unknown): string {
  if (error instanceof ProjectRegistryValidationError) {
    return error.message;
  }

  if (error instanceof WorkflowSetupValidationError) {
    return JSON.stringify({ status: 'invalid', setup: error.validations }, null, 2);
  }

  return error instanceof Error ? error.message : String(error);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
