import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineContext } from "../src/core/types.js";

// Mock execSync before importing the adapter
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { createClaudeCodeAdapter } from "../src/core/adapters/claude-code.js";

const mockExec = vi.mocked(execSync);

function mockCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pipelineId: "test", runId: "r1", args: {}, env: {},
    cwd: "/workspace", results: new Map(), state: new Map(),
    mode: "run", hooks: {},
    ...overrides,
  };
}

describe("claude-code adapter", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("has name 'claude-code'", () => {
    const adapter = createClaudeCodeAdapter();
    expect(adapter.name).toBe("claude-code");
  });

  it("spawns via claude CLI with correct args", async () => {
    mockExec.mockReturnValue('{"result": "done"}' as any);
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn(
      { task: "Analyze code" },
      mockCtx()
    );

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ result: "done" });

    // Verify the CLI command
    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("Analyze code");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("json");
  });

  it("passes model flag when specified", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn(
      { task: "test", model: "claude-opus-4-6" },
      mockCtx()
    );

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-opus-4-6");
  });

  it("uses defaultModel from config", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createClaudeCodeAdapter({ defaultModel: "claude-haiku-4-5" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-haiku-4-5");
  });

  it("step model overrides defaultModel", async () => {
    mockExec.mockReturnValue("output" as any);
    const adapter = createClaudeCodeAdapter({ defaultModel: "claude-haiku-4-5" });

    await adapter.spawn(
      { task: "test", model: "claude-opus-4-6" },
      mockCtx()
    );

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("claude-opus-4-6");
    expect(cmd).not.toContain("claude-haiku-4-5");
  });

  it("uses custom bin path", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter({ bin: "/usr/local/bin/claude-dev" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toMatch(/^\/usr\/local\/bin\/claude-dev/);
  });

  it("uses spawn cwd over context cwd", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn(
      { task: "test", cwd: "/project" },
      mockCtx({ cwd: "/default" })
    );

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.cwd).toBe("/project");
  });

  it("falls back to context cwd", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx({ cwd: "/fallback" }));

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.cwd).toBe("/fallback");
  });

  it("sets timeout from spawn config", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test", timeout: 60 }, mockCtx());

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.timeout).toBe(60_000);
  });

  it("defaults timeout to 600s", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx());

    const opts = mockExec.mock.calls[0][1] as any;
    expect(opts.timeout).toBe(600_000);
  });

  it("returns string output when not valid JSON", async () => {
    mockExec.mockReturnValue("plain text output" as any);
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toBe("plain text output");
  });

  it("parses JSON output", async () => {
    mockExec.mockReturnValue('{"score": 95, "issues": []}' as any);
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toEqual({ score: 95, issues: [] });
  });

  it("returns error on CLI failure", async () => {
    mockExec.mockImplementation(() => {
      throw new Error("command not found: claude");
    });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("command not found");
  });

  it("returns error with message from thrown error", async () => {
    mockExec.mockImplementation(() => {
      throw new Error("claude crashed unexpectedly");
    });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toBe("claude crashed unexpectedly");
  });

  it("escapes single quotes in task", async () => {
    mockExec.mockReturnValue("ok" as any);
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "it's a test" }, mockCtx());

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("it'\\''s a test");
  });

  it("waitForCompletion returns completed (sync adapter)", async () => {
    const adapter = createClaudeCodeAdapter();
    const result = await adapter.waitForCompletion("any-key");
    expect(result.status).toBe("completed");
  });

  it("getSessionStatus returns completed (sync adapter)", async () => {
    const adapter = createClaudeCodeAdapter();
    const status = await adapter.getSessionStatus("any-key");
    expect(status).toBe("completed");
  });
});
