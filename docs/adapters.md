# Agent Adapters

Squid's `spawn` steps are powered by **pluggable agent adapters**. An adapter is a small interface that knows how to invoke an AI agent runtime and wait for its response. You can use different adapters for different steps in the same pipeline.

## How It Works

```
Pipeline YAML              Runtime                    Agent Runtime
─────────────             ─────────                  ──────────────
spawn:                    ┌─────────┐
  agent: claude-code  ──> │ Adapter │ ──> claude -p "task"
  task: "..."             │ Registry│
                          └─────────┘
spawn:                    ┌─────────┐
  agent: openclaw     ──> │ Adapter │ ──> sessions_spawn API
  task: "..."             │ Registry│
                          └─────────┘
spawn:                    ┌─────────┐
  agent: opencode     ──> │ Adapter │ ──> opencode run --message "task"
  task: "..."             │ Registry│
                          └─────────┘
```

### Resolution order

When a `spawn` step executes, the adapter is resolved in this order:

1. **`step.agent`** — the `agent:` field on the spawn config
2. **`pipeline.agent`** — the `agent:` field on the pipeline root
3. **`SQUID_AGENT`** — environment variable
4. **`openclaw`** — default fallback

---

## OpenClaw Adapter

The default adapter. Invokes OpenClaw's `sessions_spawn` tool via the CLI to create child agent sessions.

### Setup

```bash
# Requires: openclaw CLI installed and authenticated
brew install openclaw   # or your preferred install method
openclaw config         # authenticate

# Optional: pass auth token to the CLI subprocess
export OPENCLAW_TOKEN=your-api-token
```

Squid runs `openclaw agent --agent <id> --message "..."` as a subprocess. The CLI handles gateway communication internally — Squid never makes HTTP calls to OpenClaw directly.

### YAML usage

```yaml
name: my-pipeline
agent: openclaw                    # explicit (also the default)

steps:
  - id: analyze
    type: spawn
    spawn:
      task: "Analyze the codebase for security issues"
      agentId: security-reviewer   # target a specific agent
      model: claude-sonnet-4-6     # model override
      thinking: high               # off | low | high
      runtime: subagent            # subagent | acp
      mode: run                    # run (ephemeral) | session (persistent)
      sandbox: inherit             # inherit | require
      timeout: 300
      attachments:                 # attach files to the agent
        - name: spec.md
          content: "..."
```

### OpenClaw-specific features

These options are only available with the `openclaw` adapter:

| Option | Description |
|--------|-------------|
| `agentId` | Target a configured agent by ID |
| `runtime` | `subagent` (in-process) or `acp` (external control plane) |
| `mode` | `run` (ephemeral) or `session` (persistent, reusable) |
| `sandbox` | `inherit` parent sandbox or `require` one |
| `attachments` | Attach files to the spawned session |

### Authentication

The `openclaw` CLI uses credentials stored by `openclaw config` (in `~/.openclaw/config.json` under `gateway.auth.token`). No environment variables are needed — Squid does not pass any auth tokens to the subprocess.

### How it works under the hood

1. Builds a `sessions_spawn` instruction from the spawn config (task, runtime, mode, etc.)
2. Runs `openclaw agent --agent <agentId> --json --timeout <N> --message "instruction"` as a subprocess
3. The `openclaw` CLI handles gateway communication internally (HTTP, auth, polling)
4. Captures stdout and parses JSON output (supports raw JSON, markdown-fenced JSON, and embedded JSON in prose)
5. Extracts session key from output if present

---

## Claude Code Adapter

Spawns agents via the **Claude Code CLI** (`claude`). Each spawn step becomes a `claude -p "task"` invocation.

### Setup

```bash
# Install Claude Code
# See: https://docs.anthropic.com/en/docs/claude-code

# Verify it works
claude --version

# Optional: set a default model
export CLAUDE_MODEL=claude-sonnet-4-6
```

### YAML usage

```yaml
name: my-pipeline
agent: claude-code

steps:
  - id: analyze
    type: spawn
    spawn:
      task: |
        Analyze the codebase for security vulnerabilities.
        Output JSON: { "issues": [...], "score": number }
      model: claude-sonnet-4-6    # optional model override
      timeout: 300                # seconds
      cwd: /path/to/project       # working directory for the agent
```

### How it works

