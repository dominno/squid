import { describe, it, expect } from "vitest";
import { resolveRef, interpolate, evaluateCondition } from "../src/core/expressions.js";
import type { PipelineContext, StepResult } from "../src/core/types.js";

function createContext(
  overrides: Partial<PipelineContext> = {}
): PipelineContext {
  return {
    pipelineId: "test",
    runId: "run-1",
    args: { env: "staging", count: 5 },
    env: { NODE_ENV: "test", API_KEY: "secret" },
    cwd: "/tmp",
    results: new Map(),
    state: new Map(),
    mode: "test",
    hooks: {},
    ...overrides,
  };
}

function addResult(ctx: PipelineContext, id: string, result: Partial<StepResult>) {
  ctx.results.set(id, {
    stepId: id,
    status: "completed",
    ...result,
  });
}

describe("resolveRef", () => {
  it("returns literal strings unchanged", () => {
    const ctx = createContext();
    expect(resolveRef("hello", ctx)).toBe("hello");
  });

  it("resolves $args.key", () => {
    const ctx = createContext();
    expect(resolveRef("$args.env", ctx)).toBe("staging");
    expect(resolveRef("$args.count", ctx)).toBe(5);
  });

  it("resolves $env.VAR", () => {
    const ctx = createContext();
    expect(resolveRef("$env.NODE_ENV", ctx)).toBe("test");
  });

  it("resolves $stepId.json", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { data: [1, 2, 3] } });
    expect(resolveRef("$fetch.json", ctx)).toEqual({ data: [1, 2, 3] });
  });

  it("resolves $stepId.json.nested.path", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", {
      output: { data: { items: ["a", "b"] } },
    });
    expect(resolveRef("$fetch.json.data.items", ctx)).toEqual(["a", "b"]);
  });

  it("resolves $stepId.stdout", () => {
    const ctx = createContext();
    addResult(ctx, "cmd", { stdout: "hello world" });
    expect(resolveRef("$cmd.stdout", ctx)).toBe("hello world");
  });

  it("resolves $stepId.status", () => {
    const ctx = createContext();
    addResult(ctx, "cmd", { status: "completed" });
    expect(resolveRef("$cmd.status", ctx)).toBe("completed");
  });

  it("resolves $stepId.approved for completed gate", () => {
    const ctx = createContext();
    addResult(ctx, "gate", {
      status: "completed",
      meta: { approved: true },
    });
    expect(resolveRef("$gate.approved", ctx)).toBe(true);
  });

  it("resolves $stepId.skipped", () => {
    const ctx = createContext();
    addResult(ctx, "gate", { status: "skipped" });
    expect(resolveRef("$gate.skipped", ctx)).toBe(true);
  });

  it("resolves $stepId.error", () => {
    const ctx = createContext();
    addResult(ctx, "cmd", {
      status: "failed",
      error: { message: "boom" },
    });
    expect(resolveRef("$cmd.error", ctx)).toBe("boom");
  });

  it("resolves $item and $index in loop context", () => {
    const ctx = createContext();
    ctx.state.set("__loop_item", { name: "test" });
    ctx.state.set("__loop_index", 2);
    expect(resolveRef("$item", ctx)).toEqual({ name: "test" });
    expect(resolveRef("$item.name", ctx)).toBe("test");
    expect(resolveRef("$index", ctx)).toBe(2);
  });

  it("resolves $state.key", () => {
    const ctx = createContext();
    ctx.state.set("counter", 42);
    expect(resolveRef("$state.counter", ctx)).toBe(42);
  });

  it("returns undefined for missing step", () => {
    const ctx = createContext();
    expect(resolveRef("$missing.json", ctx)).toBeUndefined();
  });

  it("returns undefined for missing nested path", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { a: 1 } });
    expect(resolveRef("$fetch.json.b.c", ctx)).toBeUndefined();
  });
});

describe("interpolate", () => {
  it("interpolates ${args.key}", () => {
    const ctx = createContext();
    expect(interpolate("Deploy to ${args.env}", ctx)).toBe(
      "Deploy to staging"
    );
  });

  it("interpolates ${stepId.json.field}", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { url: "https://example.com" } });
    expect(interpolate("URL: ${fetch.json.url}", ctx)).toBe(
      "URL: https://example.com"
    );
  });

  it("handles missing refs as empty string", () => {
    const ctx = createContext();
    expect(interpolate("${missing.json}", ctx)).toBe("");
  });

  it("handles multiple interpolations", () => {
    const ctx = createContext();
    expect(interpolate("${args.env}-${args.count}", ctx)).toBe("staging-5");
  });

  it("leaves non-template strings unchanged", () => {
    const ctx = createContext();
    expect(interpolate("no templates here", ctx)).toBe("no templates here");
  });
});

