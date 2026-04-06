# Squid Pipeline Authoring Skill

You are an expert at building agentic pipelines with **Squid**, an OpenClaw-native pipeline framework. When the user asks you to create, modify, or debug a pipeline, follow this guide precisely.

---

## What is Squid

Squid defines multi-agent workflows in YAML. Every step can spawn AI sub-agents via OpenClaw's `sessions_spawn`, gate on human approval, run shell commands, loop, branch, execute in parallel, or call other pipeline files. Pipelines are resumable, testable, and visualizable.

---

## Pipeline Structure

Every pipeline YAML has this shape:

```yaml
name: <pipeline-name>              # REQUIRED — unique identifier
description: <what it does>        # recommended
version: "1.0"                     # optional semver

args:                              # pipeline inputs
  <key>:
    default: <value>               # optional default
    description: <help text>       # optional
    required: true                 # optional — fails if not provided
    type: string                   # optional — string | number | boolean | object

env:                               # pipeline-level environment variables
  KEY: value

cwd: /working/directory            # optional — default is process.cwd()
onError: fail                      # optional — fail | skip | continue

steps:                             # REQUIRED — ordered list of steps
  - id: <unique-step-id>          # REQUIRED — used in $refs
    type: <step-type>              # REQUIRED or inferred from key
    description: <what it does>    # recommended for readability
    # ... type-specific config
```

### Rules

1. Every step MUST have a unique `id` across the entire pipeline including nested steps.
2. `type` is inferred if you use the matching key (`run:` → run, `spawn:` → spawn, etc.), but explicit `type:` is preferred for clarity.
3. Steps execute **sequentially** top to bottom unless inside `parallel:` or `loop:` with `maxConcurrent > 1`.
4. All step outputs are available to subsequent steps via `$stepId.json`, `$stepId.stdout`, etc.

---

## Step Types — Complete Reference

### 1. `run` — Shell Command

```yaml
- id: build
  type: run
  run: docker build -t ${args.image} .
  timeout: 300              # seconds (default: 300)
  cwd: /project             # override working directory
  env:                      # step-level env vars
    NODE_ENV: production
  retry: 3                  # shorthand for { maxAttempts: 3 }
```

- Stdout is captured. If valid JSON, automatically parsed as `$build.json`.
- Use `${args.key}` and `${stepId.json.field}` for interpolation in the command string.
- **Always set `timeout`** for long-running commands.

### 2. `spawn` — AI Sub-Agent (Pluggable Runtime)

Spawns a real AI agent. Works with **OpenClaw**, **Claude Code**, **OpenCode**, or any custom adapter.

```yaml
# Simple — string shorthand (uses pipeline default or openclaw)
- id: analyze
  type: spawn
  spawn: "Analyze the codebase for security issues"

# Full config
- id: architect
  type: spawn
  spawn:
    task: |                        # REQUIRED — the agent's instruction
      Design an architecture for: ${args.feature}
      Output JSON with: { files: [], interfaces: [], tests: [] }
    agent: claude-code             # agent adapter: openclaw | claude-code | opencode | custom
    model: claude-sonnet-4-6       # model override
    thinking: high                 # off | low | high (OpenClaw only)
    cwd: ${args.repo}              # workspace directory
    timeout: 300                   # seconds
    # OpenClaw-specific options:
    agentId: architect-agent       # target agent ID
    runtime: subagent              # subagent | acp
    mode: run                      # run (ephemeral) | session (persistent)
    sandbox: inherit               # inherit | require
    attachments:                   # file attachments
      - name: spec.md
        content: "..."
        encoding: utf8
        mimeType: text/markdown
```

**Set pipeline-level default** so you don't repeat `agent:` on every step:

```yaml
name: my-pipeline
agent: claude-code               # all spawn steps use Claude Code by default

steps:
  - id: plan
    type: spawn
    spawn:
      task: "Plan the feature"
      # → uses claude-code

  - id: review
    type: spawn
    spawn:
      agent: openclaw            # override just for this step
      task: "Review the code"
      agentId: reviewer
```

**Best practices for spawn tasks:**
- Always tell the agent the **output format** you expect (e.g., "Output JSON with: { ... }").
- Pass context from previous steps: `"Plan: ${architect.json}"`.
- Set `thinking: high` for complex reasoning tasks (architecture, code review).
- Set `timeout` — agents can run indefinitely without one.
- Use `agentId` when you have specialized agents configured in OpenClaw.

