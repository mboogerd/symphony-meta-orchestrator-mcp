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
npm run cli -- project validate --config symphony.registry.yaml --live
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
SYMPHONY_RUNNER_READINESS_TIMEOUT_MS=30000
SYMPHONY_RUNNER_READINESS_POLL_INTERVAL_MS=500
```

`LINEAR_API_KEY` is required for Linear project and issue creation. Registry,
workflow, and runner status commands can run without it. Override
`SYMPHONY_RUNNER_COMMAND` during local tests when you want the runner manager to
launch a known local executable instead of the registry command. Runner launch
arguments are not parsed from this environment variable; configure stable
arguments with `symphony.args` in the registry so they are passed to `spawn` as
structured argv entries.
`SYMPHONY_RUNNER_READINESS_TIMEOUT_MS` controls how long `runner start` waits
for the configured dashboard/API URL to respond before reporting the runner as
unhealthy. `SYMPHONY_RUNNER_READINESS_POLL_INTERVAL_MS` controls the polling
cadence.

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

Validation is phased. CLI `project validate` and MCP `validate_project` default
to the `workspace` phase, which checks registry/schema data, workflow
renderability, repository metadata, writable workspace/log roots, and Codex
policy without probing the live runner command or TCP port. Use CLI `--live`,
MCP `live: true`, or MCP `phase: "live"` when you need full runner readiness.
Workflow rendering also uses non-live validation, so an occupied runner port does
not block writing `WORKFLOW.md`; `runner start` always performs live checks.
Each project result includes `phase` and `phases` fields to show which phase was
requested and where errors or warnings were recorded.

Warnings call out degraded readiness that may still be acceptable locally, such
as a missing local default branch or absent git origin remote. Errors block real
runner readiness during the relevant phase, such as a missing repo path, invalid
repo-owned workflow, missing writable roots, or a Codex turn sandbox that lacks
filesystem or network access for workflows that expect git/GitHub operations.
Live validation additionally checks for an unavailable runner port, missing
runner command, or non-executable runner command path. Set
`SYMPHONY_VALIDATE_LINEAR=1` for CLI validation, or pass
`validateLinear: true` to MCP `validate_project`, to require `LINEAR_API_KEY`
and validate Linear-specific registry fields.

### Guided MCP project setup

The MCP `setup_project` tool provides the managed-project happy path in one
call. It accepts `name`, `teamKey`, `repoPath`, `runnerPort`, `workspaceRoot`,
`logsRoot`, optional `linearProjectId`, optional runner configuration
(`runnerCommand`, `runnerArgs`, and `runnerCwd`), and optional `startRunner`.
The tool resolves the Linear team, attaches an existing same-name Linear project
in that team or creates one when none exists, validates any supplied Linear
project belongs to that team, resolves or bootstraps the runner, stores a
registry entry with the documented defaults, renders `WORKFLOW.md`, and starts
the runner when requested.

When `runnerCommand` is provided, `setup_project` uses it for the managed
project's Symphony runner command. `runnerArgs` defaults to the unattended
guardrail acknowledgement flag when omitted, and `runnerCwd` defaults to
`repoPath`. Without an explicit `runnerCommand`, the tool first honors
`SYMPHONY_RUNNER_COMMAND`, then uses an executable `bin/symphony` inside the
target repository, and finally bootstraps a managed Symphony checkout. The
managed checkout source defaults to the built-in repository URL and can be
overridden with `SYMPHONY_RUNNER_REPOSITORY`; the install directory can be
overridden with `SYMPHONY_RUNNER_INSTALL_DIR`.

The response includes `setup.project`, `setup.linearProject`, `setup.team`,
`setup.workflow`, optional `setup.runner`, and ordered `setup.steps`. If a later
step fails after earlier work succeeded, the response is returned as an
`invalid` tool result with the completed outputs preserved and the failing step
containing a structured error. Runner resolution and managed-checkout failures
are reported in the `bootstrap` step.

### Runner readiness and lifecycle

`runner start` no longer treats a spawned PID as healthy on its own. After the
process starts, the manager polls the configured `symphony.dashboardUrl`, or
`http://localhost:<runnerPort>` when no explicit URL is set, until the service
responds or the readiness timeout expires. A ready JSON response may expose
`projectId`, `project.id`, `workflowPath`, or `workflow.path`; when present,
those fields must match the managed project and rendered workflow. If the
dashboard only returns a successful non-JSON response, the runner is marked
ready using that weaker service-level signal and the status message documents
that project/workflow identity was not exposed.

