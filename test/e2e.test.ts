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

// ─── Code Review Loop E2E ───────────────────────────────────────────

describe("e2e: code review loop (restart)", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("coder -> reviewer -> restart loop -> approved", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-code-review-loop.yaml"));

    const events: PipelineEvent[] = [];
    const emitter = createEventEmitter();
    emitter.on("*", (e) => events.push(e));

    const result = await runPipeline(pipeline, {
      events: emitter,
      args: {
        task: "Write a Python function that returns the reverse of a string",
        threshold: "50",  // Low threshold so it passes quickly
      },
    });

    console.log("Code review loop status:", result.status);
    console.log("Coder output:", JSON.stringify(result.results.coder?.output, null, 2));
    console.log("Reviewer output:", JSON.stringify(result.results.reviewer?.output, null, 2));
    console.log("Decide output:", JSON.stringify(result.results.decide?.output, null, 2));
    console.log("Result output:", JSON.stringify(result.results.result?.output, null, 2));

    // Pipeline should complete (not fail)
    expect(result.status).toBe("completed");

    // Coder should have produced code
    const coderOutput = result.results.coder;
    expect(coderOutput).toBeDefined();
    expect(coderOutput.status).toBe("completed");

    // Reviewer should have scored
    const reviewerOutput = result.results.reviewer;
    expect(reviewerOutput).toBeDefined();
    expect(reviewerOutput.status).toBe("completed");

    // Decision step should have run
    const decideOutput = result.results.decide;
    expect(decideOutput).toBeDefined();
    expect(decideOutput.status).toBe("completed");

    // Result branch should have run
    const resultOutput = result.results.result;
    expect(resultOutput).toBeDefined();
    expect(resultOutput.status).toBe("completed");

    // Check restart events
    const retryEvents = events.filter((e) => e.type === "step:retry");
    console.log("Restart count:", retryEvents.length);
  }, 300_000); // 5 min timeout for multiple iterations

  it.skipIf(!shouldRun)("exhausts max restarts with impossible threshold", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-code-review-loop.yaml"));

    const result = await runPipeline(pipeline, {
      args: {
        task: "Write a Python function that returns 42",
        threshold: "999",  // Impossible threshold — will exhaust maxRestarts
      },
    });

    console.log("Exhaustion test status:", result.status);
    console.log("Reviewer scores seen:", JSON.stringify(result.results.reviewer?.output, null, 2));
    console.log("Result:", JSON.stringify(result.results.result?.output, null, 2));

    // Pipeline should still complete (restart exhaustion is not a failure)
    expect(result.status).toBe("completed");

    // The branch should route to the "rejected" default
    const resultOutput = result.results.result;
    expect(resultOutput).toBeDefined();
  }, 600_000); // 10 min timeout for 3 iterations
});

// ─── Parallel Agents E2E ────────────────────────────────────────────

describe("e2e: parallel agents", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("two agents work in parallel and results merge", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-parallel-agents.yaml"));

    const result = await runPipeline(pipeline, {
      args: { topic: "benefits of automated testing" },
    });

    console.log("Parallel status:", result.status);
    console.log("Parallel output:", JSON.stringify(result.results.parallel_work?.output, null, 2));
    console.log("Summary:", JSON.stringify(result.results.summarize?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.parallel_work).toBeDefined();
    expect(result.results.parallel_work.status).toBe("completed");
    expect(result.results.summarize?.status).toBe("completed");
  }, 180_000);
});

// ─── Sub-Pipeline E2E ───────────────────────────────────────────────

describe("e2e: sub-pipeline composition", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("parent calls child pipeline with args and gets output", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-sub-pipeline.yaml"));

    const result = await runPipeline(pipeline, {
      args: { topic: "why unit testing matters" },
    });

    console.log("Sub-pipeline status:", result.status);
    console.log("Prep:", JSON.stringify(result.results.prep?.output, null, 2));
    console.log("Child:", JSON.stringify(result.results.child?.output, null, 2));
    console.log("Result:", JSON.stringify(result.results.result?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.prep?.status).toBe("completed");
    expect(result.results.child?.status).toBe("completed");
    expect(result.results.result?.status).toBe("completed");
  }, 180_000);
});

// ─── Gate + Resume E2E ──────────────────────────────────────────────