### 3. `gate` — Human Approval Checkpoint

```yaml
# Simple — string shorthand
- id: approve
  type: gate
  gate: "Deploy to production?"

# Full config
- id: review
  type: gate
  gate:
    prompt: "Deploy ${args.image} to ${args.env}?"   # REQUIRED
    preview: $build.json           # data shown to approver
    items: $test.json.results      # list of items shown
    timeout: 3600                  # auto-reject after N seconds
    autoApprove: false             # set true for CI/test mode only
    approvers:                     # required approver IDs
      - admin
      - lead
```

- Pipeline **halts** and outputs a resume token.
- Resume: `squid resume <file> --token <token> --approve yes|no`
- Reference: `$approve.approved` (boolean), `$approve.skipped` (boolean).
- Gates inside sub-pipelines propagate up — the parent halts too.
- **Never use `autoApprove: true` for production gates.**

### 4. `parallel` — Fan-Out Concurrent Branches

```yaml
- id: build-all
  type: parallel
  parallel:
    maxConcurrent: 3           # limit concurrent branches (default: all)
    failFast: true             # abort all on first failure (default: true)
    merge: object              # object | array | first
    branches:
      backend:                 # branch name → becomes key in output
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

- Each branch is an array of steps that execute sequentially **within** that branch.
- Branches execute **concurrently** with each other.
- Output with `merge: object`: `{ "backend": result, "frontend": result, "docs": result }`.
- Output with `merge: array`: `[result1, result2, result3]`.
- Output with `merge: first`: only the first branch's result.

### 5. `loop` — Iterate Over Collections

```yaml
- id: process-items
  type: loop
  loop:
    over: $data.json.items         # REQUIRED — must resolve to an array
    as: item                       # variable name (default: "item")
    index: i                       # index variable (default: "index")
    maxConcurrent: 4               # parallel iterations (default: 1 = sequential)
    maxIterations: 1000            # safety limit (default: 1000)
    collect: results               # output key name
    steps:                         # REQUIRED — steps per iteration
      - id: process
        type: spawn
        spawn:
          task: "Process: ${item.name}"
```

- Inside loop steps, use `$item` (or custom `as` name) and `$index`.
- Loop output is an array of results from each iteration.
- Set `maxConcurrent > 1` for parallel processing.
- **Always set `maxIterations`** to prevent runaway loops.

### 6. `branch` — Conditional Routing

```yaml
- id: handle-result
  type: branch
  branch:
    conditions:                    # evaluated top-to-bottom, first match wins
      - when: $test.json.failures > 0
        steps:
          - id: fix
            type: spawn
            spawn: "Fix test failures: ${test.json.failures}"
      - when: $test.json.coverage < 80
        steps:
          - id: add-tests
            type: spawn
            spawn: "Improve coverage to 80%+"
    default:                       # optional fallback
      - id: all-good
        type: transform
        transform: '{"status": "passed"}'
```

- First matching condition executes; others are skipped.
- Always provide a `default` branch for safety unless you're sure one condition will match.

### 7. `transform` — Data Shaping

```yaml
# Extract a value
- id: url
  type: transform
  transform: $fetch.json.data.url

# JSON template
- id: summary
  type: transform
  transform: '{"env": "${args.env}", "version": "${build.json.version}"}'

# String interpolation
- id: message
  type: transform
  transform: "Deployed ${args.image} to ${args.env}"
```

- No shell execution, no agent call — pure data transformation.
- Use for extracting fields, building summaries, or shaping data between steps.

### 8. `pipeline` — Sub-Pipeline Composition

```yaml
# String shorthand — just the file path
- id: build
  type: pipeline
  pipeline: ./stages/build.yaml

# Full config
- id: build
  type: pipeline
  pipeline:
    file: ./stages/build.yaml      # REQUIRED — relative to THIS pipeline's directory
    args:                          # arguments passed to sub-pipeline
      target: $args.env            # $refs are resolved in parent context
      data: $fetch.json
    env:                           # extra env vars
      VERBOSE: "1"
    cwd: /workspace                # override working dir
