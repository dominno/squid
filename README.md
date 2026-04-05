# Squid-Claw

**OpenClaw-native agentic pipeline framework** — built to replace Lobster.

Squid-Claw lets you define multi-agent workflows in YAML with native sub-agent spawning, approval gates, parallel execution, loops, branching, and retries. Every step can spawn a sub-agent via OpenClaw's `sessions_spawn`. No Bash glue needed.

## Architecture

```mermaid
graph TD
  YAML["pipeline.yaml"] --> Parser["Parser<br/>(YAML → typed Pipeline)"]
  Parser --> Runtime["Runtime Engine"]
  Runtime --> Run["run: shell cmd"]
  Runtime --> Spawn["spawn: sessions_spawn"]
  Runtime --> Gate["gate: approval"]
  Runtime --> Parallel["parallel: fan-out/in"]
  Runtime --> Loop["loop: iterate"]
  Runtime --> Branch["branch: conditional"]
  
  Spawn --> OC["OpenClaw<br/>sessions_spawn API"]
  OC --> Sub1["Sub-agent 1"]
  OC --> Sub2["Sub-agent 2"]
  OC --> SubN["Sub-agent N"]
  
  Gate --> Resume["Resume Token"]
  Resume --> Runtime
  
  Runtime --> Results["Step Results"]
  Results --> Graph["Graph Visualizer<br/>(Mermaid)"]
  
  style YAML fill:#3498db,color:#fff
  style Runtime fill:#2ecc71,color:#fff
  style OC fill:#e74c3c,color:#fff
  style Gate fill:#f39c12,color:#fff
```

### Execution Flow

```mermaid
sequenceDiagram
  participant CLI as squid-claw CLI
  participant P as Parser
  participant R as Runtime
  participant OC as OpenClaw
  participant SA as Sub-Agent

  CLI->>P: parseFile(pipeline.yaml)
  P->>R: runPipeline(pipeline, opts)
  
  loop Each Step
    R->>R: evaluateCondition(when)
    alt type: run
      R->>R: execSync(command)
    else type: spawn
      R->>OC: sessions_spawn(task, agentId)
      OC->>SA: Create sub-session
      SA-->>OC: Completion result
      OC-->>R: StepResult
    else type: gate
      R-->>CLI: { status: halted, resumeToken }
      CLI->>R: resume(token, approve=yes)
    else type: parallel
      R->>R: Promise.all(branches)
    else type: loop
      R->>R: for each item in array
    end
  end
  
  R-->>CLI: RunResult
```

## Install

```bash
# From source
git clone <repo>
cd squid-claw
npm install
npm run build

# Run
npx squid-claw run pipeline.yaml
# or in dev mode
npm run dev -- run pipeline.yaml
```

## Quick Start

### 1. Define a pipeline

```yaml
# deploy.yaml
name: deploy
args:
  env:
    default: staging
  image:
    required: true

steps:
  - id: build
    type: run
    run: docker build -t ${args.image} .
    retry: 2

  - id: test
    type: run
    run: docker run --rm ${args.image} npm test

  - id: approve
    type: gate
    gate: "Deploy ${args.image} to ${args.env}?"

  - id: deploy
    type: run
    run: kubectl set image deployment/app app=${args.image} -n ${args.env}
    when: $approve.approved
```

### 2. Run it

```bash
squid-claw run deploy.yaml --args-json '{"image": "myapp:v2"}'
```

### 3. Resume after approval

```bash
squid-claw resume deploy.yaml --token <token> --approve yes
```

### 4. Visualize

```bash
squid-claw viz deploy.yaml
```

## Step Types

| Type | Description | Key Config |
|------|-------------|------------|
| `run` | Execute a shell command | `run: "command"` |
| `spawn` | Spawn OpenClaw sub-agent | `spawn: { task, agentId, model }` |
| `gate` | Human approval checkpoint | `gate: { prompt, preview }` |
| `parallel` | Fan-out concurrent branches | `parallel: { branches, maxConcurrent }` |
| `loop` | Iterate over array items | `loop: { over, as, steps, maxConcurrent }` |
| `branch` | Conditional routing | `branch: { conditions: [{ when, steps }] }` |
| `transform` | Inline data transformation | `transform: "$step.json.field"` |
| `pipeline` | Run a sub-pipeline YAML | `pipeline: { file, args }` |

## Data Flow

Reference outputs from previous steps:

```yaml
- id: fetch
  type: run
  run: curl -s https://api.example.com/data

- id: process
  type: spawn
  input: $fetch.json              # Pass fetch output to spawn
  spawn:
    task: "Process this data: ${fetch.json}"

- id: check
  type: branch
  branch:
    conditions:
      - when: $process.json.count > 10
        steps:
          - id: alert
            type: run
            run: notify "High count: ${process.json.count}"
```

