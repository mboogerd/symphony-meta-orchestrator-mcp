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

This scaffold has no external runtime dependencies. It relies on Node's native
TypeScript stripping support for local development and uses a small build script
to emit JavaScript into `dist/`.

```sh
npm run dev
npm run build
npm test
npm run cli -- health
npm run mcp
```

The CLI currently exposes no-op `health` and `version` commands. The MCP stdio
entrypoint starts a no-op JSON-RPC server with empty tools, resources, and
prompts so later registry, workflow, runner, and Linear services can be added
behind stable entrypoints.
