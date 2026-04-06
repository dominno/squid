# Step Types Reference

## run — Shell Commands

Execute any shell command. Output is captured as stdout; if the output is valid JSON, it's automatically parsed.

```yaml
- id: build
  type: run
  run: docker build -t myapp:latest .
  timeout: 300           # seconds
  cwd: /path/to/project  # working directory
  env:
    NODE_ENV: production  # step-level env vars
  retry: 3               # retry up to 3 times on failure
```

**Output**: Raw stdout is available as `$build.stdout`. If stdout is valid JSON, it's also available as `$build.json`.

**Interpolation**: Use `${args.key}` and `${stepId.json.field}` in the command string.

```yaml
- id: deploy
  type: run
  run: kubectl set image deployment/app app=${args.image} -n ${args.env}
```

---

## spawn — AI Sub-Agents

Spawn an OpenClaw sub-agent via `sessions_spawn`. This is the core differentiator from Lobster.

### Simple spawn

```yaml
- id: analyze
  type: spawn
  spawn: "Analyze the codebase and list security issues"
```

### Full spawn config

```yaml
- id: architect
  type: spawn
  spawn:
    task: |
      Design an architecture for: ${args.feature}
      Output JSON with files, interfaces, and test strategy.
    agentId: architect-agent     # Target agent ID
    model: claude-sonnet-4-6     # Model override
    thinking: high               # Thinking level: off, low, high
    runtime: subagent            # subagent or acp
    cwd: /path/to/workspace      # Working directory
    timeout: 300                 # Seconds
    mode: run                    # run (ephemeral) or session (persistent)
    sandbox: inherit             # inherit or require
    attachments:                 # Files to attach
      - name: spec.md
        content: "..."
```

**Output**: The sub-agent's completion output is available as `$architect.json`.

**How it works**: Squid calls OpenClaw's `sessions_spawn` API, waits for the sub-agent to complete, and captures its output as the step result.

---

## gate — Approval Checkpoints

Human-in-the-loop approval gates. The pipeline halts and outputs a resume token.

### Simple gate

```yaml
- id: approve
  type: gate
  gate: "Deploy to production?"
```

### Gate with preview

```yaml
- id: review
  type: gate
  gate:
    prompt: "Review changes before deploying to ${args.env}"
    preview: $build.json          # Show data in approval UI
    items: $test.json.results     # Show items list
    timeout: 3600                 # Auto-reject after 1 hour
    approvers:                    # Required approver IDs
      - admin
      - lead-dev
```

### Auto-approve

```yaml
- id: ci-gate
  type: gate
  gate:
    prompt: "Auto-approved in CI"
    autoApprove: true   # Skip in CI/test mode
```

### Structured input

Collect form fields from the approver — not just approve/reject:

```yaml
- id: deploy-config
  type: gate
  gate:
    prompt: "Configure deployment"
    input:
      - name: environment
        type: select                   # string | number | boolean | select
        label: Target environment
        options: ["staging", "production"]
      - name: replicas
        type: number
        label: Pod replicas
        default: 2
      - name: run_migrations
        type: boolean
        default: false
      - name: version
        type: string
        validation: "^\\d+\\.\\d+\\.\\d+$"  # regex validation
```

Access input values in subsequent steps: `$deploy-config.json.input.environment`, `$deploy-config.json.input.replicas`.

Input is validated on resume — type mismatches, missing required fields, and regex failures are rejected.

### Caller identity

Restrict who can approve and prevent self-approval:

```yaml
- id: prod-gate
  type: gate
  gate:
    prompt: "Deploy to production?"
    requiredApprovers: ["platform-lead", "sre-oncall"]
    allowSelfApproval: false
```

- `requiredApprovers`: Only these IDs can approve. If the approver is not in the list, the gate is rejected.
- `allowSelfApproval: false`: The person who started the pipeline cannot approve their own gate.
- Access the approver's identity: `$gate.json.approvedBy`.

### Short approval IDs

Gates generate an 8-character hex ID (e.g., `a1b2c3d4`) alongside the full resume token. Designed for chat platforms where button payloads are limited (Telegram: 64 bytes, Discord: 100 chars).

The short ID is included in the gate output:

```json
{
  "shortId": "a1b2c3d4",
  "prompt": "Deploy myapp to production?"
}
```

**Resuming**: When halted, the pipeline outputs a resume token:

```bash
squid resume pipeline.yaml --token <token> --approve yes
```

**Referencing**: Use `$gate.approved` (boolean) in subsequent `when:` conditions.

---

## parallel — Fan-Out Concurrent Work

Execute multiple branches simultaneously and merge results.

```yaml
- id: build-all
  type: parallel
  parallel:
    maxConcurrent: 3       # Limit concurrent branches
    failFast: true         # Abort all on first failure (default: true)
    merge: object          # How to combine: object, array, first
    branches:
      backend:
        - id: build-api
          type: run
          run: npm run build:api
      frontend:
        - id: build-ui
          type: run
          run: npm run build:ui
      docs:
        - id: build-docs
          type: run
          run: npm run build:docs
```

