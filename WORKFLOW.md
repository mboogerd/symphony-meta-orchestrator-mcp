---
tracker:
  kind: linear
  project_slug: "d4c50743a53d"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Duplicate
    - Canceled
    - Cancelled
    - Closed
polling:
  interval_ms: 5000
workspace:
  root: ~/code/symphony-workspaces/meta-orchestrator-mcp
hooks:
  after_create: |
    git clone https://github.com/mboogerd/symphony-meta-orchestrator-mcp.git .
  before_remove: |
    true
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all --config 'model="gpt-5.5"' --config model_reasoning_effort=medium app-server
  approval_policy: never
  thread_sandbox: danger-full-access
---

You are working on a Linear ticket `{{ issue.identifier }}`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state only if it still reflects a valid in-flight attempt.
- If the issue was moved back to `Todo`, or the workspace/workpad was reset after a blocked run, treat this as a fresh restart from `origin/main`.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- If a previous attempt already established the same external environment blocker (for example no GitHub/network access or `.git` metadata write denial), do at most one confirmation check and then stop instead of looping on the same failing remote commands.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
  {% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the workpad and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear MCP or `linear_graphql` tool is available

The agent should be able to talk to Linear, either via a configured Linear MCP server or injected `linear_graphql` tool. If none are present, stop and ask the user to configure Linear.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a single persistent Linear comment as the source of truth for progress.
- Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution,
  file a separate Linear issue instead of expanding scope. The follow-up issue
  must include a clear title, description, and acceptance criteria, be placed in
  `Backlog`, be assigned to the same project as the current issue, link the
  current issue as `related`, and use `blockedBy` when the follow-up depends on
  the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.

## Status map

- `Backlog` -> out of scope; do not modify.
- `Todo` -> queued; immediately move to `In Progress` before work starts.
- `In Progress` -> implementation actively underway.
- `In Review` -> PR is attached and validated; wait for human review or merge.
- `Done` -> terminal state; no further action required.
- `Canceled`, `Duplicate` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID and read the current state.
2. Route to the matching flow:
   - `Backlog` -> stop and wait for a human to move it to `Todo`.
   - `Todo` -> treat the run as a fresh execution attempt, move it to `In Progress`, and ensure the active `## Codex Workpad` comment is freshly created or replaced before doing any implementation work.
   - `In Progress` -> continue execution from the current branch/workpad state.
   - `In Review` -> do not code immediately. Inspect the attached PR, comments, and checks first.
     - If feedback requires code changes or the PR is missing/broken, move the issue back to `In Progress` and continue execution.
     - If the PR is approved and merged, move the issue to `Done`.
   - `Done`, `Canceled`, `Duplicate` -> stop.
3. If a reusable issue branch does not exist, create a fresh branch from `origin/main` using the format `<issue-identifier-lower>-<short-kebab-title>`.
4. If an existing issue branch has a closed or merged PR, do not reuse it. Create a fresh branch from `origin/main` and restart from reproduction/planning.

## Step 1: Kickoff and workpad management

1. Use exactly one active `## Codex Workpad` comment per issue.
2. If a workpad exists but reflects an obsolete blocked environment or stale retry context, replace its body with a fresh workpad before implementation continues.
3. Ensure the workpad begins with:
   - a code fence environment stamp in the form `<host>:<abs-workdir>@<short-sha>`,
   - a checklist-based plan,
   - explicit acceptance criteria,
   - explicit validation items,
   - timestamped notes.
4. Capture a concrete reproduction signal before editing code.
5. Sync with `origin/main` before code edits using shell commands, not skills:
   - `git fetch origin main`
   - `git merge --ff-only origin/main` when already on the issue branch, or create/reset the issue branch from `origin/main`
6. Record pull evidence in the workpad:
   - merge source,
   - result,
   - resulting `HEAD` short SHA.

## Step 2: Execution flow

1. Keep the workpad current after each meaningful milestone.
2. Implement only within the checked-out workspace.
3. Run the required validation for the scope:
   - targeted tests,
   - build,
   - CLI proof,
   - MCP stdio startup proof,
   - any ticket-provided validation requirements.
4. Before review:
   - ensure `git status` is clean except intended changes,
   - commit changes,
   - push the issue branch,
   - open or update the PR,
   - add the `symphony` label to the PR,
   - attach the PR URL to the Linear issue.
5. Sweep PR feedback before moving the issue to `In Review`:
   - top-level PR comments,
   - inline review comments,
   - review summaries/states,
   - PR checks.
6. Move the issue to `In Review` only when validation is green, the branch is pushed, the PR is linked, and there are no unresolved actionable review comments.

## Step 3: Review loop

1. While the issue is in `In Review`, poll for:
   - PR review comments,
   - PR check failures,
   - merge status.
2. If changes are requested, move the issue back to `In Progress`, update the workpad, and continue implementation on the same issue branch unless the PR is closed/merged.
3. If the PR is merged, move the issue to `Done`.

## Guardrails

- Do not rely on unavailable repo-local skills; use direct `git` and `gh` commands.
- Do not move an issue to `In Review` as a generic blocked state. Use it only for actual PR review waiting.
- If `git fetch`, branch creation, `git push`, or `gh` fails because GitHub/network is unavailable or `.git` metadata is not writable, treat that as an environment misconfiguration of the spawned Codex runtime. Record one concrete failing command and error in the workpad, keep the issue in `In Progress`, and stop. Do not spend additional turns repeating the same remote checks.
- If the environment is invalid for implementation, keep or move the issue to `In Progress`, document the blocker in the workpad, and stop.
- Do not edit the issue body for progress tracking.
- If out-of-scope work is discovered, create a separate `Backlog` issue and link it appropriately.
- Keep issue comments concise and operational.

## Workpad template

Use this exact structure for the persistent workpad comment and keep it updated in place throughout execution:

````md
## Codex Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````
