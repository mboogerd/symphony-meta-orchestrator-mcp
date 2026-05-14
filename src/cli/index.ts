#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
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
  const program = createProgram(stdout, stderr);
  let parsed: Command;

  try {
    parsed = program.parse(['node', 'symphony-meta-orchestrator', ...argv], { from: 'node' });
  } catch (error) {
    return error instanceof CommanderError ? error.exitCode : 1;
  }

  const command = normalizeCommand(parsed.processedArgs) ?? 'health';
  const options = parsed.opts<{ config?: string; project?: string; live?: boolean }>();
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
      const projectId = options.project;
      const registry = await createProjectRegistryService(runtime.configPath).load();
      const projects = projectId === undefined ? registry.projects : registry.projects.filter((candidate) => candidate.id === projectId);
      if (projects.length === 0) {
        stderr.write(`Project not found${projectId === undefined ? '' : `: ${projectId}`}\n`);
        return 1;
      }
      const setup = await validateProjectWorkflowSetups(projects, {
        phase: options.live ? 'live' : 'workspace',
        registry,
        validateLinear: Boolean(env.SYMPHONY_VALIDATE_LINEAR),
        env
      });
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
      const projectId = options.project;
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
      const project = await selectedProject(runtime.configPath, options.project);
      if (project === undefined) {
        stderr.write(`Project not found${options.project === undefined ? '' : `: ${options.project}`}\n`);
        return 1;
      }

      const manager = createRunnerManager();
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

  stderr.write(`Unknown command: ${command}\n\n${program.helpInformation()}`);
  return 1;
}

function createProgram(stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): Command {
  const program = new Command();
  program
    .name('symphony-meta-orchestrator')
    .description('MCP server and CLI scaffold for the Symphony meta-orchestrator.')
    .version(packageInfo.version, '-v, --version')
    .allowUnknownOption(false)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => stdout.write(value),
      writeErr: (value) => stderr.write(value)
    })
    .option('--config, --config-path <path>', 'Override the config file path')
    .option('--project, --project-id <id>', 'Select a managed project by id')
    .option('--live', 'Include live runner readiness checks during project validation')
    .argument('[group]', 'Command group or colon command')
    .argument('[action]', 'Command action');
  return program;
}

function normalizeCommand(words: unknown[]): string | undefined {
  const first = typeof words[0] === 'string' ? words[0] : undefined;
  const second = typeof words[1] === 'string' ? words[1] : undefined;

  if (first === undefined) {
    return undefined;
  }

  const aliases: Record<string, string> = {
    'projects:list': 'projects:list',
    'projects:validate': 'project:validate',
    'project:validate': 'project:validate',
    'workflows:render': 'workflow:render',
    'workflow:render': 'workflow:render',
    'runners:restart': 'runner:restart',
    'runners:status': 'runner:status',
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

async function selectedProject(configPath: string, projectId: string | undefined) {
  const projects = await selectedProjects(configPath, projectId);
  return projects[0];
}

async function selectedProjects(configPath: string, projectId: string | undefined) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