**Merge strategies**:
- `object` (default): `{ "backend": result, "frontend": result, "docs": result }`
- `array`: `[result1, result2, result3]`
- `first`: Only the first branch's result

**Each branch** is a list of steps that execute sequentially within that branch.

### Parallel with agents

```yaml
- id: multi-review
  type: parallel
  parallel:
    maxConcurrent: 5
    branches:
      security:
        - id: sec-review
          type: spawn
          spawn: "Run a security audit of the codebase"
      performance:
        - id: perf-review
          type: spawn
          spawn: "Analyze performance bottlenecks"
      accessibility:
        - id: a11y-review
          type: spawn
          spawn: "Check accessibility compliance"
```

---

## loop — Iterate Over Collections

Process items from an array, sequentially or in parallel.

### Sequential loop

```yaml
- id: deploy-regions
  type: loop
  loop:
    over: $config.json.regions    # Array to iterate
    as: region                     # Variable name (default: item)
    index: i                       # Index variable (default: index)
    steps:
      - id: deploy
        type: run
        run: kubectl apply -f deploy.yaml --context=${item.cluster}
```

### Parallel loop

```yaml
- id: process-files
  type: loop
  loop:
    over: $scan.json.files
    as: file
    maxConcurrent: 8              # Process 8 files at a time
    maxIterations: 1000           # Safety limit
    collect: results              # Output key
    steps:
      - id: analyze
        type: spawn
        spawn:
          task: "Analyze file: ${item.path}"
          timeout: 60
```

**References inside loops**: Use `$item` (or custom `as`) for current item, `$index` for current index.

**Output**: The loop step's output is an array of results from each iteration.

---

## branch — Conditional Routing

Route execution based on conditions. First matching condition wins.

```yaml
- id: handle-result
  type: branch
  branch:
    conditions:
      - when: $test.json.failures > 0
        steps:
          - id: fix-bugs
            type: spawn
            spawn: "Fix these test failures: ${test.json.failures}"
          - id: retest
            type: run
            run: npm test

      - when: $test.json.coverage < 80
        steps:
          - id: add-tests
            type: spawn
            spawn: "Add tests to improve coverage to 80%+"

    default:
      - id: all-good
        type: transform
        transform: '{"status": "all checks passed"}'
```

**Conditions** support:
- Comparisons: `$step.json.count > 10`, `$step.status == "completed"`
- Boolean: `$step.approved`, `!$step.skipped`
- Logical: `$a.ready && $b.ready`, `$a.failed || $b.failed`

---

## transform — Data Shaping

Transform or extract data without running a command or agent.

### Reference extraction

```yaml
- id: extract-url
  type: transform
  transform: $fetch.json.data.url
```

### JSON template

```yaml
- id: summary
  type: transform
  transform: '{"env": "${args.env}", "version": "${build.json.version}"}'
```

### String interpolation

```yaml
- id: message
  type: transform
  transform: "Deployed ${args.image} to ${args.env} successfully"
```

---

## pipeline — Sub-Pipeline Composition

Run another pipeline YAML as a step. This is the key to building large, maintainable workflows from reusable parts.

### String shorthand

```yaml
- id: build
  type: pipeline
  pipeline: ./build.yaml
```

### Full config with args

```yaml
- id: build
  type: pipeline
  description: Build the project (sub-pipeline)
  pipeline:
    file: ./sub-build.yaml          # Path relative to THIS file
    args:
      target: $args.env              # Pass parent args via $refs
      data: $fetch.json              # Pass step outputs
    env:
      VERBOSE: "1"                   # Extra env vars for sub-pipeline
    cwd: /workspace                  # Override working directory
```

**File resolution**: The `file:` path is resolved relative to the **parent pipeline's directory**, not the working directory. So `./sub-build.yaml` next to `orchestrator.yaml` always works regardless of where you run from.

**Data flow**: The sub-pipeline's final output becomes this step's output. Reference it as `$build.json` in subsequent steps.

**Gates propagate**: If the sub-pipeline hits a gate, the parent pipeline halts too, with a resume token that covers the full state.

**Each sub-pipeline is standalone**: You can also run them directly:

```bash
squid run sub-build.yaml --args-json '{"target":"prod"}'
```

### Real-world example: Release orchestrator

```
skills/squid-pipeline/examples/
  orchestrator.yaml   ← parent: calls all three sub-pipelines
  sub-build.yaml      ← build: compile + lint
  sub-test.yaml       ← test: unit + integration + coverage
  sub-deploy.yaml     ← deploy: pre-check + gate + push + verify
```

**orchestrator.yaml** (abridged):