1. Runs `claude -p 'task text' --output-format json` as a subprocess
2. The agent runs in the specified `cwd` (or inherits from pipeline)
3. Stdout is captured; if valid JSON, it's parsed as the step output
4. The call is **synchronous** — the step waits for Claude Code to finish

### Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_MODEL` | Default model (e.g., `claude-sonnet-4-6`, `claude-opus-4-6`) |

### What works / what doesn't

| Feature | Supported |
|---------|-----------|
| Task prompt | Yes — passed as `-p` argument |
| Model override | Yes — `model:` or `CLAUDE_MODEL` env |
| Working directory | Yes — `cwd:` |
| Timeout | Yes — subprocess timeout |
| Attachments | Not yet — Claude Code reads files from `cwd` instead |
| Agent ID | Yes — `agentId:` passed as `--agent <name>` (agents defined in `.claude/agents/`) |
| Runtime/mode/sandbox | Not applicable — OpenClaw-specific |

### Example: Full pipeline with Claude Code

```yaml
name: code-review
agent: claude-code

args:
  repo: { required: true }

steps:
  - id: scan
    type: run
    run: find ${args.repo} -name "*.ts" | head -20 | xargs wc -l

  - id: review
    type: spawn
    spawn:
      task: |
        Review the TypeScript codebase at ${args.repo}.
        Focus on: security, performance, code quality.
        Output JSON: { "score": number, "issues": [...], "summary": string }
      model: claude-sonnet-4-6
      cwd: ${args.repo}
      timeout: 300

  - id: approve
    type: gate
    gate:
      prompt: "Code review score: ${review.json.score}/100. Approve?"
      preview: $review.json
```

---

## OpenCode Adapter

Spawns agents via the **OpenCode CLI** (`opencode`). Each spawn step becomes an `opencode run --message "task"` invocation.

### Setup

```bash
# Install OpenCode
# See: https://opencode.ai

# Verify it works
opencode --version

# Optional: set a default model
export OPENCODE_MODEL=claude-sonnet-4-6
```

### YAML usage

```yaml
name: my-pipeline
agent: opencode

steps:
  - id: implement
    type: spawn
    spawn:
      task: |
        Implement a rate limiter middleware.
        Output JSON: { "files": [...], "description": string }
      model: claude-sonnet-4-6
      timeout: 300
      cwd: /path/to/project
```

### How it works

1. Runs `opencode run --message 'task text'` as a subprocess
2. The agent runs in the specified `cwd` (or inherits from pipeline)
3. Stdout is captured; if valid JSON, it's parsed as the step output
4. The call is **synchronous** — the step waits for OpenCode to finish

### Environment variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_MODEL` | Default model override |

### What works / what doesn't

| Feature | Supported |
|---------|-----------|
| Task prompt | Yes — passed as `--message` argument |
| Model override | Yes — `model:` or `OPENCODE_MODEL` env |
| Working directory | Yes — `cwd:` |
| Timeout | Yes — subprocess timeout |
| Attachments | Not yet |
| Agent ID | Not applicable |

---

## Mixing Adapters in One Pipeline

You can use different adapters for different steps. This is powerful for orchestrating heterogeneous agent systems.

```yaml
name: multi-runtime-pipeline
agent: claude-code                  # default for most steps

steps:
  # Step 1: Claude Code plans the work
  - id: plan
    type: spawn
    spawn:
      task: "Create an implementation plan for: ${args.feature}"
      thinking: high
      # → uses claude-code (default)

  # Step 2: OpenCode implements (different codebase conventions)
  - id: implement
    type: spawn
    spawn:
      agent: opencode               # override
      task: "Implement: ${plan.json}"
      cwd: ${args.repo}

  # Step 3: OpenClaw reviews via a specialized agent
  - id: review
    type: spawn
    spawn:
      agent: openclaw               # override
      task: "Review the implementation"
      agentId: code-reviewer        # target a named agent (works with both openclaw and claude-code)
      thinking: high

  # Step 4: Back to Claude Code for docs
  - id: docs
    type: spawn
    spawn:
      task: "Document: ${args.feature}"
      # → uses claude-code (default)
```

---

## Custom Adapters

Implement the `AgentAdapter` interface to plug in any agent system.

### Interface