```

- File path resolves relative to the **parent pipeline's file location**, not cwd.
- Sub-pipeline's final output becomes this step's output (`$build.json`).
- Gates inside sub-pipelines propagate — parent halts too.
- Each sub-pipeline is standalone — can be run and tested independently.
- **This is the primary tool for keeping pipelines maintainable.** Extract reusable stages into separate files.

---

## Common Step Options

These work on ANY step type:

### `when` — Conditional Execution

```yaml
- id: deploy
  type: run
  run: kubectl apply -f deploy.yaml
  when: $approve.approved && $test.json.pass
```

Supported expressions:
- References: `$step.approved`, `$step.skipped`, `$step.json.field`
- Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logic: `&&` (AND), `||` (OR), `!` (NOT)
- Literals: `true`, `false`, numbers, `"quoted strings"`

### `retry` — Automatic Retry

```yaml
# Shorthand
retry: 3

# Full config
retry:
  maxAttempts: 5
  backoff: exponential-jitter    # fixed | exponential | exponential-jitter
  delayMs: 1000                  # base delay (ms)
  maxDelayMs: 30000              # max delay cap (ms)
  retryOn:                       # only retry on these error patterns
    - ECONNRESET
    - timeout
    - "503"
```

- Retry wraps any step type including `spawn` and `pipeline`.
- **Always add retry to network calls and flaky operations.**

### `restart` — Jump Back to a Previous Step

Enables iterative refinement loops: if a condition is met, execution jumps back to an earlier step and re-runs everything from there.

```yaml
# String shorthand — always restart, max 3 times
restart: "write"

# Full config
restart:
  step: write                       # REQUIRED — step ID to jump back to
  when: $review.json.score < 80     # REQUIRED — condition to trigger restart
  maxRestarts: 3                    # safety limit (default: 3)
```

- `step` must reference a step **before** the current one (no forward jumps).
- On restart, results for all steps between target and current are **cleared** so they re-execute fresh.
- When `maxRestarts` is exhausted, execution continues forward normally.
- **Always set `maxRestarts`** to prevent infinite loops.

**Typical use case — agent refinement loop:**

```yaml
steps:
  - id: write
    type: spawn
    spawn:
      task: |
        Implement: ${args.task}
        Prior feedback: ${review.json.feedback}
        Output JSON: { "code": "...", "explanation": "..." }

  - id: review
    type: spawn
    spawn:
      task: |
        Review this code. Score 0-100.
        Output JSON: { "score": number, "feedback": "..." }
      thinking: high

  - id: decide
    type: transform
    transform: "$review.json.score"
    restart:
      step: write
      when: $review.json.score < 80
      maxRestarts: 3
```

This runs write→review→decide, and if score < 80 it jumps back to `write` (which now has access to `${review.json.feedback}` from the previous iteration). After 3 restarts it stops regardless.

### `timeout` — Step Timeout

```yaml
timeout: 600   # seconds
```

### `env` — Step-Level Environment

```yaml
env:
  API_URL: https://api.example.com
  NODE_ENV: production
```

### `description` — Human-Readable Label

```yaml
description: Build Docker image with production optimizations
```

**Always add descriptions** — they appear in Mermaid diagrams, verbose output, and logs.

---

## Data Flow Reference

| Pattern | Resolves To |
|---------|-------------|
| `$stepId.json` | Parsed JSON output of step |
| `$stepId.json.field.nested` | Nested field access |
| `$stepId.stdout` | Raw stdout string |
| `$stepId.status` | Step status (completed, failed, skipped) |
| `$stepId.approved` | Boolean — true if gate was approved |
| `$stepId.skipped` | Boolean — true if step was skipped |
| `$stepId.error` | Error message string |
| `$stepId.duration` | Duration in milliseconds |
| `$stepId.childSessionKey` | OpenClaw session key (spawn steps) |
| `$args.key` | Pipeline argument value |
| `$env.VAR` | Environment variable |
| `$state.key` | User-managed state |
| `$item` | Current loop item (inside loop) |
| `$item.field` | Nested field on loop item |
| `$index` | Current loop index (inside loop) |

**Interpolation** uses `${...}` inside strings:
```yaml
run: "echo Deploying ${args.image} to ${args.env}"
spawn:
  task: "Analyze: ${fetch.json.data}"
gate:
  prompt: "Deploy ${build.json.artifact}?"
```

---

## Patterns You Should Use

### Pattern: Plan → Gate → Execute

Always gate before side effects:

```yaml
steps:
  - id: plan
    type: spawn
    spawn:
      task: "Create a plan for: ${args.task}"
      thinking: high

  - id: review
    type: gate
    gate:
      prompt: "Review the plan. Approve to execute."
      preview: $plan.json

  - id: execute
    type: spawn
    spawn:
      task: "Execute this plan: ${plan.json}"
    when: $review.approved
