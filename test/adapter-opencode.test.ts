import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineContext } from "../src/core/types.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { createOpenCodeAdapter } from "../src/core/adapters/opencode.js";

const mockExec = vi.mocked(execSync);

function mockCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pipelineId: "test", runId: "r1", args: {}, env: {},
    cwd: "/workspace", results: new Map(), state: new Map(),
    mode: "run", hooks: {},
    ...overrides,
  };
}

describe("opencode adapter", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("has name 'opencode'", () => {
    const adapter = createOpenCodeAdapter();
    expect(adapter.name).toBe("opencode");
  });

  it("spawns via opencode CLI with correct args", async () => {
    mockExec.mockReturnValue('{"result": "done"}' as any);
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn(
      { task: "Fix the bug" },
      mockCtx()
    );

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ result: "done" });

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("opencode");
    expect(cmd).toContain("run");
    expect(cmd).toContain("--message");
    expect(cmd).toContain("Fix the bug");
  });

  it("passes model flag when specified", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createOpenCodeAdapter();

    await adapter.spawn(
      { task: "test", model: "gpt-4o" },
      mockCtx()
    );

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--model");
    expect(cmd).toContain("gpt-4o");
  });

  it("uses defaultModel from config", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createOpenCodeAdapter({ defaultModel: "claude-sonnet-4-6" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-sonnet-4-6");
  });

  it("step model overrides defaultModel", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createOpenCodeAdapter({ defaultModel: "default-model" });

    await adapter.spawn(
      { task: "test", model: "override-model" },
      mockCtx()
    );

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("override-model");
    expect(cmd).not.toContain("default-model");
  });

  it("uses custom bin path", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createOpenCodeAdapter({ bin: "/opt/opencode" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toMatch(/^\/opt\/opencode/);
  });

  it("uses spawn cwd over context cwd", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createOpenCodeAdapter();

    await adapter.spawn(
      { task: "test", cwd: "/project" },
      mockCtx({ cwd: "/default" })
    );

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.cwd).toBe("/project");
  });

  it("falls back to context cwd", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx({ cwd: "/fallback" }));

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.cwd).toBe("/fallback");
  });

  it("sets timeout from spawn config", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test", timeout: 120 }, mockCtx());

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.timeout).toBe(120_000);
  });

  it("returns string output when not valid JSON", async () => {
    mockExec.mockReturnValue("plain text" as any);
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toBe("plain text");
  });

  it("parses JSON output", async () => {
    mockExec.mockReturnValue('{"files": ["a.ts"]}' as any);
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toEqual({ files: ["a.ts"] });
  });

  it("returns error on CLI failure", async () => {
    mockExec.mockImplementation(() => {
      throw new Error("opencode: not found");
    });
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("not found");
  });

  it("escapes single quotes in task", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "don't break" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("don'\\''t break");
  });

  it("waitForCompletion returns completed (sync adapter)", async () => {
    const adapter = createOpenCodeAdapter();
    const result = await adapter.waitForCompletion("any");
    expect(result.status).toBe("completed");
  });

  it("getSessionStatus returns completed (sync adapter)", async () => {
    const adapter = createOpenCodeAdapter();
    const status = await adapter.getSessionStatus("any");
    expect(status).toBe("completed");
  });
});
