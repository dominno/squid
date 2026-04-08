# Testing Pipelines

Squid has two testing approaches — no agent runtime needed for either.

1. **YAML Tests** — write `.test.yaml` files alongside your pipelines, run with `squid test`
2. **TypeScript Tests** — use the `TestRunner` API with vitest/jest

---

## YAML Tests (recommended)

The simplest way to test pipelines. Write test cases in YAML, mock any step, assert on results.

### Quick start

Create `deploy.test.yaml` next to `deploy.yaml`:

```yaml
pipeline: ./deploy.yaml

tests:
  - name: "deploys when approved"
    mode: sandbox
    args:
      env: staging
      image: app:v2
    mocks:
      run:
        build: { output: { built: true } }
        test: { output: { passed: true } }
      spawn:
        reviewer: { output: { score: 95 } }
    gates:
      approve: true
    assert:
      status: completed
      steps:
        deploy: completed

  - name: "skips deploy when rejected"
    mode: sandbox
    gates:
      approve: false
    assert:
      steps:
        deploy: skipped
```

Run:

```bash
squid test                         # auto-discovers all *.test.yaml
squid test deploy.test.yaml        # specific file
```

Output:

```
  deploy.test.yaml
  ✓ deploys when approved (2ms)
  ✓ skips deploy when rejected (1ms)

  1 suite(s), 2 test(s)
  2 passed
```

### Test modes

| Mode | `run` steps | `spawn` steps | `gate` steps | Use case |
|------|------------|---------------|--------------|----------|
| **`sandbox`** | Mocked — nothing executes | Mocked | Mock decisions | Unit testing pipeline logic, conditions, branching, data flow |
| **`integration`** | Execute for real (unless mocked) | Mocked | Mock decisions | Testing actual shell scripts, real commands |

**`sandbox`** is the default. Use it for:
- Testing that conditions route correctly
- Testing that gates block/allow the right steps
- Testing branch/loop/restart logic
- Testing data flow between steps

**`integration`** runs real shell commands. Use it when:
- Your `run` steps have actual scripts you want to verify
- You want to test that `echo` / `jq` / other tools produce correct output
- You can still mock individual `run` steps (e.g., mock `kubectl` but run `jq`)

### Test file format

```yaml
pipeline: ./path/to/pipeline.yaml   # REQUIRED — relative to this test file

tests:                               # REQUIRED — array of test cases
  - name: "test case name"          # REQUIRED — descriptive name
    mode: sandbox                    # sandbox (default) | integration
    args:                            # pipeline arguments
      key: value
    env:                             # environment overrides
      KEY: value
    mocks:                           # mock step outputs
      run:                           # mock run steps
        stepId:
          output: { ... }           # what to return as output
          stdout: "raw text"        # raw stdout (optional)
          status: completed          # completed (default) | failed
          error: "message"          # error message (when status: failed)
      spawn:                         # mock spawn steps
        stepId:
          output: { ... }
          status: accepted           # accepted (default) | error
          error: "message"
    gates:                           # gate decisions
      stepId: true                  # true = approve, false = reject
    assert:                          # REQUIRED — what to check
      status: completed             # pipeline status
      output: { ... }              # pipeline final output
      steps:                        # per-step assertions
        stepId: completed           # step status (shorthand)
```

### Assertion reference

```yaml
assert:
  # Pipeline level
  status: completed                              # completed | failed | halted | cancelled
  output: { key: value }                         # exact match on pipeline output

  # Step level
  steps:
    build: completed                             # status shorthand: completed | failed | skipped
    build: { status: completed }                 # status object form
    build: { output: { image: "app:v2" } }       # exact output match
    build: { outputContains: "app" }             # output contains substring
    build: { outputPath: image, equals: "app:v2" } # nested field check
```

### Mocking run steps

In **sandbox** mode, all `run` steps are mocked automatically (they return `{ command, sandbox: true }`). Add explicit mocks to control what output they return:

```yaml
mocks:
  run:
    build:
      output: { image: "app:v2", tag: "latest" }
    test:
      output: { passed: 42, failed: 0 }
    flaky-step:
      status: failed
      error: "connection timeout"
```