describe("evaluateCondition", () => {
  it("evaluates literal true/false", () => {
    const ctx = createContext();
    expect(evaluateCondition("true", ctx)).toBe(true);
    expect(evaluateCondition("false", ctx)).toBe(false);
  });

  it("evaluates truthy reference", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { ready: true } });
    expect(evaluateCondition("$fetch.json.ready", ctx)).toBe(true);
  });

  it("evaluates falsy reference", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { ready: false } });
    expect(evaluateCondition("$fetch.json.ready", ctx)).toBe(false);
  });

  it("evaluates equality", () => {
    const ctx = createContext();
    addResult(ctx, "cmd", { output: { status: "ok" } });
    expect(evaluateCondition('$cmd.json.status == "ok"', ctx)).toBe(true);
    expect(evaluateCondition('$cmd.json.status == "fail"', ctx)).toBe(false);
  });

  it("evaluates inequality", () => {
    const ctx = createContext();
    addResult(ctx, "cmd", { output: { status: "ok" } });
    expect(evaluateCondition('$cmd.json.status != "fail"', ctx)).toBe(true);
  });

  it("evaluates numeric comparison", () => {
    const ctx = createContext();
    expect(evaluateCondition("$args.count > 3", ctx)).toBe(true);
    expect(evaluateCondition("$args.count < 3", ctx)).toBe(false);
    expect(evaluateCondition("$args.count >= 5", ctx)).toBe(true);
    expect(evaluateCondition("$args.count <= 5", ctx)).toBe(true);
  });

  it("evaluates negation", () => {
    const ctx = createContext();
    addResult(ctx, "gate", { status: "skipped" });
    expect(evaluateCondition("!$gate.skipped", ctx)).toBe(false);
    expect(evaluateCondition("!$gate.approved", ctx)).toBe(true);
  });

  it("evaluates AND", () => {
    const ctx = createContext();
    addResult(ctx, "a", { output: { ready: true } });
    addResult(ctx, "b", { output: { ready: true } });
    expect(evaluateCondition("$a.json.ready && $b.json.ready", ctx)).toBe(true);
  });

  it("evaluates OR", () => {
    const ctx = createContext();
    addResult(ctx, "a", { output: { ready: true } });
    addResult(ctx, "b", { output: { ready: false } });
    expect(evaluateCondition("$a.json.ready || $b.json.ready", ctx)).toBe(true);
  });

  it("evaluates $step.approved", () => {
    const ctx = createContext();
    addResult(ctx, "gate", {
      status: "completed",
      meta: { approved: true },
    });
    expect(evaluateCondition("$gate.approved", ctx)).toBe(true);
  });

  it("returns false for undefined references", () => {
    const ctx = createContext();
    expect(evaluateCondition("$missing.json", ctx)).toBe(false);
  });

  it("handles empty arrays as falsy", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { items: [] } });
    expect(evaluateCondition("$fetch.json.items", ctx)).toBe(false);
  });

  it("handles non-empty arrays as truthy", () => {
    const ctx = createContext();
    addResult(ctx, "fetch", { output: { items: [1] } });
    expect(evaluateCondition("$fetch.json.items", ctx)).toBe(true);
  });

  it("evaluates comparison with ${...} interpolation on the right side", () => {
    const ctx = createContext({ args: { threshold: "75" } });
    addResult(ctx, "review", { output: { score: 60 } });
    expect(evaluateCondition("$review.json.score < ${args.threshold}", ctx)).toBe(true);
  });

  it("evaluates comparison with ${...} interpolation when score meets threshold", () => {
    const ctx = createContext({ args: { threshold: "75" } });
    addResult(ctx, "review", { output: { score: 90 } });
    expect(evaluateCondition("$review.json.score < ${args.threshold}", ctx)).toBe(false);
  });

  it("evaluates >= comparison with ${...} on the right", () => {
    const ctx = createContext({ args: { min: "10" } });
    addResult(ctx, "step", { output: { count: 15 } });
    expect(evaluateCondition("$step.json.count >= ${args.min}", ctx)).toBe(true);
  });

  it("evaluates comparison with ${...} on the left side", () => {
    const ctx = createContext({ args: { limit: "100" } });
    addResult(ctx, "step", { output: { count: 50 } });
    expect(evaluateCondition("${args.limit} > $step.json.count", ctx)).toBe(true);
  });

  it("evaluates comparison with ${...} on both sides", () => {
    const ctx = createContext({ args: { a: "10", b: "20" } });
    expect(evaluateCondition("${args.a} < ${args.b}", ctx)).toBe(true);
    expect(evaluateCondition("${args.b} < ${args.a}", ctx)).toBe(false);
  });
});