```

### Pattern: Parallel Agents → Review

Fan out work to specialized agents, then review:

```yaml
steps:
  - id: work
    type: parallel
    parallel:
      maxConcurrent: 3
      merge: object
      branches:
        research:
          - id: researcher
            type: spawn
            spawn: "Research: ${args.topic}"
        implement:
          - id: coder
            type: spawn
            spawn: "Implement: ${args.topic}"
        test:
          - id: tester
            type: spawn
            spawn: "Write tests for: ${args.topic}"

  - id: review
    type: spawn
    spawn:
      task: |
        Review all outputs:
        Research: ${researcher.json}
        Code: ${coder.json}
        Tests: ${tester.json}
      thinking: high
```

### Pattern: Loop with Parallel Processing

Process a batch of items with concurrency:

```yaml
steps:
  - id: discover
    type: run
    run: find /data -name "*.json" | jq -Rs 'split("\n") | map(select(. != ""))'

  - id: process
    type: loop
    loop:
      over: $discover.json
      maxConcurrent: 8
      maxIterations: 500
      steps:
        - id: analyze
          type: spawn
          spawn:
            task: "Analyze file: ${item}"
            timeout: 60
```

### Pattern: Sub-Pipeline Orchestration

Break large pipelines into reusable stages:

```yaml
# orchestrator.yaml
steps:
  - id: build
    type: pipeline
    pipeline:
      file: ./stages/build.yaml
      args: { target: $args.env }

  - id: test
    type: pipeline
    pipeline:
      file: ./stages/test.yaml
    when: "!$args.skip_tests"

  - id: deploy
    type: pipeline
    pipeline:
      file: ./stages/deploy.yaml
      args:
        artifact: $build.json.artifact
        env: $args.env
```

Each stage file is a standalone pipeline with its own `name`, `args`, and `steps`.

### Pattern: Iterative Agent Refinement (restart)

Have an agent produce work, review it, and loop back until quality is met:

```yaml
steps:
  - id: write
    type: spawn
    spawn:
      task: |
        Implement: ${args.task}
        Prior review feedback: ${review.json.feedback}
        Output JSON: { "code": "...", "explanation": "..." }
      timeout: 300

  - id: review
    type: spawn
    spawn:
      task: |
        Review this code for: ${args.task}
        Code: ${write.json.code}
        Score 0-100. Output JSON: { "score": number, "feedback": "...", "issues": [...] }
      thinking: high
      timeout: 180

  - id: quality-gate
    type: transform
    transform: "$review.json.score"
    restart:
      step: write                    # jump back to writing step
      when: $review.json.score < 80  # if below threshold
      maxRestarts: 3                 # max 3 refinement cycles

  - id: approve
    type: gate
    gate:
      prompt: "Score: ${review.json.score}. Approve?"
      preview: $write.json
```

Flow: write → review → score=60 → restart → write (with feedback) → review → score=85 → continue → approve.

### Pattern: Conditional Error Handling

Branch based on step results:

```yaml
- id: deploy
  type: run
  run: kubectl apply -f deploy.yaml
  retry:
    maxAttempts: 3
    backoff: exponential

- id: handle
  type: branch
  branch:
    conditions:
      - when: $deploy.status == "failed"
        steps:
          - id: rollback
            type: run
            run: kubectl rollout undo deployment/app
          - id: alert
            type: spawn
            spawn: "Deployment failed. Diagnose the issue."
    default:
      - id: verify
        type: run
        run: kubectl rollout status deployment/app
```

### Pattern: Environment-Specific Routing

```yaml
- id: deploy
  type: branch
  branch:
    conditions:
      - when: $args.env == "prod"
        steps:
          - id: prod-gate
            type: gate
            gate: "Deploy to PRODUCTION?"
          - id: prod-deploy
            type: run
            run: kubectl apply -f k8s/prod/
            when: $prod-gate.approved
      - when: $args.env == "staging"
        steps:
          - id: staging-deploy
            type: run
            run: kubectl apply -f k8s/staging/
    default:
      - id: dev-deploy
        type: run
        run: docker compose up -d
```

---

## Anti-Patterns — Never Do These

### 1. Steps without IDs or descriptions

```yaml
# BAD
- run: echo hello

