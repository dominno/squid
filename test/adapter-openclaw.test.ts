import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PipelineContext } from "../src/core/types.js";

vi.mock("../src/core/async-exec.js", () => ({
  execAsync: vi.fn(),
  shellEscape: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
}));

import { execAsync } from "../src/core/async-exec.js";
import { createOpenClawAdapter } from "../src/core/openclaw-adapter.js";

const mockExec = vi.mocked(execAsync);

function mockCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    pipelineId: "test", runId: "r1", args: {}, env: {},
    cwd: "/workspace", results: new Map(), state: new Map(),
    mode: "run", hooks: {}, events: { emit() {}, on() {}, off() {} },
    ...overrides,
  };
}

describe("openclaw adapter", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("has name 'openclaw'", () => {
    const adapter = createOpenClawAdapter();
    expect(adapter.name).toBe("openclaw");
  });

  it("calls openclaw agent with --agent --json --timeout --message", async () => {
    mockExec.mockResolvedValue({
      stdout: '{"result":"analyzed"}',
      stderr: "",
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn(
      { task: "Analyze code", timeout: 120 },
      mockCtx()
    );

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ result: "analyzed" });

    const [bin, args] = mockExec.mock.calls[0];
    expect(bin).toBe("openclaw");
    expect(args).toContain("agent");
    expect(args).toContain("--agent");
    expect(args).toContain("main");
    expect(args).toContain("--json");
    expect(args).toContain("--timeout");
    expect(args).toContain("120");
    expect(args).toContain("--message");
    // Should NOT contain --inline (removed)
    expect(args).not.toContain("--inline");
  });

  it("uses custom agentId", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn(
      { task: "review", agentId: "code-reviewer" },
      mockCtx()
    );

    const args = mockExec.mock.calls[0][1];
    expect(args).toContain("code-reviewer");
    expect(args).not.toContain("main"); // overridden
  });

  it("uses custom bin path", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter({ bin: "/opt/openclaw" });

    await adapter.spawn({ task: "test" }, mockCtx());

    expect(mockExec.mock.calls[0][0]).toBe("/opt/openclaw");
  });

  it("includes spawn tool parameters in message", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn(
      {
        task: "Build the app",
        runtime: "subagent",
        mode: "run",
        model: "claude-sonnet-4-6",
        thinking: "high",
      },
      mockCtx()
    );

    const args = mockExec.mock.calls[0][1];
    const messageIdx = args.indexOf("--message");
    const message = args[messageIdx + 1];
    expect(message).toContain("sessions_spawn");
    expect(message).toContain("Build the app");
    expect(message).toContain("runtime: subagent");
    expect(message).toContain("mode: run");
    expect(message).toContain("model: claude-sonnet-4-6");
    expect(message).toContain("thinking: high");
  });

  it("passes --thinking flag to CLI", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn({ task: "review", thinking: "high" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    const thinkingIdx = args.indexOf("--thinking");
    expect(thinkingIdx).toBeGreaterThan(-1);
    expect(args[thinkingIdx + 1]).toBe("high");
  });

  it("does not pass --thinking when not specified", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn({ task: "test" }, mockCtx());

    const args = mockExec.mock.calls[0][1];
    expect(args).not.toContain("--thinking");
  });

  it("extracts session key from output", async () => {
    mockExec.mockResolvedValue({
      stdout: 'Session started: agent:main:subagent:abc-123-def',
      stderr: "",
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.childSessionKey).toBe("agent:main:subagent:abc-123-def");
  });

  it("returns error on CLI failure", async () => {
    const err = new Error("Command failed (exit 1): openclaw: connection refused") as any;
    err.exitCode = 1;
    err.stderr = "openclaw: connection refused";
    mockExec.mockRejectedValue(err);

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("connection refused");
  });

  it("returns error when openclaw not found", async () => {
    mockExec.mockRejectedValue(new Error("spawn openclaw ENOENT"));

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("ENOENT");
  });

  it("sets timeout with 30s buffer over agent timeout", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn({ task: "test", timeout: 120 }, mockCtx());

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.timeoutMs).toBe(150_000); // 120 + 30 buffer
  });

  it("defaults timeout to 600s", async () => {
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    const adapter = createOpenClawAdapter();

    await adapter.spawn({ task: "test" }, mockCtx());

    const opts = mockExec.mock.calls[0][2];
    expect(opts?.timeoutMs).toBe(630_000); // 600 + 30 buffer
  });

  it("waitForCompletion returns completed (CLI blocks)", async () => {
    const adapter = createOpenClawAdapter();
    const result = await adapter.waitForCompletion("any");
    expect(result.status).toBe("completed");
  });

  it("parses JSON stdout", async () => {
    mockExec.mockResolvedValue({
      stdout: '{"score":95,"issues":[]}',
      stderr: "",
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.output).toEqual({ score: 95, issues: [] });
  });

  it("returns raw string when output is not JSON", async () => {
    mockExec.mockResolvedValue({
      stdout: "Agent completed successfully",
      stderr: "",
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.output).toBe("Agent completed successfully");
  });

  // --- Bug fixes: stderr, envelope, exit code 1 ---

  it("reads from stderr when stdout is empty (openclaw --json writes to stderr)", async () => {
    mockExec.mockResolvedValue({
      stdout: "",
      stderr: '{"payloads":[{"text":"{\\"score\\":85}"}],"meta":{}}',
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ score: 85 });
  });

  it("extracts agent response from OpenClaw payloads envelope", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: '{"approved": false, "score": 55, "feedback": "needs work"}' }],
      meta: { durationMs: 5000 },
    });
    mockExec.mockResolvedValue({
      stdout: "",
      stderr: `Config warning: version mismatch\n${envelope}`,
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ approved: false, score: 55, feedback: "needs work" });
  });

  it("extracts last payload text when multiple payloads exist", async () => {
    const envelope = JSON.stringify({
      payloads: [
        { text: "thinking..." },
        { text: '{"score": 90}' },
      ],
      meta: {},
    });
    mockExec.mockResolvedValue({ stdout: "", stderr: envelope, exitCode: 0 });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.output).toEqual({ score: 90 });
  });

  it("recovers response when CLI exits with code 1 but stderr has valid data", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: '{"approved": true, "score": 80, "feedback": "ok"}' }],
      meta: {},
    });
    const err = new Error("Command failed (exit 1)") as any;
    err.exitCode = 1;
    err.stdout = "";
    err.stderr = `Gateway warning\n${envelope}`;
    mockExec.mockRejectedValue(err);

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ approved: true, score: 80, feedback: "ok" });
  });

  it("returns error when CLI exits with code 1 and no recoverable data", async () => {
    const err = new Error("Command failed") as any;
    err.exitCode = 1;
    err.stdout = "";
    err.stderr = "Fatal: gateway crashed";
    mockExec.mockRejectedValue(err);

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("error");
    expect(result.error).toContain("Fatal: gateway crashed");
  });

  it("extracts payloads from wrapped envelope (result.payloads)", async () => {
    const envelope = JSON.stringify({
      runId: "abc-123",
      status: "ok",
      summary: "completed",
      result: {
        payloads: [{ text: '{"approved": true, "score": 95, "feedback": "looks good"}' }],
      },
    });
    mockExec.mockResolvedValue({ stdout: envelope, stderr: "", exitCode: 0 });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "review" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toEqual({ approved: true, score: 95, feedback: "looks good" });
  });

  it("handles stderr with log lines before JSON envelope", async () => {
    const envelope = JSON.stringify({
      payloads: [{ text: "plain text response" }],
      meta: {},
    });
    mockExec.mockResolvedValue({
      stdout: "",
      stderr: [
        "Config was last written by a newer OpenClaw (2026.4.2)",
        "Gateway target: ws://127.0.0.1:18789",
        "Source: local loopback",
        envelope,
      ].join("\n"),
      exitCode: 0,
    });

    const adapter = createOpenClawAdapter();
    const result = await adapter.spawn({ task: "test" }, mockCtx());

    expect(result.status).toBe("accepted");
    expect(result.output).toBe("plain text response");
  });
});
