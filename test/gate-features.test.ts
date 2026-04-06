import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/core/runtime.js";
import { validateGateInput, validateApprover, generateShortId, registerShortId, resolveShortId, clearShortIds } from "../src/core/gate-utils.js";
import { createEventEmitter } from "../src/core/events.js";
import { parsePipeline } from "../src/core/parser.js";
import type { Pipeline, PipelineEvent, GateDecision } from "../src/core/types.js";

// ─── Feature 1: Structured Gate Input ────────────────────────────────

describe("structured gate input", () => {
  describe("validateGateInput", () => {
    it("validates required string fields", () => {
      const result = validateGateInput(
        [{ name: "env", type: "string", required: true }],
        { env: "prod" }
      );
      expect(result.valid).toBe(true);
      expect(result.values.env).toBe("prod");
    });

    it("rejects missing required fields", () => {
      const result = validateGateInput(
        [{ name: "env", type: "string", required: true }],
        {}
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("required");
    });

    it("uses default when field is missing", () => {
      const result = validateGateInput(
        [{ name: "env", type: "string", default: "staging" }],
        {}
      );
      expect(result.valid).toBe(true);
      expect(result.values.env).toBe("staging");
    });

    it("validates number fields", () => {
      const result = validateGateInput(
        [{ name: "count", type: "number" }],
        { count: "42" }
      );
      expect(result.valid).toBe(true);
      expect(result.values.count).toBe(42);
    });

    it("rejects invalid numbers", () => {
      const result = validateGateInput(
        [{ name: "count", type: "number" }],
        { count: "not-a-number" }
      );
      expect(result.valid).toBe(false);
    });

    it("validates boolean fields", () => {
      const r1 = validateGateInput([{ name: "ok", type: "boolean" }], { ok: true });
      expect(r1.values.ok).toBe(true);

      const r2 = validateGateInput([{ name: "ok", type: "boolean" }], { ok: "true" });
      expect(r2.values.ok).toBe(true);

      const r3 = validateGateInput([{ name: "ok", type: "boolean" }], { ok: "false" });
      expect(r3.values.ok).toBe(false);
    });

    it("validates select fields", () => {
      const result = validateGateInput(
        [{ name: "env", type: "select", options: ["dev", "staging", "prod"] }],
        { env: "prod" }
      );
      expect(result.valid).toBe(true);
      expect(result.values.env).toBe("prod");
    });

    it("rejects invalid select option", () => {
      const result = validateGateInput(
        [{ name: "env", type: "select", options: ["dev", "staging"] }],
        { env: "prod" }
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("one of");
    });

    it("validates string with regex pattern", () => {
      const valid = validateGateInput(
        [{ name: "version", type: "string", validation: "^\\d+\\.\\d+\\.\\d+$" }],
        { version: "1.2.3" }
      );
      expect(valid.valid).toBe(true);

      const invalid = validateGateInput(
        [{ name: "version", type: "string", validation: "^\\d+\\.\\d+\\.\\d+$" }],
        { version: "bad" }
      );
      expect(invalid.valid).toBe(false);
    });

    it("allows optional fields to be missing", () => {
      const result = validateGateInput(
        [{ name: "note", type: "string", required: false }],
        {}
      );
      expect(result.valid).toBe(true);
    });
  });

  it("gate with input fields in pipeline", () => {
    const p = parsePipeline({
      name: "t",
      steps: [{
        id: "approve",
        gate: {
          prompt: "Deploy?",
          input: [
            { name: "env", type: "select", options: ["staging", "prod"] },
            { name: "version", type: "string", validation: "^\\d+\\.\\d+$" },
            { name: "notify", type: "boolean", default: true },
          ],
        },
      }],
    });
    expect(p.steps[0].gate?.input).toHaveLength(3);
    expect(p.steps[0].gate?.input?.[0].name).toBe("env");
    expect(p.steps[0].gate?.input?.[0].options).toEqual(["staging", "prod"]);
  });

  it("gate returns structured input via hook", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "config-gate",
          type: "gate",
          gate: {
            prompt: "Configure deployment",
            input: [
              { name: "env", type: "select", options: ["staging", "prod"] },
              { name: "replicas", type: "number" },
            ],
          },
        },
        { id: "deploy", type: "run", run: "echo deployed" },
      ],
    };

    const result = await runPipeline(pipeline, {
      hooks: {
        onGateReached: async (): Promise<GateDecision> => ({
          approved: true,
          input: { env: "prod", replicas: 3 },
          approvedBy: "admin",
        }),
      },
    });

    expect(result.status).toBe("completed");
    const gateOutput = result.results["config-gate"].output as Record<string, unknown>;
    expect(gateOutput.approved).toBe(true);
    expect((gateOutput.input as Record<string, unknown>).env).toBe("prod");
    expect((gateOutput.input as Record<string, unknown>).replicas).toBe(3);
    expect(gateOutput.approvedBy).toBe("admin");
  });

  it("rejects gate with invalid structured input", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "gate",
          type: "gate",
          gate: {
            prompt: "Configure",
            input: [
              { name: "env", type: "select", options: ["staging", "prod"] },
            ],
          },
        },
      ],
    };

    const result = await runPipeline(pipeline, {
      hooks: {
        onGateReached: async (): Promise<GateDecision> => ({
          approved: true,
          input: { env: "invalid-env" }, // not in options
        }),
      },
    });

    expect(result.results.gate.status).toBe("skipped");
    const output = result.results.gate.output as Record<string, unknown>;
    expect(output.approved).toBe(false);
    expect(output.validationErrors).toBeDefined();
  });
});