```yaml
name: orchestrator
args:
  env: { default: staging }

steps:
  - id: build
    type: pipeline
    pipeline:
      file: ./sub-build.yaml
      args: { target: $args.env }

  - id: test
    type: pipeline
    pipeline:
      file: ./sub-test.yaml
      args: { suite: all }
    when: "!$args.skip_tests"

  - id: deploy
    type: pipeline
    pipeline:
      file: ./sub-deploy.yaml
      args:
        artifact: $build.json.artifact
        env: $args.env
```

Running `squid run orchestrator.yaml -v` executes all sub-pipelines in sequence, threading data between them:

```
→ [build] pipeline...
  → [compile] run...  ✓
  → [lint] run...     ✓
✓ [build] completed
→ [test] pipeline...
  → [unit-tests] run...        ✓
  → [integration-tests] run... ✓
  → [coverage-report] run...   ✓
✓ [test] completed
→ [deploy] pipeline...
  → [pre-check] run... ✓
  ⊘ [prod-gate] skipped  (staging — no gate needed)
  → [push] run...      ✓
  → [verify] run...    ✓
✓ [deploy] completed
```

With `--args-json '{"env":"prod"}'`, the deploy sub-pipeline's prod gate activates and the whole orchestrator halts for approval.

---

## Events / Observability

Every step emits lifecycle events for monitoring, OTel integration, audit trails, and notifications.

### Event types

| Event | When | Useful data |
|-------|------|-------------|
| `pipeline:start` | Pipeline begins | `args`, `mode` |
| `pipeline:complete` | Pipeline finishes | `status`, `duration` |
| `pipeline:error` | Pipeline throws | `error` |
| `step:start` | Step begins executing | `stepId`, `stepType` |
| `step:complete` | Step finishes | `stepId`, `status`, `duration` |
| `step:error` | Step fails | `stepId`, `error` |
| `step:skip` | Step skipped (condition false) | `stepId`, `reason` |
| `step:retry` | Step retrying after failure | `stepId`, `attempt` |
| `gate:waiting` | Gate halts for approval | `stepId`, `prompt`, `shortId` |
| `gate:approved` | Gate approved | `stepId`, `approvedBy` |
| `gate:rejected` | Gate rejected | `stepId` |
| `spawn:start` | Agent spawn initiated | `stepId` |
| `spawn:complete` | Agent spawn finished | `stepId` |

### OTel-compatible fields

Every event includes:

| Field | Description |
|-------|-------------|
| `traceId` | Same as `runId` — correlates all events in one pipeline run |
| `spanId` | Unique per event |
| `parentSpanId` | Pipeline's span ID |
| `timestamp` | Unix milliseconds |
| `pipelineId` | Pipeline name |
| `runId` | Unique run ID |

### TypeScript usage

```typescript
import { createEventEmitter, runPipeline, parseFile } from "squid";

const events = createEventEmitter();

// Log all events (wildcard)
events.on("*", (event) => {
  console.log(`[${event.type}] ${event.stepId ?? "pipeline"} (${event.duration ?? 0}ms)`);
});

// Specific event types
events.on("gate:waiting", (event) => {
  sendSlackMessage(`Approval needed: ${event.data?.prompt} (ID: ${event.data?.shortId})`);
});

events.on("step:error", (event) => {
  alertOncall(`Step ${event.stepId} failed: ${event.data?.error}`);
});

// OTel spans
events.on("step:complete", (event) => {
  tracer.startSpan(event.stepId!, {
    traceId: event.traceId,
    spanId: event.spanId,
    attributes: { duration: event.duration, status: event.data?.status },
  });
});

const pipeline = parseFile("pipeline.yaml");
const result = await runPipeline(pipeline, { events });
```

### Removing listeners

```typescript
const handler = (event) => console.log(event);
events.on("step:start", handler);
events.off("step:start", handler);   // remove specific listener
```

See `skills/squid-pipeline/examples/observability.yaml` for a full pipeline example with event documentation.

---

## Common Step Options

These options work on any step type:

### when — Conditional execution

```yaml
- id: deploy
  type: run
  run: kubectl apply -f deploy.yaml
  when: $approve.approved && $test.json.pass
```

### retry — Automatic retry on failure

```yaml
- id: flaky-api
  type: run
  run: curl https://api.example.com
  retry:
    maxAttempts: 5
    backoff: exponential-jitter   # fixed | exponential | exponential-jitter
    delayMs: 1000                 # Base delay
    maxDelayMs: 30000             # Maximum delay
    retryOn:                      # Only retry these error patterns
      - ECONNRESET
      - timeout
      - "503"
```

Shorthand: `retry: 3` is equivalent to `retry: { maxAttempts: 3 }`.

### timeout — Step timeout

```yaml
- id: long-task
  type: run
  run: long-running-command
  timeout: 600   # 10 minutes in seconds
```

### env — Step-level environment

```yaml
- id: build
  type: run
  run: npm run build
  env:
    NODE_ENV: production
    API_URL: https://api.example.com
```

### description — Human-readable label

```yaml
- id: s1
  type: run
  run: complex-command --with --many --flags
  description: Build the Docker image with production settings
```
