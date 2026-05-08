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
npm run dev
npm run build
npm test
npm run cli -- health
npm run cli -- projects:list --config symphony.registry.yaml
npm run cli -- projects:validate --config symphony.registry.yaml
npm run mcp
```

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
