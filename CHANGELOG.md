# Changelog

## 0.1.0 — Initial Release

### Core Pipeline Engine
- YAML/JSON pipeline definition with `name`, `args`, `env`, `cwd`, `onError`
- 8 step types: `run`, `spawn`, `gate`, `parallel`, `loop`, `branch`, `transform`, `pipeline`
- Sequential execution with data flow via `$stepId.json`, `$stepId.stdout`, `$args.key`
- Expression engine: comparisons (`==`, `!=`, `>`, `<`, `>=`, `<=`), logic (`&&`, `||`, `!`), interpolation (`${...}`)
- Pipeline-level error strategies: `fail`, `skip`, `continue`

### Agent Adapters (Pluggable Runtimes)
- Built-in adapters: OpenClaw (`sessions_spawn` API + CLI), Claude Code, OpenCode
- Per-pipeline or per-step agent selection via `agent:` field
- Custom adapter registration via `registerAdapter()`
- Environment variable fallback: `SQUID_AGENT`

### Approval Gates
- Simple string shorthand and full config
- Structured input fields: `string`, `number`, `boolean`, `select` with validation (required, regex, options, defaults)
- Caller identity: `requiredApprovers`, `allowSelfApproval`
- 8-character short approval IDs for chat platforms (Telegram, Discord, Slack)
- Resume tokens (self-contained base64url)

### Flow Control
- `parallel:` — fan-out/fan-in with `maxConcurrent`, `failFast`, merge strategies (`object`, `array`, `first`)
- `loop:` — iterate over arrays with `as`, `index`, `maxConcurrent`, `maxIterations`, `collect`
- `branch:` — conditional routing with multiple conditions + default fallback
- `restart:` — jump back to a previous step for iterative refinement loops with `maxRestarts` safety limit

### Sub-Pipeline Composition
- `pipeline:` step type — run another YAML file as a step
- File paths resolve relative to parent pipeline's directory
- Args passed with `$ref` resolution from parent context
- Gate propagation — sub-pipeline gates halt the parent

### Resilience
- `retry:` on any step — `maxAttempts`, `backoff` (fixed, exponential, exponential-jitter), `delayMs`, `maxDelayMs`, `retryOn` patterns
- `timeout:` on any step (seconds)
- Resumable pipelines via encoded resume tokens

### Events / Observability
- `PipelineEventEmitter` with 13 event types
- Pipeline lifecycle: `pipeline:start`, `pipeline:complete`, `pipeline:error`
- Step lifecycle: `step:start`, `step:complete`, `step:error`, `step:skip`, `step:retry`
- Gate lifecycle: `gate:waiting`, `gate:approved`, `gate:rejected`
- Spawn lifecycle: `spawn:start`, `spawn:complete`
- OTel-compatible fields: `traceId`, `spanId`, `parentSpanId`, `timestamp`

### Testing Framework
- YAML test runner: `.test.yaml` files alongside pipelines
- Sandbox mode — nothing executes, all steps mocked
- Integration mode — `run` steps execute, `spawn`/`gate` mocked
- Mocks for `run`, `spawn`, and `gate` steps
- Assertions: pipeline status, step status, output match, `outputContains`, `outputPath`
- TypeScript `TestRunner` API with `mockSpawn`, `approveGate`, `rejectGate`, `overrideStep`
- Auto-discovery: `squid test` finds all `*.test.yaml`

### Parser Validation
- Enum validation for all fields: step type, thinking, runtime, mode, sandbox, backoff, merge, input field type
- Positive number validation for timeout, maxAttempts, maxRestarts, maxIterations
- Required field validation with clear error messages including path
- Duplicate step ID detection (including nested steps)

### Visualization
- `squid viz` — Mermaid diagram output
- Node shapes by step type (diamond for gates, subroutine for spawn, circle for loop)
- Status coloring for completed/failed/running/skipped/waiting steps
- Conditional edge rendering

### CLI
- `squid run` — execute pipeline with `--args-json`, `--dry-run`, `--test`, `--verbose`
- `squid test` — run YAML test files (auto-discovers `*.test.yaml`)
- `squid resume` — resume halted pipeline with approval decision
- `squid validate` — validate pipeline syntax
- `squid viz` — output Mermaid diagram
- `squid dev` — watch mode (dry-run on file change)
- `squid init` — scaffold new pipeline (templates: basic, agent, parallel, full)

### AI Agent Skill
- `skills/squid-pipeline/SKILL.md` — Agent Skills standard format with YAML frontmatter
- Progressive disclosure: SKILL.md (225 lines) + references/ (3 files) + examples/ (13 files)
- 13 example pipelines covering all features
- 2 example test files demonstrating sandbox + integration modes

### Documentation
- Getting started guide
- Step types reference (all 8 types + events + common options)
- Workflow patterns (10 patterns + anti-patterns)
- Testing guide (YAML + TypeScript)
- Agent adapters guide (OpenClaw, Claude Code, OpenCode, custom)
- Lobster migration guide
