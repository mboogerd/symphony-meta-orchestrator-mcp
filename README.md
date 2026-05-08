# Symphony Meta-Orchestrator MCP

This repository will host the MCP server that routes planning requests across
Linear-backed Symphony project runners.

Initial responsibilities:

- Maintain the project registry that maps Linear projects to repositories and
  Symphony runner configuration.
- Provide tools for creating and linking Linear issues.
- Provide tools for starting, stopping, and inspecting Symphony runner
  instances.
- Keep ticket creation separate from execution: planned work starts in backlog,
  and only ready work is moved into Symphony's active states.

## Development

This scaffold relies on Node's native TypeScript stripping support for local
development and uses a small build script to emit JavaScript into `dist/`.

```sh
npm install
npm run dev
npm run build
npm test
npm run cli -- health
npm run cli -- projects list --config symphony.registry.yaml
npm run cli -- project validate --config symphony.registry.yaml
npm run cli -- workflow render --config symphony.registry.yaml --project meta-orchestrator
npm run cli -- runner status --config symphony.registry.yaml --project meta-orchestrator
npm run mcp
```

Required local environment:

```sh
SYMPHONY_CONFIG_PATH=./symphony.registry.yaml
SYMPHONY_LOG_LEVEL=info
LINEAR_API_KEY=<linear-api-key>
SYMPHONY_RUNNER_COMMAND="npx --yes symphony"
```

`LINEAR_API_KEY` is required for Linear project and issue creation. Registry,
workflow, and runner status commands can run without it. Override
`SYMPHONY_RUNNER_COMMAND` during local tests when you want the runner manager to
launch a known local command instead of the default Symphony package.

Managed projects are stored as YAML runtime files:

```yaml
version: 1
projects:
  - id: meta-orchestrator
    name: Meta Orchestrator
    linear:
      teamKey: MRB
      projectKey: META
    repo:
      path: /path/to/repository
      remote: https://github.com/example/repository.git
      branch: main
    symphony:
      workspacePath: /path/to/workspace
      mcpPort: 4100
      runnerPort: 4101
```

The CLI exposes health, version, and registry list/validate commands. The MCP
stdio entrypoint exposes managed projects through `resources/list` so later
workflow, runner, and Linear services can consume the same registry service.

## Manual M1 Smoke Path

Use a dedicated Symphony runner project in Linear and a local registry entry
that points at this repository plus a disposable workspace/logs directory.

1. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

2. Confirm the project registry is visible:

   ```sh
   npm run cli -- projects list --config symphony.registry.yaml
   ```

3. Render and validate the runner handoff:

   ```sh
   npm run cli -- workflow render --config symphony.registry.yaml --project meta-orchestrator
   npm run cli -- project validate --config symphony.registry.yaml --project meta-orchestrator
   ```

4. Exercise the local runner lifecycle:

   ```sh
   npm run cli -- runner start --config symphony.registry.yaml --project meta-orchestrator
   npm run cli -- runner status --config symphony.registry.yaml --project meta-orchestrator
   npm run cli -- runner stop --config symphony.registry.yaml --project meta-orchestrator
   ```

5. Start the MCP stdio server for client smoke validation:

   ```sh
   npm run mcp -- --config symphony.registry.yaml
   ```