In **integration** mode, `run` steps execute for real **unless** you mock them:

```yaml
mode: integration
mocks:
  run:
    # Mock the dangerous one, let the rest run
    deploy:
      output: { deployed: true }
```

### Mocking spawn steps

Spawn steps are always mocked in both modes (no real agent calls):

```yaml
mocks:
  spawn:
    researcher:
      output: { findings: ["a", "b", "c"] }
    reviewer:
      output: { score: 85, feedback: "looks good" }
    failing-agent:
      status: error
      error: "agent crashed"
```

Unmocked spawn steps return `{ mocked: true }` by default.

### Gate decisions

```yaml
gates:
  approve: true       # approve this gate
  dangerous: false     # reject this gate
```

Unmocked gates are auto-approved by default.

### Example: Testing a multi-agent pipeline

```yaml
pipeline: ./multi-agent-dev.yaml

tests:
  - name: "full happy path"
    mode: sandbox
    args:
      feature: "add auth"
      repo: /workspace
    mocks:
      spawn:
        architect:
          output: { plan: "add JWT", files: ["auth.ts"] }
        backend-coder:
          output: { files: ["src/auth.ts"] }
        frontend-coder:
          output: { files: ["src/Login.tsx"] }
        test-writer:
          output: { files: ["test/auth.test.ts"] }
        reviewer:
          output: { criticalIssues: 0, summary: "LGTM" }
        doc-writer:
          output: { docs: ["API.md"] }
      run:
        run-tests:
          output: { passed: true, coverage: 92 }
        create-pr:
          output: { pr: "#42" }
    gates:
      plan-review: true
      deploy-approval: true
    assert:
      status: completed
      steps:
        architect: completed
        backend-coder: completed
        reviewer: completed
        create-pr: completed

  - name: "plan rejected"
    mode: sandbox
    args:
      feature: "bad idea"
      repo: /workspace
    mocks:
      spawn:
        architect:
          output: { plan: "risky" }
    gates:
      plan-review: false
    assert:
      status: completed
      steps:
        backend-coder: skipped
```

### Example: Integration testing with real scripts

```yaml
pipeline: ./sub-build.yaml

tests:
  - name: "echo commands produce correct output"
    mode: integration
    args:
      target: prod
    assert:
      status: completed
      steps:
        compile:
          outputContains: "app-prod"
        lint: completed
        summary: completed
```

---

## TypeScript Tests

For programmatic testing with vitest, jest, or any test framework.

### TestRunner API

```typescript
import { createTestRunner } from "squid/testing";
import { parseFile } from "squid";

const pipeline = parseFile("my-pipeline.yaml");

const result = await createTestRunner()
  .mockSpawn("research", { output: { findings: ["a", "b"] } })
  .approveGate("review")
  .rejectGate("dangerous-gate")
  .withArgs({ env: "test" })
  .withEnv({ API_KEY: "test-key" })
  .run(pipeline);

expect(result.status).toBe("completed");
result.assertStepCompleted("research");
result.assertStepSkipped("dangerous-action");
```

### API Reference

| Method | Description |
|--------|-------------|
| `mockSpawn(stepId, { output })` | Mock a spawn step's result |
| `mockSpawnHandler(stepId, fn)` | Dynamic handler for spawn mock |
| `approveGate(stepId)` | Auto-approve a gate |
| `rejectGate(stepId)` | Auto-reject a gate |
| `overrideStep(stepId, result)` | Replace any step's result entirely |
| `withArgs(args)` | Set pipeline arguments |
| `withEnv(env)` | Set environment variables |
| `run(pipeline)` | Execute and return `TestResult` |

### TestResult

```typescript
interface TestResult extends RunResult {
  capturedSteps: Array<{ step: Step; result: StepResult }>;
  getStepResult(stepId: string): StepResult | undefined;
  assertStepCompleted(stepId: string): void;   // throws if not completed
  assertStepSkipped(stepId: string): void;      // throws if not skipped
}
```

### Example: vitest test suite

