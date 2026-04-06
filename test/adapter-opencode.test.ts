import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineContext } from "../src/core/types.js";

vi.mock("../src/core/async-exec.js", () => ({
  execAsync: vi.fn(),
  shellEscape: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
}));

import { execAsync } from "../src/core/async-exec.js";
import { createOpenCodeAdapter } from "../src/core/adapters/opencode.js";

const mockExec = vi.mocked(execAsync);

function mockCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pipelineId: "test", runId: "r1", args: {}, env: {},
    cwd: "/workspace", results: new Map(), state: new Map(),
    mode: "run", hooks: {}, events: { emit() {}, on() {}, off() {} },
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
    mockExec.mockResolvedValue({ stdout: '{"result": "done"}', stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "Fix the bug" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ result: "done" });

    const [bin, args] = mockExec.mock.calls[0];
    expect(bin).toBe("opencode");
    expect(args).toContain("run");
    expect(args).toContain("--message");
    expect(args).toContain("Fix the bug");
  });

  it("passes model flag when specified", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test", model: "gpt-4o" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4o");
  });

  it("uses defaultModel from config", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter({ defaultModel: "claude-sonnet-4-6" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  it("step model overrides defaultModel", async () => {
    mockExec.mockResolvedValue({ stdout: "output", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter({ defaultModel: "default-model" });

    await adapter.spawn({ task: "test", model: "override-model" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("override-model");
    expect(args).not.toContain("default-model");
  });

  it("uses custom bin path", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter({ bin: "/opt/opencode" });

    await adapter.spawn({ task: "test" }, mockCtx());

    const bin = mockExec.mock.calls[0][0];
    expect(bin).toBe("/opt/opencode");
  });

  it("uses spawn cwd over context cwd", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test", cwd: "/project" }, mockCtx({ cwd: "/default" }));

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.cwd).toBe("/project");
  });

  it("falls back to context cwd", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test" }, mockCtx({ cwd: "/fallback" }));

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.cwd).toBe("/fallback");
  });

  it("sets timeout from spawn config", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    await adapter.spawn({ task: "test", timeout: 120 }, mockCtx());

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.timeoutMs).toBe(120_000);
  });

  it("returns string output when not valid JSON", async () => {
    mockExec.mockResolvedValue({ stdout: "plain text", stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toBe("plain text");
  });

  it("parses JSON output", async () => {
    mockExec.mockResolvedValue({ stdout: '{"files": ["a.ts"]}', stderr: "", exitCode: 0 });
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toEqual({ files: ["a.ts"] });
  });

  it("returns error on CLI failure", async () => {
    mockExec.mockRejectedValue(new Error("opencode: not found"));
    const adapter = createOpenCodeAdapter();

    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("not found");
  });

  it("waitForCompletion returns completed", async () => {
    const adapter = createOpenCodeAdapter();
    const result = await adapter.waitForCompletion("any");
    expect(result.status).toBe("completed");
  });

  it("getSessionStatus returns completed", async () => {
    const adapter = createOpenCodeAdapter();
    const status = await adapter.getSessionStatus("any");
    expect(status).toBe("completed");
  });
});
