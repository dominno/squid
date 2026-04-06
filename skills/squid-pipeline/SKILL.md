---
name: squid-pipeline
description: Create, modify, and debug agentic pipelines with Squid. Define multi-agent YAML workflows with spawn (OpenClaw, Claude Code, OpenCode), gates, parallel execution, loops, branching, restart loops, sub-pipelines, and structured approvals. Use when working with .yaml pipeline files or when the user mentions pipelines, workflows, agents, or Squid.
---

## Install

If Squid is not installed, install it first:

```bash
git clone https://github.com/dominno/squid.git
cd squid
npm install
npm run build
```

Then use directly:

```bash
npx squid run pipeline.yaml
npx squid test
npx squid validate pipeline.yaml
npx squid viz pipeline.yaml
npx squid init --template basic --name my-pipeline
```

Or link globally:

```bash
npm link
squid run pipeline.yaml
```

Requires **Node.js 20+**.

## Pipeline Structure

Build Squid pipelines in YAML. Every pipeline has `name`, `steps`, and optional `args`/`env`/`agent`.

```yaml
name: <pipeline-name>              # REQUIRED
description: <what it does>
agent: claude-code                 # default agent adapter for spawn steps
args:
  <key>:
    default: <value>
    description: <help text>
    required: true
env:
  KEY: value
onError: fail                      # fail | skip | continue

steps:
  - id: <unique-id>               # REQUIRED
    type: <step-type>              # REQUIRED
    description: <label>           # recommended
```

**Rules**: unique `id` per step, sequential execution, outputs available as `$stepId.json`.

## Step Types

| Type | Key Config | Purpose |
|------|-----------|---------|
| `run` | `run: "cmd"` | Shell command |
| `spawn` | `spawn: { task, agent, model }` | AI sub-agent |
| `gate` | `gate: { prompt, input, requiredApprovers }` | Human approval with structured input |
| `parallel` | `parallel: { branches, maxConcurrent }` | Fan-out/fan-in |
| `loop` | `loop: { over, as, steps, maxConcurrent }` | Iterate array |
| `branch` | `branch: { conditions, default }` | Conditional routing |
| `transform` | `transform: "$ref"` | Data shaping |
| `pipeline` | `pipeline: { file, args }` | Sub-pipeline |

See `references/step-types.md` for full config options and examples.

## Spawn — Agent Adapters

```yaml
- id: analyze
  type: spawn
  spawn:
    task: "Analyze code. Output JSON: { issues: [], score: number }"
    agent: claude-code             # openclaw | claude-code | opencode | custom
    model: claude-sonnet-4-6
    timeout: 300
```

Set pipeline-level default: `agent: claude-code` at root. Override per step.
Always specify **output format** in `task`. Always set `timeout`.

## Gate — Structured Input + Identity

```yaml
- id: deploy-config
  type: gate
  gate:
    prompt: "Configure deployment"
    input:                         # form fields, not just approve/reject
      - name: env
        type: select
        options: ["staging", "prod"]
      - name: replicas
        type: number
        default: 2
    requiredApprovers: ["lead"]    # only these IDs can approve
    allowSelfApproval: false       # initiator cannot approve
```

- Halts with 8-char **short ID** (chat-friendly) + full resume token
- Access input: `$gate.json.input.env`, `$gate.json.approvedBy`
- Input validated: type, required, regex, select options

## Common Options

Apply to any step:

```yaml
when: $approve.approved && $test.json.pass   # conditional
retry: { maxAttempts: 3, backoff: exponential-jitter }
restart: { step: write, when: $review.json.score < 80, maxRestarts: 3 }
timeout: 300
env: { KEY: value }
description: "Human-readable label"
```

## Data Flow

| Pattern | Value |
|---------|-------|
| `$stepId.json` | Parsed JSON output |
| `$stepId.stdout` | Raw stdout |
| `$stepId.approved` | Gate boolean |
| `$stepId.json.input.field` | Gate structured input |
| `$args.key` | Pipeline argument |
| `$env.VAR` | Environment variable |
| `$item` / `$index` | Loop context |