```typescript
interface AgentAdapter {
  name: string;                     // unique name for YAML reference
  spawn(
    config: SpawnConfig,
    ctx: PipelineContext
  ): Promise<SpawnResult>;
  waitForCompletion(
    childSessionKey: string,
    timeoutMs?: number
  ): Promise<StepResult>;
  getSessionStatus(
    sessionKey: string
  ): Promise<StepStatus>;
}
```

### Example: HTTP API adapter

```typescript
import { registerAdapter } from "squid";
import type { AgentAdapter } from "squid";

const myAdapter: AgentAdapter = {
  name: "my-llm-service",

  async spawn(config, ctx) {
    const response = await fetch("https://my-llm-service.com/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: config.task, model: config.model }),
    });
    const data = await response.json();
    return {
      status: "accepted",
      output: data.result,
    };
  },

  async waitForCompletion() {
    // Synchronous API — spawn already returned the result
    return { stepId: "", status: "completed", output: {} };
  },

  async getSessionStatus() {
    return "completed";
  },
};

registerAdapter(myAdapter);
```

### Example: Subprocess adapter

```typescript
import { execSync } from "node:child_process";
import { registerAdapter } from "squid";

registerAdapter({
  name: "aider",

  async spawn(config, ctx) {
    const stdout = execSync(
      `aider --message '${config.task}' --yes`,
      { encoding: "utf-8", cwd: config.cwd ?? ctx.cwd }
    );
    return { status: "accepted", output: stdout.trim() };
  },

  async waitForCompletion() {
    return { stepId: "", status: "completed", output: {} };
  },

  async getSessionStatus() {
    return "completed";
  },
});
```

Then use in YAML:

```yaml
name: aider-pipeline
agent: aider

steps:
  - id: fix
    type: spawn
    spawn:
      task: "Fix the failing test in src/auth.ts"
      cwd: /path/to/repo
```

### Registering at startup

If using the CLI, register adapters in a setup script:

```typescript
// squid-setup.ts
import { setupBuiltinAdapters, registerAdapter } from "squid";

// Register built-in adapters (openclaw, claude-code, opencode)
setupBuiltinAdapters();

// Register your custom adapters
registerAdapter(myAdapter);
```

For programmatic usage:

```typescript
import { setupBuiltinAdapters, registerAdapter, runPipeline, parseFile } from "squid";

setupBuiltinAdapters();
registerAdapter(myCustomAdapter);

const pipeline = parseFile("pipeline.yaml");
const result = await runPipeline(pipeline);
```

---

## Testing with Adapters

The `TestRunner` mocks **all adapters uniformly** — `mockSpawn()` intercepts spawn steps regardless of which adapter they target. No agent runtime needed for tests.

```typescript
import { createTestRunner } from "squid/testing";
import { parseFile } from "squid";

const pipeline = parseFile("multi-runtime.yaml"); // uses claude-code + openclaw

const result = await createTestRunner()
  .mockSpawn("plan", { output: { steps: ["a", "b"] } })     // mocks claude-code spawn
  .mockSpawn("review", { output: { score: 95 } })           // mocks openclaw spawn
  .approveGate("deploy")
  .run(pipeline);

result.assertStepCompleted("plan");
result.assertStepCompleted("review");
```

The test mode intercepts at the hook level, **before** adapter resolution. This means:
- You don't need any CLI tools installed
- You don't need any API tokens or URLs configured
- `mockSpawn("stepId", ...)` works the same for all adapters
- Tests are fast (no subprocess or HTTP calls)

---

## Adapter Comparison

| Feature | OpenClaw | Claude Code | OpenCode | Custom |
|---------|----------|-------------|----------|--------|
| **Invocation** | CLI subprocess | CLI subprocess | CLI subprocess | Your code |
| **Agent ID** | Yes (`--agent`) | Yes (`--agent`) | No | Your choice |
| **Model override** | Via agent config | Yes (`--model`) | Yes (`--model`) | Your choice |
| **Thinking level** | Yes (`--thinking`) | No | No | Your choice |
| **Attachments** | Yes | No | No | Your choice |
| **Sessions** | Yes (persistent) | No | No | Your choice |
| **Sandbox** | Yes | No | No | Your choice |
| **Install** | `openclaw` CLI | `claude` CLI | `opencode` CLI | N/A |
| **Auth** | `openclaw config` | Claude Code auth | OpenCode auth | Your choice |