### Reference Syntax

| Pattern | Resolves To |
|---------|-------------|
| `$stepId.json` | Parsed JSON output |
| `$stepId.stdout` | Raw stdout string |
| `$stepId.status` | Step status |
| `$stepId.approved` | Boolean (gate steps) |
| `$args.key` | Pipeline argument |
| `$env.VAR` | Environment variable |
| `$item` | Current loop item |
| `$index` | Current loop index |

## Retry

Any step can retry on failure:

```yaml
- id: flaky-api
  type: run
  run: curl https://flaky.example.com
  retry:
    maxAttempts: 3
    backoff: exponential-jitter    # fixed | exponential | exponential-jitter
    delayMs: 1000
    maxDelayMs: 30000
    retryOn: ["ECONNRESET", "timeout"]
```

## Parallel Execution

Fan out work and merge results:

```yaml
- id: analyze
  type: parallel
  parallel:
    maxConcurrent: 5
    failFast: true
    merge: object                    # object | array | first
    branches:
      security:
        - id: sec-scan
          type: spawn
          spawn: { task: "Run security audit" }
      performance:
        - id: perf-test
          type: run
          run: npm run benchmark
      lint:
        - id: lint
          type: run
          run: npm run lint
```

## Restart (Jump Back)

Any step can jump back to a previous step when a condition is met — enabling iterative refinement loops:

```yaml
steps:
  - id: write
    type: spawn
    spawn:
      task: |
        Implement: ${args.task}
        Prior feedback: ${review.json.feedback}

  - id: review
    type: spawn
    spawn:
      task: "Review the code. Score 0-100."
      thinking: high

  - id: decide
    type: transform
    transform: "$review.json.score"
    restart:
      step: write                      # jump back to this step
      when: $review.json.score < 80    # if this condition is true
      maxRestarts: 3                   # safety limit (default: 3)
```

Flow: `write → review → score=50 → RESTART → write(+feedback) → review → score=85 → continue`

- Target step must be **before** the current step (no forward jumps)
- Results between target and current are **cleared** on restart
- Previous iteration outputs are available via `$refs` (e.g., `${review.json.feedback}`)
- After `maxRestarts` exhausted, execution continues forward

See `examples/iterative-refinement.yaml` for a full working example.

## Sub-Pipeline Composition

Run another YAML pipeline as a step. File paths resolve relative to the parent pipeline's directory.

```yaml
steps:
  - id: build
    type: pipeline
    pipeline:
      file: ./stages/build.yaml        # relative to THIS file
      args:
        target: $args.env              # pass parent args via $refs
        data: $fetch.json              # pass step outputs

  - id: deploy
    type: pipeline
    pipeline:
      file: ./stages/deploy.yaml
      args:
        artifact: $build.json.artifact
```

- Sub-pipeline output becomes the step's output (`$build.json`)
- Gates inside sub-pipelines propagate up — parent halts too
- Each sub-pipeline is standalone and independently testable

See `examples/orchestrator.yaml` with `sub-build.yaml`, `sub-test.yaml`, `sub-deploy.yaml`.

## Testing

Built-in mock support — no OpenClaw needed for tests:

```typescript
import { createTestRunner } from "squid-claw/testing";
import { parseFile } from "squid-claw";

const pipeline = parseFile("deploy.yaml");

const result = await createTestRunner()
  .mockSpawn("architect", { output: { plan: "..." } })
  .approveGate("review")
  .withArgs({ env: "test", image: "test:latest" })
  .run(pipeline);

result.assertStepCompleted("build");
result.assertStepCompleted("deploy");
```

## Squid-Claw vs Lobster

| Feature | Lobster | Squid-Claw |
|---------|---------|------------|
| **Sub-agent Spawn** | Manual tool call via `openclaw.invoke` | Native `spawn:` block with `sessions_spawn` |
| **Parallel Execution** | Not supported | `parallel:` with `maxConcurrent` |
| **Loops** | No native syntax | `loop:` with parallel iterations |
| **Conditional Branching** | Basic `when: $step.approved` | `branch:` with multi-condition routing |
| **Retry** | LLM-specific only | Any step, configurable backoff |
| **Error Handling** | Fail on first error | `onError: skip\|continue\|fail` per pipeline |
| **Data Flow** | `stdin: $step.json` | `input: $step.json` + `${step.json.field}` interpolation |
| **Conditions** | `$step.approved\|skipped` | Full expressions: `$a.count > 5 && $b.ready` |
| **Testing** | Script flags | Built-in `TestRunner` with mocks |
| **Visualization** | None | Mermaid graph export |
| **Sub-Pipelines** | Not supported | `pipeline:` for composable stages |
| **Restart / Jump Back** | Not supported | `restart:` for iterative refinement loops |
| **Resumability** | Opaque token + state dir | Self-contained base64 token |
| **Principles** | Partial SOLID | Full SOLID/DRY/KISS |
| **CLI** | `lobster run --file` | `squid-claw run` (file auto-detected) |