// ─── Feature 2: Event Hooks / Observability ──────────────────────────

describe("event hooks / observability", () => {
  it("emits pipeline:start and pipeline:complete events", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("*", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test-events",
      steps: [{ id: "s1", type: "run", run: "echo hi" }],
    };

    await runPipeline(pipeline, { events: emitter });

    const types = events.map((e) => e.type);
    expect(types).toContain("pipeline:start");
    expect(types).toContain("pipeline:complete");
  });

  it("emits step:start and step:complete events", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("*", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "a", type: "run", run: "echo a" },
        { id: "b", type: "run", run: "echo b" },
      ],
    };

    await runPipeline(pipeline, { events: emitter });

    const stepStarts = events.filter((e) => e.type === "step:start");
    const stepCompletes = events.filter((e) => e.type === "step:complete");
    expect(stepStarts).toHaveLength(2);
    expect(stepCompletes).toHaveLength(2);
    expect(stepStarts[0].stepId).toBe("a");
    expect(stepStarts[1].stepId).toBe("b");
  });

  it("emits step:skip for skipped steps", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("step:skip", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: 'echo \'{"go":false}\'' },
        { id: "s2", type: "run", run: "echo skipped", when: "$s1.json.go" },
      ],
    };

    await runPipeline(pipeline, { events: emitter });
    expect(events).toHaveLength(1);
    expect(events[0].stepId).toBe("s2");
  });

  it("emits gate:waiting for halted gates", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("gate:waiting", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    await runPipeline(pipeline, { events: emitter });
    expect(events).toHaveLength(1);
    expect(events[0].stepId).toBe("gate");
    expect(events[0].data?.shortId).toBeDefined();
  });

  it("emits gate:approved via hook", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("gate:approved", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    await runPipeline(pipeline, {
      events: emitter,
      hooks: { onGateReached: async () => true },
    });

    expect(events).toHaveLength(1);
  });

  it("emits gate:rejected via hook", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("gate:rejected", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    await runPipeline(pipeline, {
      events: emitter,
      hooks: { onGateReached: async () => false },
    });

    expect(events).toHaveLength(1);
  });

  it("events include OTel-compatible fields", async () => {
    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("*", (e) => events.push(e));

    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "s1", type: "run", run: "echo ok" }],
    };

    const result = await runPipeline(pipeline, { events: emitter });

    for (const event of events) {
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.traceId).toBe(result.runId);
      expect(event.spanId).toBeDefined();
      expect(event.pipelineId).toBe("test");
    }
  });

  it("wildcard and typed listeners both fire", async () => {
    const emitter = createEventEmitter();
    const wild: string[] = [];
    const typed: string[] = [];

    emitter.on("*", (e) => wild.push(e.type));
    emitter.on("step:start", (e) => typed.push(e.type));

    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "s", type: "run", run: "echo ok" }],
    };

    await runPipeline(pipeline, { events: emitter });
    expect(wild.length).toBeGreaterThan(0);
    expect(typed).toContain("step:start");
  });

  it("off removes listener", () => {
    const emitter = createEventEmitter();
    const events: PipelineEvent[] = [];
    const handler = (e: PipelineEvent) => events.push(e);

    emitter.on("step:start", handler);
    emitter.emit({ type: "step:start", timestamp: 1, pipelineId: "t", runId: "r" });
    expect(events).toHaveLength(1);

    emitter.off("step:start", handler);
    emitter.emit({ type: "step:start", timestamp: 2, pipelineId: "t", runId: "r" });
    expect(events).toHaveLength(1); // no new event
  });
});

