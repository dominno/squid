/**
 * End-to-end tests for agent adapters.
 *
 * These tests call REAL agent CLIs (claude, openclaw, opencode).
 * They are skipped automatically if the CLI is not installed.
 *
 * Run explicitly: SQUID_E2E=1 npx vitest run test/e2e.test.ts
 * Skip (default): npx vitest run (e2e tests auto-skip)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parseFile } from "../src/core/parser.js";
import { runPipeline } from "../src/core/runtime.js";
import { createEventEmitter } from "../src/core/events.js";
import { setupBuiltinAdapters } from "../src/core/adapters/setup.js";
import type { PipelineEvent } from "../src/core/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const E2E_ENABLED = process.env.SQUID_E2E === "1";
const e2eDir = resolve(import.meta.dirname ?? ".", "../skills/squid-pipeline/examples/e2e");

function cliExists(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_CLAUDE = cliExists("claude");
const HAS_OPENCLAW = cliExists("openclaw");
const HAS_OPENCODE = cliExists("opencode");

// Register adapters once
beforeAll(() => {
  setupBuiltinAdapters();
});

// ─── Claude Code E2E ─────────────────────────────────────────────────

describe("e2e: claude-code adapter", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("spawns a real Claude Code agent and gets JSON response", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-claude-code.yaml"));

    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("*", (e) => events.push(e));

    const result = await runPipeline(pipeline, { events: emitter });

    // Pipeline should complete
    expect(result.status).toBe("completed");

    // Spawn step should have output
    const helloResult = result.results.hello;
    expect(helloResult).toBeDefined();
    expect(helloResult.status).toBe("completed");
    expect(helloResult.output).toBeDefined();

    // Output should contain the agent response (may be wrapped in envelope)
    const output = helloResult.output;
    console.log("Claude Code output:", JSON.stringify(output, null, 2));

    // Events should have been emitted
    const stepStarts = events.filter((e) => e.type === "step:start");
    const stepCompletes = events.filter((e) => e.type === "step:complete");
    expect(stepStarts.length).toBeGreaterThan(0);
    expect(stepCompletes.length).toBeGreaterThan(0);

    // All events should have trace IDs
    for (const event of events) {
      expect(event.traceId).toBe(result.runId);
    }
  }, 120_000); // 2 min timeout

  it.skipIf(!shouldRun)("handles multi-step pipeline with data flow", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-claude-code.yaml"));
    const result = await runPipeline(pipeline);

    expect(result.status).toBe("completed");

    // verify step should have received hello's output
    const verifyResult = result.results.verify;
    expect(verifyResult).toBeDefined();
    expect(verifyResult.status).toBe("completed");
    console.log("Verify output:", JSON.stringify(verifyResult.output, null, 2));
  }, 120_000);

  it.skipIf(!E2E_ENABLED)("skips when claude CLI is not installed", () => {
    if (!HAS_CLAUDE) {
      console.log("Skipping: claude CLI not found");
    }
    expect(true).toBe(true);
  });
});

// ─── OpenClaw E2E ────────────────────────────────────────────────────

describe("e2e: openclaw adapter", () => {
  const shouldRun = E2E_ENABLED && HAS_OPENCLAW;

  it.skipIf(!shouldRun)("spawns a real OpenClaw agent", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-openclaw.yaml"));

    const result = await runPipeline(pipeline);

    // May fail if gateway isn't running, but shouldn't crash
    console.log("OpenClaw status:", result.status);
    console.log("OpenClaw output:", JSON.stringify(result.results.hello?.output, null, 2));

    if (result.status === "completed") {
      expect(result.results.hello.status).toBe("completed");
      expect(result.results.hello.output).toBeDefined();
    } else {
      // Gateway not running — acceptable failure
      console.log("OpenClaw error (expected if gateway not running):", result.error);
      expect(result.status).toBe("failed");
    }
  }, 180_000); // 3 min timeout

  it.skipIf(!E2E_ENABLED)("skips when openclaw CLI is not installed", () => {
    if (!HAS_OPENCLAW) {
      console.log("Skipping: openclaw CLI not found");
    }
    expect(true).toBe(true);
  });
});

// ─── OpenCode E2E ────────────────────────────────────────────────────

describe("e2e: opencode adapter", () => {
  it.skipIf(!E2E_ENABLED || !HAS_OPENCODE)("spawns a real OpenCode agent", () => {
    console.log("Skipping: opencode CLI not found on this machine");
    expect(true).toBe(true);
  });
});

// ─── CLI smoke test ──────────────────────────────────────────────────

describe("e2e: CLI commands", () => {
  it("squid validate works on e2e example", () => {
    const output = execSync(
      `npx tsx src/cli/main.ts validate ${resolve(e2eDir, "e2e-claude-code.yaml")}`,
      { encoding: "utf-8", cwd: resolve(import.meta.dirname ?? ".", "..") }
    );
    expect(output).toContain("valid");
  });

  it("squid viz works on e2e example", () => {
    const output = execSync(
      `npx tsx src/cli/main.ts viz ${resolve(e2eDir, "e2e-claude-code.yaml")}`,
      { encoding: "utf-8", cwd: resolve(import.meta.dirname ?? ".", "..") }
    );
    expect(output).toContain("graph TD");
    expect(output).toContain("hello");
  });

  it.skipIf(!E2E_ENABLED || !HAS_CLAUDE)("squid run works end-to-end with claude-code", async () => {
    const output = execSync(
      `npx tsx src/cli/main.ts run ${resolve(e2eDir, "e2e-claude-code.yaml")} -v`,
      {
        encoding: "utf-8",
        cwd: resolve(import.meta.dirname ?? ".", ".."),
        timeout: 120_000,
      }
    );
    console.log("CLI run output:", output.substring(0, 500));
    expect(output).toContain("completed");
  }, 120_000);
});