```typescript
import { describe, it, expect } from "vitest";
import { createTestRunner } from "squid/testing";
import { parseFile } from "squid";

const pipeline = parseFile("deploy.yaml");

describe("deploy pipeline", () => {
  it("deploys when approved", async () => {
    const result = await createTestRunner()
      .approveGate("approve")
      .withArgs({ env: "staging", image: "app:v2" })
      .run(pipeline);

    expect(result.status).toBe("completed");
    result.assertStepCompleted("deploy");
  });

  it("skips deploy when rejected", async () => {
    const result = await createTestRunner()
      .rejectGate("approve")
      .withArgs({ env: "staging", image: "app:v2" })
      .run(pipeline);

    result.assertStepSkipped("deploy");
  });

  it("branches on review score", async () => {
    const result = await createTestRunner()
      .mockSpawn("reviewer", { output: { criticalIssues: 3 } })
      .run(pipeline);

    result.assertStepCompleted("fix-bugs");
  });
});
```

---

## Execution Modes

| Mode | `run` steps | `spawn` steps | `gate` steps | Use |
|------|------------|---------------|--------------|-----|
| `run` | Execute | Real agent calls | Halt for approval | Production |
| `dry-run` | Skip (show command) | Skip | Skip | Preview |
| `test` | Execute | Mocked | Auto-approve | Legacy TS tests |
| **`sandbox`** | **Mocked** | **Mocked** | **Mock decisions** | **YAML unit tests** |
| **`integration`** | **Execute (unless mocked)** | **Mocked** | **Mock decisions** | **YAML integration tests** |

---

## End-to-End Tests

E2E tests run pipelines against **real agent CLIs** (Claude Code, OpenClaw, OpenCode). They validate the full round-trip: Squid invokes the CLI, the agent processes the task, output is parsed back into the pipeline.

### Prerequisites

```bash
# Claude Code adapter
claude --version            # must be installed and authenticated

# OpenClaw adapter
openclaw --version          # must be installed
openclaw config             # must be authenticated

# OpenClaw gateway must be running for agent spawns to work:
openclaw status             # check if gateway is running
openclaw gateway run --bind loopback --port 18789  # start if not running
# Or start via the OpenClaw macOS app (menubar icon)

# OpenCode adapter
opencode --version          # must be installed
```

### Running E2E tests

E2E tests are disabled by default. Enable with `SQUID_E2E=1`:

```bash
# Run all e2e tests
SQUID_E2E=1 npx vitest run test/e2e.test.ts

# Run a specific feature
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "parallel"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "code review loop"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "sub-pipeline"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "gate"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "loop"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "error recovery"
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "mixed"

# Run only Claude Code tests (no OpenClaw required)
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "claude-code"

# Run only OpenClaw tests
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "openclaw"
```

Tests auto-skip if the required CLI is not found.

### E2E test coverage

| Test | Pipeline | Feature Tested | Adapters | Timeout |
|------|----------|---------------|----------|---------|
| **Basic spawn** | `e2e-claude-code.yaml` | Single agent spawn + JSON output parsing | Claude Code | 2 min |
| **Data flow** | `e2e-claude-code.yaml` | Output from step A available in step B | Claude Code | 2 min |
| **OpenClaw spawn** | `e2e-openclaw.yaml` | OpenClaw CLI invocation + JSON extraction from payloads envelope | OpenClaw | 3 min |
| **Code review loop** | `e2e-code-review-loop.yaml` | Coder → reviewer → `restart:` loop until score threshold met | Claude Code | 5 min |
| **Restart exhaustion** | `e2e-code-review-loop.yaml` | `maxRestarts` reached → branch routes to "rejected" | Claude Code | 10 min |
| **Parallel agents** | `e2e-parallel-agents.yaml` | `parallel:` branches, `merge: object`, concurrent spawns | Claude Code | 3 min |
| **Sub-pipeline** | `e2e-sub-pipeline.yaml` | `pipeline:` step calls child YAML, arg passing, output propagation | Claude Code | 3 min |
| **Gate + resume** | `e2e-gate-resume.yaml` | Gate auto-approves in `test` mode; halts with resume token in `run` mode | Claude Code | 3 min |
| **Loop over items** | `e2e-loop-items.yaml` | `loop:` iterates list items through agent, `collect` results | Claude Code | 5 min |
| **Error recovery** | `e2e-error-recovery.yaml` | `branch:` on agent confidence, fallback agent on failure | Claude Code | 3 min |
| **Mixed adapters** | `e2e-mixed-adapters.yaml` | Claude Code writes code, OpenClaw reviews it in same pipeline | Claude Code + OpenClaw | 5 min |