# GOOD
- id: greet
  type: run
  description: Greet the user
  run: echo hello
```

### 2. Spawn without output format instruction

```yaml
# BAD — agent returns unstructured text
- id: analyze
  type: spawn
  spawn: "Analyze the code"

# GOOD — agent knows what to return
- id: analyze
  type: spawn
  spawn:
    task: |
      Analyze the code at ${args.repo}.
      Output JSON with: { issues: [...], score: number, summary: string }
    thinking: high
```

### 3. Missing timeout on spawn/run

```yaml
# BAD — can hang forever
- id: agent
  type: spawn
  spawn: { task: "..." }

# GOOD
- id: agent
  type: spawn
  spawn:
    task: "..."
    timeout: 300
```

### 4. Side effects without gates

```yaml
# BAD — deploys without asking
- id: deploy
  type: run
  run: kubectl apply -f prod.yaml

# GOOD — gate before destructive actions
- id: approve
  type: gate
  gate: "Deploy to production?"
- id: deploy
  type: run
  run: kubectl apply -f prod.yaml
  when: $approve.approved
```

### 5. Deep nesting instead of sub-pipelines

```yaml
# BAD — 5 levels of nesting
- id: outer
  type: loop
  loop:
    over: $data.json
    steps:
      - id: inner
        type: loop
        loop:
          over: $item.children
          steps:
            - id: deep
              type: branch
              # ... more nesting

# GOOD — extract to sub-pipeline
- id: process
  type: loop
  loop:
    over: $data.json
    steps:
      - id: handle
        type: pipeline
        pipeline:
          file: ./process-item.yaml
          args: { item: $item }
```

### 6. autoApprove in production

```yaml
# BAD
- id: gate
  type: gate
  gate:
    prompt: "Deploy?"
    autoApprove: true   # DANGEROUS in prod

# autoApprove is ONLY for dev/CI. Use --test flag instead.
```

### 7. Loops without maxIterations

```yaml
# BAD — unbounded loop
- id: loop
  type: loop
  loop:
    over: $data.json
    steps: [...]

# GOOD
- id: loop
  type: loop
  loop:
    over: $data.json
    maxIterations: 500
    steps: [...]
```

---

## Testing Pipelines

Every pipeline should be testable without a live OpenClaw instance.

```typescript
import { createTestRunner } from "squid/testing";
import { parseFile } from "squid";

const pipeline = parseFile("my-pipeline.yaml");

const result = await createTestRunner()
  .mockSpawn("research", { output: { findings: ["a", "b"] } })
  .mockSpawn("coder", { output: { files: ["app.ts"] } })
  .approveGate("review")
  .rejectGate("dangerous-gate")
  .withArgs({ env: "test", feature: "auth" })
  .withEnv({ API_KEY: "test-key" })
  .run(pipeline);

// Assertions
expect(result.status).toBe("completed");
result.assertStepCompleted("research");
result.assertStepCompleted("coder");
result.assertStepSkipped("dangerous-gate-action");
```

**When writing pipelines, also write tests:**
- Test the happy path (all spawns succeed, all gates approved).
- Test rejection paths (reject gates → verify subsequent steps skip).
- Test error handling (override steps with failures → verify branch routing).

---

## CLI Commands

```bash
squid run <file> [--args-json '{}'] [--dry-run] [--test] [-v]
squid resume <file> --token <token> --approve yes|no
squid validate <file>
squid viz <file>                    # outputs Mermaid diagram
squid dev <file>                    # watch mode
squid init --template <t> --name <n>   # basic | agent | parallel | full
```

**Always validate before running:**
```bash
squid validate pipeline.yaml
squid run pipeline.yaml --dry-run -v
```

---

## Checklist — Before Submitting a Pipeline

- [ ] Every step has a unique `id`
- [ ] Every step has a `description`
- [ ] `spawn` steps specify output format in `task`
- [ ] `spawn` and `run` steps have `timeout`
- [ ] Destructive operations are gated
- [ ] Loops have `maxIterations`
- [ ] Flaky operations have `retry`
- [ ] Complex pipelines use sub-pipeline composition (`type: pipeline`)
- [ ] Pipeline has `args` with descriptions for all inputs
- [ ] Pipeline is validated: `squid validate <file>`
- [ ] Pipeline is tested with `TestRunner` mocks
