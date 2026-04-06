# Testing Pipelines

Squid has built-in testing support. No OpenClaw instance needed — everything is mockable.

## TestRunner

```typescript
import { createTestRunner } from "squid/testing";
import { parseFile } from "squid";

const pipeline = parseFile("my-pipeline.yaml");

const result = await createTestRunner()
  .mockSpawn("research", { output: { findings: ["a", "b"] } })
  .approveGate("review")
  .withArgs({ env: "test" })
  .run(pipeline);

// Assertions
expect(result.status).toBe("completed");
result.assertStepCompleted("research");
result.assertStepCompleted("deploy");
```

## API Reference

### `createTestRunner()`

Creates a new TestRunner instance.

### `.mockSpawn(stepId, result)`

Mock a spawn step's output. When the pipeline reaches this step, it returns the mock result instead of calling OpenClaw.

```typescript
runner.mockSpawn("analyze", {
  output: { score: 95, issues: [] },
});
```

### `.mockSpawnHandler(stepId, handler)`

Provide a dynamic handler for spawn steps:

```typescript
runner.mockSpawnHandler("analyze", async (config, ctx) => {
  // Access the spawn config and pipeline context
  return {
    status: "accepted",
    childSessionKey: "mock-123",
    output: { analyzed: true, task: config.task },
  };
});
```

### `.approveGate(stepId)` / `.rejectGate(stepId)`

Auto-approve or reject a gate step:

```typescript
runner.approveGate("deploy-gate");
runner.rejectGate("dangerous-gate");
```

### `.overrideStep(stepId, result)`

Override any step's result entirely:

```typescript
runner.overrideStep("external-api", {
  status: "completed",
  output: { data: "mocked" },
});
```

### `.withArgs(args)` / `.withEnv(env)`

Set pipeline arguments and environment:

```typescript
runner
  .withArgs({ env: "test", image: "test:latest" })
  .withEnv({ API_KEY: "test-key" });
```

### `.run(pipeline)`

Execute the pipeline in test mode. Returns a `TestResult`:

```typescript
const result = await runner.run(pipeline);
```

## TestResult

Extends `RunResult` with test utilities:

```typescript
interface TestResult extends RunResult {
  capturedSteps: Array<{ step: Step; result: StepResult }>;
  getStepResult(stepId: string): StepResult | undefined;
  assertStepCompleted(stepId: string): void;
  assertStepSkipped(stepId: string): void;
}
```

### `result.status`

Overall pipeline status: `"completed" | "failed" | "halted" | "cancelled"`.

### `result.capturedSteps`

Array of all steps that executed, in order:

```typescript
expect(result.capturedSteps).toHaveLength(5);
expect(result.capturedSteps.map(c => c.step.id)).toEqual([
  "build", "test", "review", "deploy", "verify"
]);
```

### `result.getStepResult(stepId)`

Get a specific step's result:

```typescript
const buildResult = result.getStepResult("build");
expect(buildResult?.stdout).toContain("Build successful");
expect(buildResult?.output).toEqual({ success: true });
```

### `result.assertStepCompleted(stepId)` / `result.assertStepSkipped(stepId)`

Convenience assertions that throw on failure:

```typescript
result.assertStepCompleted("deploy");  // throws if not completed
result.assertStepSkipped("rollback");  // throws if not skipped
```

## Example: Testing a Deploy Pipeline

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
    result.assertStepCompleted("build");
    result.assertStepCompleted("test");
    result.assertStepCompleted("deploy");
  });

  it("skips deploy when rejected", async () => {
    const result = await createTestRunner()
      .rejectGate("approve")
      .withArgs({ env: "staging", image: "app:v2" })
      .run(pipeline);

    expect(result.status).toBe("completed");
    result.assertStepSkipped("deploy");
  });

  it("uses AI review output in deploy", async () => {
    const result = await createTestRunner()
      .mockSpawn("reviewer", {
        output: { score: 9, summary: "Looks good" },
      })
      .approveGate("approve")
      .withArgs({ env: "staging", image: "app:v2" })
      .run(pipeline);

    const reviewResult = result.getStepResult("reviewer");
    expect(reviewResult?.output).toEqual({
      score: 9,
      summary: "Looks good",
    });
  });
});
```

## Example: Testing Conditional Branches

```typescript
it("takes error path when tests fail", async () => {
  const result = await createTestRunner()
    .overrideStep("test", {
      status: "completed",
      output: { failures: 3, coverage: 60 },
    })
    .run(pipeline);

  result.assertStepCompleted("fix-bugs");
  result.assertStepSkipped("deploy");
});
```

## Execution Modes

| Mode | Behavior |
|------|----------|
| `run` | Real execution — commands run, OpenClaw spawns |
| `dry-run` | Shows what would execute, no side effects |
| `test` | Mock adapters, auto-approve gates (unless overridden) |

The TestRunner always uses `test` mode. You can also use `--test` from the CLI:

```bash
squid run pipeline.yaml --test
```

## Tips

1. **Test the happy path first** — mock all spawns, approve all gates
2. **Test rejection paths** — reject gates and verify conditional skips
3. **Test error handling** — override steps with failures, check branch routing
4. **Keep mocks minimal** — only mock what the subsequent steps actually reference
5. **Use `capturedSteps`** to verify execution order
