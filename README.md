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

### Tests

Run the full unit and mocked integration suite with:

```sh
npm test
```

Pull requests and pushes to `main` run the same suite in GitHub Actions through
the `Test / Build and test` workflow job. To make the gate merge-blocking,
configure the repository's `main` branch protection or ruleset to require the
`Build and test` status check before merging.

The MCP integration tests exercise the JSON-RPC message handler used by the
stdio control plane and do not require real Linear, GitHub, or Symphony
services. They create temporary registry, repository, workspace, and logs
directories under the OS temp root and remove them after each test. External
boundaries are mocked as follows:

- Linear SDK calls use an in-memory `LinearService` client that returns teams,
  Backlog states, issues, and dependency relations while recording the exact
  requested operations.
- Symphony runner process management is injected as a mock `RunnerManager`, so
  no real runner process is spawned for end-to-end MCP lifecycle assertions.
- Filesystem behavior is isolated to per-test temporary directories, including
  repo-owned workflow templates and generated workspace `WORKFLOW.md` files.
- Runner validation failure cases use local-only probes, including a temporary
  TCP listener for unavailable port coverage and a deliberately missing command
  name for command lookup coverage.

Required local environment:

```sh
SYMPHONY_CONFIG_PATH=./symphony.registry.yaml
SYMPHONY_LOG_LEVEL=info
LINEAR_API_KEY=<linear-api-key>
SYMPHONY_RUNNER_COMMAND="node"
```

`LINEAR_API_KEY` is required for Linear project and issue creation. Registry,
workflow, and runner status commands can run without it. Override
`SYMPHONY_RUNNER_COMMAND` during local tests when you want the runner manager to
launch a known local command instead of the registry command.

### Project validation output

`project validate` and the MCP `validate_project` tool return the same
structured readiness result. The top-level `status` is `ok` only when every
selected project has no blocking `issues`; non-blocking findings are listed in
`warnings`.

Each project result includes a `subsystems` object with `registry`, `repo`,
`workflow`, `linear`, `runner`, `filesystem`, and `codexPolicy` groups. A group
has `ok`, `errors`, and `warnings`, so operators can see whether the failure is
schema, clone, workflow rendering, Linear auth, runner launch readiness,
directory access, or Codex sandbox policy related.

Warnings call out degraded readiness that may still be acceptable locally, such
as a missing local default branch or absent git origin remote. Errors block real
runner readiness, such as a missing repo path, invalid repo-owned workflow,
unavailable runner port, missing runner command, missing writable roots, or a
read-only Codex turn sandbox for workflows that expect git/GitHub operations.
Set `SYMPHONY_VALIDATE_LINEAR=1` for CLI validation, or pass
`validateLinear: true` to MCP `validate_project`, to require `LINEAR_API_KEY`
and validate Linear-specific registry fields.

Managed projects are stored as YAML runtime files:

```yaml
version: 2
projects:
  - id: meta-orchestrator
    name: Meta Orchestrator
    tracker:
      kind: linear
      teamKey: MRB
      teamId: linear-team-id
      projectId: linear-project-id
      projectSlug: meta-orchestrator
    repo:
      path: /path/to/repository
      remoteUrl: https://github.com/example/repository.git
      defaultBranch: main
      cloneSource: git@github.com:example/repository.git
    workflow:
      source: repo
      path: WORKFLOW.md
    symphony:
      command: mise
      args:
        - exec
        - --
        - ./bin/symphony
        - --i-understand-that-this-will-be-running-without-the-usual-guardrails
      cwd: /path/to/symphony-installation
      runnerPort: 4101
      workspaceRoot: /path/to/workspace
      logsRoot: /path/to/logs
      dashboardUrl: http://localhost:4101
    codex:
      threadSandbox: workspace-write
      turnSandbox: workspace-write
```

The CLI exposes health, version, and registry list/validate commands. The MCP
stdio entrypoint exposes managed projects through `resources/list` so later
workflow, runner, and Linear services can consume the same registry service.

## Library Choices

- MCP protocol handling uses the official `@modelcontextprotocol/sdk` server
  and stdio transport for the production entrypoint. The earlier bespoke
  JSON-RPC handler is retained only as a narrow unit-test compatibility surface.
- Runtime schemas use `zod` for managed-project registry validation and MCP
  tool input schemas. Custom validation remains only for cross-record registry
  invariants such as duplicate project identities, paths, and ports.
- CLI option and positional parsing uses `commander` while preserving the
  existing colon-command aliases such as `projects:list` and spaced commands
  such as `projects list`.
- Runner launch command parsing uses `shell-quote` so quoted executable paths
  and arguments are parsed correctly. Shell operators, globs, and pipelines are
  rejected because runner launch uses `spawn` without a shell.
- Markdown front matter parsing was not added. Workflow rendering currently
  writes deterministic Markdown from structured project data and does not parse
  or round-trip front matter, so `gray-matter` would add dependency surface
  without reducing current risk.

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
