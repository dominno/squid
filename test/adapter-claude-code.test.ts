import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineContext } from "../src/core/types.js";

// Mock the async-exec module
vi.mock("../src/core/async-exec.js", () => ({
  execAsync: vi.fn(),
  shellEscape: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
}));

import { execAsync } from "../src/core/async-exec.js";
import { createClaudeCodeAdapter } from "../src/core/adapters/claude-code.js";

const mockExec = vi.mocked(execAsync);

function mockCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pipelineId: "test", runId: "r1", args: {}, env: {},
    cwd: "/workspace", results: new Map(), state: new Map(),
    mode: "run", hooks: {}, events: { emit() {}, on() {}, off() {} },
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
    mockExec.mockResolvedValue({ stdout: '{"result": "done"}', stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "Analyze code" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ result: "done" });

    const [bin, args] = mockExec.mock.calls[0];
    expect(bin).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("Analyze code");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
  });

  it("passes model flag when specified", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test", model: "claude-opus-4-6" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
  });

  it("uses defaultModel from config", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter({ defaultModel: "claude-haiku-4-5" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4-5");
  });

  it("step model overrides defaultModel", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter({ defaultModel: "claude-haiku-4-5" });

    await adapter.spawn({ task: "test", model: "claude-opus-4-6" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("claude-opus-4-6");
    expect(args).not.toContain("claude-haiku-4-5");
  });

  it("uses custom bin path", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter({ bin: "/usr/local/bin/claude-dev" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const bin = mockExec.mock.calls[0][0];
    expect(bin).toBe("/usr/local/bin/claude-dev");
  });

  it("uses spawn cwd over context cwd", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test", cwd: "/project" }, mockCtx({ cwd: "/default" }));

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.cwd).toBe("/project");
  });

  it("falls back to context cwd", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx({ cwd: "/fallback" }));

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.cwd).toBe("/fallback");
  });

  it("sets timeout from spawn config", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test", timeout: 60 }, mockCtx());

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.timeoutMs).toBe(60_000);
  });

  it("defaults timeout to 600s", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx());

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.timeoutMs).toBe(600_000);
  });

  it("returns string output when not valid JSON", async () => {
    mockExec.mockResolvedValue({ stdout: "plain text output", stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toBe("plain text output");
  });

  it("parses JSON output", async () => {
    mockExec.mockResolvedValue({ stdout: '{"score": 95, "issues": []}', stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toEqual({ score: 95, issues: [] });
  });

  it("unwraps Claude Code JSON envelope", async () => {
    // Claude Code --output-format json wraps result in: { "type": "result", "result": "..." }
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"status": "ok", "agent": "claude-code"}',
      session_id: "abc-123",
    });
    mockExec.mockResolvedValue({ stdout: envelope, stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    // Should extract the inner result and parse it as JSON
    expect(result.output).toEqual({ status: "ok", agent: "claude-code" });
  });

  it("unwraps envelope with non-JSON inner result", async () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "Plain text response from agent",
    });
    mockExec.mockResolvedValue({ stdout: envelope, stderr: "", exitCode: 0 });
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toBe("Plain text response from agent");
  });

  it("returns error on CLI failure", async () => {
    mockExec.mockRejectedValue(new Error("command not found: claude"));
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("command not found");
  });

  it("returns error with message from thrown error", async () => {
    mockExec.mockRejectedValue(new Error("claude crashed unexpectedly"));
    const adapter = createClaudeCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toBe("claude crashed unexpectedly");
  });

  it("waitForCompletion returns completed (async adapter)", async () => {
    const adapter = createClaudeCodeAdapter();
    const result = await adapter.waitForCompletion("any-key");
    expect(result.status).toBe("completed");
  });

  it("getSessionStatus returns completed", async () => {
    const adapter = createClaudeCodeAdapter();
    const status = await adapter.getSessionStatus("any-key");
    expect(status).toBe("completed");
  });
});