## CLI Reference

```
squid-claw run <file> [options]       Execute a pipeline
squid-claw resume <file> [options]    Resume a halted pipeline
squid-claw validate <file>            Validate pipeline syntax
squid-claw viz <file>                 Output Mermaid diagram
squid-claw dev <file>                 Watch mode (dry-run on save)

Options:
  --args-json '{...}'    Pipeline arguments
  --dry-run              Show execution plan without running
  --test                 Use mock adapters
  -v, --verbose          Step-by-step progress output
  --cwd <dir>            Working directory override
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_URL` | OpenClaw gateway URL (for spawn steps) |
| `OPENCLAW_TOKEN` | Auth token for OpenClaw |
| `CLAWD_URL` | Fallback for `OPENCLAW_URL` |
| `CLAWD_TOKEN` | Fallback for `OPENCLAW_TOKEN` |

## Project Structure

```
squid-claw/
├── bin/squid-claw.js          # CLI entry point
├── src/
│   ├── index.ts               # Public API exports
│   ├── core/
│   │   ├── types.ts           # All type definitions (SOLID interfaces)
│   │   ├── parser.ts          # YAML/JSON → Pipeline
│   │   ├── runtime.ts         # Pipeline execution engine
│   │   ├── expressions.ts     # $ref resolution & conditions
│   │   ├── resume.ts          # Resume token encode/decode
│   │   └── graph.ts           # Mermaid visualization
│   ├── cli/
│   │   └── main.ts            # CLI commands
│   └── testing/
│       └── index.ts           # TestRunner & mock utilities
├── examples/
│   ├── orchestrator.yaml      # Parent pipeline calling sub-pipelines
│   ├── sub-build.yaml         # Reusable build stage
│   ├── sub-test.yaml          # Reusable test stage
│   ├── sub-deploy.yaml        # Reusable deploy stage (with prod gate)
│   ├── multi-agent-dev.yaml   # 8-agent dev pipeline
│   ├── video-pipeline.yaml    # Video content creation
│   ├── simple-deploy.yaml     # Minimal deploy example
│   ├── iterative-refinement.yaml # Restart/jump-back refinement loop
│   └── lobster-migration.yaml # Migration guide from Lobster
├── agent-skill/
│   └── SKILL.md               # AI agent skill for pipeline authoring
├── package.json
├── tsconfig.json
└── README.md
```

## AI Agent Skill

Squid-Claw ships with an **agent skill file** at [`agent-skill/SKILL.md`](agent-skill/SKILL.md) — a comprehensive reference that teaches any AI agent how to correctly author pipelines.

Feed it to the AI agent of your choice:

- **Claude Code / OpenClaw** — add to your agent's system prompt or attach as a file via `sessions_spawn`:
  ```yaml
  - id: build-pipeline
    type: spawn
    spawn:
      task: "Create a deployment pipeline for my Node.js app"
      attachments:
        - name: SKILL.md
          content: <contents of agent-skill/SKILL.md>
          mimeType: text/markdown
  ```
- **Claude (claude.ai)** — paste `SKILL.md` into the Project Knowledge or as a conversation attachment
- **ChatGPT / Custom GPTs** — upload as a knowledge file or paste into the system instructions
- **Cursor / Windsurf / Copilot** — place the file in your project root or reference it in your AI rules config
- **Any LLM API** — include in the system prompt or as a user message before your pipeline request

The skill covers all 8 step types, data flow references, best practices, anti-patterns, testing, and a pre-submission checklist.

## Design Principles

**SOLID:**
- **S**ingle Responsibility: Parser, Runtime, Expressions, Resume, Graph — each does one thing
- **O**pen/Closed: New step types extend `StepType` union; runtime uses a dispatch map
- **L**iskov Substitution: All steps satisfy the `Step` interface; any adapter satisfies `OpenClawAdapter`
- **I**nterface Segregation: `SpawnConfig`, `GateConfig`, `RetryConfig` — separate, focused interfaces
- **D**ependency Inversion: Runtime depends on `OpenClawAdapter` abstraction, not HTTP calls

**DRY:**
- `retry:` is a reusable wrapper on any step type
- `resolveRef()` / `interpolate()` used everywhere for data flow
- `createSemaphore()` shared by parallel and loop

**KISS:**
- YAML in, JSON out. No intermediate DSLs.
- One CLI command per action: `run`, `resume`, `validate`, `viz`
- Self-contained resume tokens (no external state directory)

## License

MIT