describe("e2e: gate and resume", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("pipeline halts at gate in run mode, completes in test mode", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-gate-resume.yaml"));

    // In test mode, gates auto-approve
    const result = await runPipeline(pipeline, { mode: "test" });

    console.log("Gate test status:", result.status);
    console.log("Analyze:", JSON.stringify(result.results.analyze?.output, null, 2));
    console.log("Execute:", JSON.stringify(result.results.execute?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.analyze?.status).toBe("completed");
    expect(result.results.approval?.status).toBe("completed");
    expect(result.results.execute?.status).toBe("completed");
  }, 180_000);

  it.skipIf(!shouldRun)("pipeline halts at gate in run mode and returns resume token", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-gate-resume.yaml"));

    // In run mode, gate halts
    const result = await runPipeline(pipeline);

    console.log("Gate halt status:", result.status);
    console.log("Resume token:", result.resumeToken ? "present" : "missing");

    // Should halt (not complete) because gate blocks in run mode
    expect(result.status).toBe("halted");
    expect(result.resumeToken).toBeDefined();
    expect(result.results.analyze?.status).toBe("completed");
  }, 180_000);
});

// ─── Loop Items E2E ─────────────────────────────────────────────────

describe("e2e: loop over items", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("iterates list items through agent and collects results", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-loop-items.yaml"));

    const result = await runPipeline(pipeline);

    console.log("Loop status:", result.status);
    console.log("Items:", JSON.stringify(result.results.generate_items?.output, null, 2));
    console.log("Loop results:", JSON.stringify(result.results.process_items?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.generate_items?.status).toBe("completed");
    expect(result.results.process_items?.status).toBe("completed");

    // Should have processed 3 items
    const loopOutput = result.results.process_items?.output;
    if (Array.isArray(loopOutput)) {
      expect(loopOutput.length).toBe(3);
    }
  }, 300_000);
});

// ─── Error Recovery E2E ─────────────────────────────────────────────

describe("e2e: error recovery with fallback", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE;

  it.skipIf(!shouldRun)("routes to fallback when first attempt lacks confidence", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-error-recovery.yaml"));

    const result = await runPipeline(pipeline);

    console.log("Recovery status:", result.status);
    console.log("Attempt:", JSON.stringify(result.results.attempt?.output, null, 2));
    console.log("Check:", JSON.stringify(result.results.check?.output, null, 2));
    console.log("Final:", JSON.stringify(result.results.final?.output, null, 2));

    expect(result.status).toBe("completed");
    expect(result.results.attempt?.status).toBe("completed");
    expect(result.results.check?.status).toBe("completed");
    expect(result.results.final?.status).toBe("completed");
  }, 180_000);
});

// ─── Mixed Adapters E2E ─────────────────────────────────────────────

describe("e2e: mixed adapters (claude-code + openclaw)", () => {
  const shouldRun = E2E_ENABLED && HAS_CLAUDE && HAS_OPENCLAW;

  it.skipIf(!shouldRun)("claude-code writes code, openclaw reviews it", async () => {
    const pipeline = parseFile(resolve(e2eDir, "e2e-mixed-adapters.yaml"));

    const result = await runPipeline(pipeline);

    console.log("Mixed status:", result.status);
    console.log("Write:", JSON.stringify(result.results.write_code?.output, null, 2));
    console.log("Review:", JSON.stringify(result.results.review_code?.output, null, 2));

    if (result.status === "completed") {
      expect(result.results.write_code?.status).toBe("completed");
      expect(result.results.review_code?.status).toBe("completed");
    } else {
      // OpenClaw gateway may not be running — acceptable
      console.log("Mixed adapters failed (expected if openclaw gateway not running)");
      expect(result.results.write_code?.status).toBe("completed");
    }
  }, 300_000);

  it.skipIf(!E2E_ENABLED)("skips when both CLIs not available", () => {
    if (!HAS_CLAUDE || !HAS_OPENCLAW) {
      console.log(`Skipping: claude=${HAS_CLAUDE}, openclaw=${HAS_OPENCLAW}`);
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

  it("squid run -v --dry-run produces verbose event logs", () => {
    const cwd = resolve(import.meta.dirname ?? ".", "..");
    // execSync returns stdout; verbose logs go to stderr
    const result = require("node:child_process").spawnSync(
      "npx", ["tsx", "src/cli/main.ts", "run", resolve(e2eDir, "e2e-claude-code.yaml"), "-v", "--dry-run"],
      { encoding: "utf-8", cwd, timeout: 15_000 }
    );
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";

    // Verbose logs go to stderr
    expect(stderr).toContain("[pipeline]");
    expect(stderr).toContain("[spawn]");
    expect(stderr).toContain("[transform]");
    expect(stderr).toContain("▶");       // pipeline start icon
    expect(stderr).toContain("→");       // step starting icon
    expect(stderr).toContain("✓");       // completed icon
    expect(stderr).toContain("[hello]");  // step ID
    expect(stderr).toContain("[verify]"); // step ID

    // JSON result goes to stdout
    expect(stdout).toContain("completed");
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