// ─── Feature 3: Short Approval IDs ───────────────────────────────────

describe("short approval IDs", () => {
  it("generateShortId returns 8-char hex", () => {
    const id = generateShortId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("generateShortId is unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateShortId()));
    expect(ids.size).toBe(100);
  });

  it("registerShortId and resolveShortId roundtrip", () => {
    clearShortIds();
    registerShortId("abcd1234", "full-token-here");
    expect(resolveShortId("abcd1234")).toBe("full-token-here");
    expect(resolveShortId("unknown")).toBeUndefined();
    clearShortIds();
  });

  it("gate halt output includes shortId", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("halted");

    const gateOutput = result.results.gate.output as Record<string, unknown>;
    expect(gateOutput.shortId).toBeDefined();
    expect(typeof gateOutput.shortId).toBe("string");
    expect((gateOutput.shortId as string).length).toBe(8);
  });

  it("resume token includes shortId", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    const result = await runPipeline(pipeline);
    expect(result.resumeToken?.shortId).toBeDefined();
    expect(result.resumeToken?.shortId?.length).toBe(8);
  });
});

// ─── Feature 4: Caller Identity on Gates ─────────────────────────────

describe("caller identity on gates", () => {
  describe("validateApprover", () => {
    it("allows anyone when no restrictions", () => {
      const result = validateApprover({ prompt: "OK?" }, "user1");
      expect(result.allowed).toBe(true);
    });

    it("allows required approver", () => {
      const result = validateApprover(
        { prompt: "OK?", requiredApprovers: ["admin", "lead"] },
        "admin"
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects non-required approver", () => {
      const result = validateApprover(
        { prompt: "OK?", requiredApprovers: ["admin"] },
        "random-user"
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in requiredApprovers");
    });

    it("rejects when identity is required but not provided", () => {
      const result = validateApprover(
        { prompt: "OK?", requiredApprovers: ["admin"] },
        undefined
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("identity is required");
    });

    it("blocks self-approval when not allowed", () => {
      const result = validateApprover(
        { prompt: "OK?", allowSelfApproval: false },
        "user1", // approver
        "user1"  // initiator — same person
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Self-approval");
    });

    it("allows self-approval by default", () => {
      const result = validateApprover(
        { prompt: "OK?" },
        "user1",
        "user1"
      );
      expect(result.allowed).toBe(true);
    });
  });

  it("rejects gate when requiredApprover not met", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [{
        id: "gate",
        type: "gate",
        gate: {
          prompt: "Deploy?",
          requiredApprovers: ["admin"],
        },
      }],
    };

    const result = await runPipeline(pipeline, {
      hooks: {
        onGateReached: async (): Promise<GateDecision> => ({
          approved: true,
          approvedBy: "random-user",
        }),
      },
    });

    expect(result.results.gate.status).toBe("skipped");
    expect(result.results.gate.meta?.identityRejected).toBe(true);
  });

  it("blocks self-approval via pipeline context", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [{
        id: "gate",
        type: "gate",
        gate: {
          prompt: "Deploy?",
          allowSelfApproval: false,
        },
      }],
    };

    const result = await runPipeline(pipeline, {
      initiatedBy: "user1",
      hooks: {
        onGateReached: async (): Promise<GateDecision> => ({
          approved: true,
          approvedBy: "user1", // same as initiator
        }),
      },
    });

    expect(result.results.gate.status).toBe("skipped");
    expect(result.results.gate.meta?.identityRejected).toBe(true);
  });

  it("resume token includes initiatedBy", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [{ id: "gate", type: "gate", gate: { prompt: "OK?" } }],
    };

    const result = await runPipeline(pipeline, { initiatedBy: "deployer-bot" });
    expect(result.resumeToken?.initiatedBy).toBe("deployer-bot");
  });

  it("parser handles requiredApprovers and allowSelfApproval", () => {
    const p = parsePipeline({
      name: "t",
      steps: [{
        id: "gate",
        gate: {
          prompt: "Deploy?",
          requiredApprovers: ["admin", "lead"],
          allowSelfApproval: false,
        },
      }],
    });
    expect(p.steps[0].gate?.requiredApprovers).toEqual(["admin", "lead"]);
    expect(p.steps[0].gate?.allowSelfApproval).toBe(false);
  });
});