Lifecycle status can be `idle`, `starting`, `running`, `unhealthy`, `stopped`,
`missing`, or `invalid`. `runner status` probes the service again for live
processes, so a process that still exists but no longer responds is reported as
`unhealthy` instead of `running`. Startup timeouts, early exits, wrong project
or workflow responses, and other readiness failures include the runner log path
and recent log excerpts when available.

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
      runtime:
        tracker:
          activeStates:
            - Todo
            - In Progress
            - In Review
          terminalStates:
            - Done
            - Duplicate
            - Canceled
            - Cancelled
            - Closed
        agent:
          maxConcurrentAgents: 10
          maxTurns: 20
        codex:
          command: codex --config shell_environment_policy.inherit=all app-server
          approvalPolicy: never
        hooks:
          afterCreate:
            type: gitClone
          beforeRemove: "true"
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
      turnSandbox:
        type: workspaceWrite
        networkAccess: true
```

`codex.threadSandbox` is the Codex thread sandbox mode passed to Symphony as
`codex.thread_sandbox`. Supported registry values are `read-only`,
`workspace-write`, and `danger-full-access`.

`workflow.runtime` is optional. When omitted, workflow rendering uses the
defaults shown above: active states `Todo`, `In Progress`, and `In Review`;
terminal states `Done`, `Duplicate`, `Canceled`, `Cancelled`, and `Closed`;
agent limits of 10 concurrent agents and 20 turns; Codex command
`codex --config shell_environment_policy.inherit=all app-server`; approval
policy `never`; `beforeRemove: "true"`; and an `afterCreate` `gitClone` hook
that clones `repo.cloneSource` into `.`. The generated git clone hook shell
quotes clone sources and targets that require quoting. Set
`workflow.runtime.hooks.afterCreate.type` to `none` to render a no-op hook, or
set `cloneSource` and `target` on the `gitClone` hook to override either value.

`codex.turnSandbox` is the Codex turn sandbox policy map rendered into
WORKFLOW.md as `codex.turn_sandbox_policy`. Use these common policies:

- `type: readOnly` for inspection-only runs. Set `networkAccess: true` only
  when the workflow needs network reads without repository writes.
- `type: workspaceWrite` for normal implementation runs. Set
  `networkAccess: true` when the workflow mentions git, GitHub, clone, fetch,
  push, pull, or PR operations.
- `type: dangerFullAccess` only for fully trusted workspaces that need host
  filesystem semantics beyond the workspace-write sandbox.
- `type: externalSandbox` for externally managed isolation. Its
  `networkAccess`, when provided, must be `restricted` or `enabled`.

Existing registry files that use legacy string shorthand for `turnSandbox`
continue to load. The shorthand is normalized as `read-only` ->
`{ type: readOnly }`, `workspace-write` -> `{ type: workspaceWrite }`, and
`danger-full-access` -> `{ type: dangerFullAccess }`. Add
`networkAccess: true` explicitly for workspace-write policies that must perform
git or GitHub operations.

The CLI exposes health, version, and registry list/validate commands. The MCP
stdio entrypoint exposes managed projects through `resources/list` so later
workflow, runner, and Linear services can consume the same registry service.

### Linear planning recovery

Project-scoped planning tools only operate on issues that belong to the
managed Linear team and project. `link_project_issue_dependency` validates both
the blocking and blocked issues before creating a relation, and
`promote_ready_issue` validates the issue before moving it to Todo. Ownership
failures are returned as structured `LinearServiceError` payloads with codes
such as `missing_issue`, `wrong_team`, `wrong_project`, or
`invalid_dependency_direction`.

`create_planned_issue_batch` is intentionally not transactional. If issue
creation or dependency linking fails after earlier operations succeeded, the
tool returns `planned_issue_batch_partial_failure` with
`details.partial.issues`, `details.partial.dependencies`, and
`details.partial.failed`. The `issues` and `dependencies` arrays contain the
already-created Linear references, including issue ids and identifiers, while
`failed` includes the phase, stable issue key or dependency edge, and the
structured underlying error. Agents and operators should use those returned
references to inspect or clean up created work before retrying the remaining
plan.

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
- Runner launch uses structured `symphony.command` and `symphony.args`
  registry fields. The runner manager passes those values directly to Node's
  `spawn` without a shell, then appends the managed `--port`, `--logs-root`,
  and rendered workflow path arguments. No `shell-quote` dependency is used or
  required for runner startup.
- Generated workflow hooks use a small internal shell-quoting helper only when
  rendering deterministic hook strings such as the default `git clone` command.
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
   npm run cli -- project validate --config symphony.registry.yaml --project meta-orchestrator --live
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