### E2E pipeline files

All E2E pipelines are in `skills/squid-pipeline/examples/e2e/`:

```
e2e/
├── e2e-claude-code.yaml          # Basic spawn
├── e2e-openclaw.yaml             # OpenClaw spawn
├── e2e-code-review-loop.yaml     # Restart loop (coder/reviewer)
├── e2e-code-review-loop.test.yaml  # Sandbox test for the loop
├── e2e-parallel-agents.yaml      # Parallel branches + merge
├── e2e-sub-pipeline.yaml         # Parent pipeline
├── e2e-sub-pipeline-child.yaml   # Child pipeline (called by parent)
├── e2e-gate-resume.yaml          # Gate halt + resume
├── e2e-loop-items.yaml           # Loop with agent per item
├── e2e-error-recovery.yaml       # Branch-based error fallback
└── e2e-mixed-adapters.yaml       # Claude Code + OpenClaw in one pipeline
```

Each pipeline can also be run directly with `squid run`:

```bash
# Run a single e2e pipeline manually
squid run skills/squid-pipeline/examples/e2e/e2e-parallel-agents.yaml \
  --args-json '{"topic": "benefits of testing"}' -v

# Dry-run to see what would execute without calling agents
squid run skills/squid-pipeline/examples/e2e/e2e-code-review-loop.yaml --dry-run

# Validate all e2e pipelines
for f in skills/squid-pipeline/examples/e2e/e2e-*.yaml; do
  squid validate "$f"
done
```

### Per-adapter testing

**Claude Code only** (no OpenClaw gateway needed):

```bash
SQUID_E2E=1 npx vitest run test/e2e.test.ts \
  -t "claude-code|code review loop|parallel|sub-pipeline|gate|loop|error recovery"
```

**OpenClaw only** (needs running gateway):

```bash
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "openclaw"
```

**Both adapters** (Claude Code + OpenClaw gateway):

```bash
SQUID_E2E=1 npx vitest run test/e2e.test.ts -t "mixed"
```

### Writing new E2E tests

1. Create a pipeline in `skills/squid-pipeline/examples/e2e/e2e-<feature>.yaml`
2. Validate with `squid validate`
3. Add test case in `test/e2e.test.ts` using `it.skipIf(!shouldRun)`
4. Use `parseFile()` + `runPipeline()` — same API as production
5. Set generous timeouts (agents are slow: 60-300s per spawn)
6. Log outputs with `console.log` for debugging
7. Handle graceful failures (e.g., OpenClaw gateway not running)

```typescript
describe("e2e: my feature", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("does the thing", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-my-feature.yaml"));
    const result = await runPipeline(pipeline, {
      args: { key: "value" },
    });

    console.log("Status:", result.status);
    console.log("Output:", JSON.stringify(result.results.step?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.step?.status).toBe("completed");
  }, 180_000);  // 3 min timeout
});
```

---

## Tips

1. **Start with sandbox mode** — test logic first, then add integration tests for scripts
2. **Test the happy path first** — all spawns succeed, all gates approved
3. **Test rejection paths** — reject gates, verify conditional skips
4. **Test error handling** — mock steps as `status: failed`, verify branch routing
5. **Test restart loops** — mock spawn outputs that improve across iterations
6. **Mock only what's needed** — unmocked run steps return `{ sandbox: true }`, unmocked spawns return `{ mocked: true }`
7. **Keep test files next to pipelines** — `deploy.yaml` + `deploy.test.yaml`
8. **Use integration mode sparingly** — only for testing actual shell commands
9. **Use e2e tests for adapter validation** — run `SQUID_E2E=1` after changing adapters or JSON parsing