Interpolation: `${args.key}`, `${stepId.json.field}` in strings.

## Key Patterns

**Plan → Gate → Execute**: Always gate before side effects.

**Parallel Agents → Review**: Fan out to specialists, then aggregate.

**Iterative Refinement**: `restart:` loops back until quality threshold met.

**Sub-Pipeline Composition**: Break large workflows into `type: pipeline` stages.

**Error Handling**: `branch:` on `$step.status == "failed"` with rollback.

See `references/patterns.md` for full examples.

## Examples

Working pipeline examples in `examples/`:

| File | What it demonstrates |
|------|---------------------|
| `examples/simple-deploy.yaml` | Basic build → test → gate → deploy |
| `examples/orchestrator.yaml` | Sub-pipeline composition (calls sub-build, sub-test, sub-deploy) |
| `examples/multi-agent-dev.yaml` | 8 specialized agents: architect, coders, tester, reviewer, docs |
| `examples/video-pipeline.yaml` | Content creation with parallel asset generation loops |
| `examples/iterative-refinement.yaml` | Restart loop: write → review → refine until quality met |
| `examples/advanced-gates.yaml` | Structured input fields, requiredApprovers, short IDs |
| `examples/observability.yaml` | Event hooks, OTel spans, audit trails, chat notifications |
| `examples/simple-deploy.test.yaml` | YAML test file with sandbox + integration tests |
| `examples/sub-build.test.yaml` | YAML test file for sub-pipeline |

## Testing

Create `pipeline.test.yaml` alongside `pipeline.yaml`:

```yaml
pipeline: ./pipeline.yaml
tests:
  - name: "deploys when approved"
    mode: sandbox                  # nothing executes
    mocks:
      run:
        build: { output: { built: true } }
      spawn:
        reviewer: { output: { score: 95 } }
    gates:
      approve: true
    assert:
      status: completed
      steps:
        deploy: completed
```

Modes: `sandbox` (all mocked) | `integration` (run steps execute).
Run: `squid test` (auto-discovers) or `squid test file.test.yaml`.

See `references/testing.md` for assertion types and examples.

## Events / Observability

Pipeline execution emits lifecycle events for monitoring, OTel, audit trails, and chat notifications.

```typescript
import { createEventEmitter, runPipeline, parseFile } from "squid";

const events = createEventEmitter();
events.on("*", (e) => console.log(`[${e.type}] ${e.stepId}`));
events.on("gate:waiting", (e) => slack.send(`Approve: ${e.data?.prompt}`));
events.on("step:error", (e) => pagerduty.trigger(`${e.stepId}: ${e.data?.error}`));

await runPipeline(parseFile("pipeline.yaml"), { events });
```

**13 event types**: `pipeline:start/complete/error`, `step:start/complete/error/skip/retry`, `gate:waiting/approved/rejected`, `spawn:start/complete`.

**OTel-compatible**: every event has `traceId`, `spanId`, `timestamp`, `duration`.

See `references/step-types.md` and `examples/observability.yaml` for details.

## CLI

```bash
squid run <file> [--args-json '{}'] [--dry-run] [-v]
squid test [file.test.yaml]
squid resume <file> --token <token> --approve yes|no
squid validate <file>
squid viz <file>
squid init --template basic|agent|parallel|full --name <name>
```

## Anti-Patterns

1. **No spawn output format** — always tell the agent what JSON shape to return
2. **No timeout** on spawn/run — agents can hang forever
3. **No gate before side effects** — gate destructive operations
4. **Deep nesting** — use `type: pipeline` instead
5. **No maxIterations** on loops — prevent runaway execution
6. **autoApprove in production** — only for dev/CI

## Checklist

- [ ] Every step has unique `id` and `description`
- [ ] `spawn` steps specify output format and `timeout`
- [ ] Destructive ops are gated
- [ ] Loops have `maxIterations`
- [ ] Flaky ops have `retry`
- [ ] Complex pipelines use sub-pipelines
- [ ] `.test.yaml` covers happy path, rejection, and errors
- [ ] `squid validate` and `squid test` pass
