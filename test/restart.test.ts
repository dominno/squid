import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/core/runtime.js";
import { parsePipeline } from "../src/core/parser.js";
import type { Pipeline } from "../src/core/types.js";

describe("restart (jump back)", () => {
  it("restarts from a previous step when condition is true", async () => {
    // Step 1: generate a counter that increments
    // Step 2: check if counter < 3, restart from step 1
    // This simulates an iterative refinement loop.
    //
    // We use a file-based counter since each shell invocation is stateless.
    const tmpFile = `/tmp/squid-restart-test-${Date.now()}`;

    const pipeline: Pipeline = {
      name: "test-restart",
      steps: [
        {
          id: "increment",
          type: "run",
          run: `count=$(cat ${tmpFile} 2>/dev/null || echo 0); count=$((count + 1)); echo $count > ${tmpFile}; echo "{\\"count\\": $count}"`,
        },
        {
          id: "check",
          type: "transform",
          transform: "$increment.json.count",
          restart: {
            step: "increment",
            when: "$increment.json.count < 3",
            maxRestarts: 5,
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    // Should have run 3 times: count=1 (restart), count=2 (restart), count=3 (stop)
    expect(result.results.increment.output).toEqual({ count: 3 });

    // Cleanup
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpFile); } catch {}
  });

  it("respects maxRestarts limit", async () => {
    // Always-true restart condition with maxRestarts=2
    const tmpFile = `/tmp/squid-restart-max-${Date.now()}`;

    const pipeline: Pipeline = {
      name: "test-restart-max",
      steps: [
        {
          id: "work",
          type: "run",
          run: `count=$(cat ${tmpFile} 2>/dev/null || echo 0); count=$((count + 1)); echo $count > ${tmpFile}; echo "{\\"iteration\\": $count}"`,
        },
        {
          id: "loop-back",
          type: "transform",
          transform: "$work.json.iteration",
          restart: {
            step: "work",
            when: "true",        // always restart
            maxRestarts: 2,      // but only 2 times
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    // Runs: 1 (initial) + 2 (restarts) = 3 total, then exhausted
    expect(result.results.work.output).toEqual({ iteration: 3 });
    expect(result.results["loop-back"].meta?.restartExhausted).toBe(true);

    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpFile); } catch {}
  });

  it("does not restart when condition is false", async () => {
    const pipeline: Pipeline = {
      name: "test-no-restart",
      steps: [
        {
          id: "work",
          type: "run",
          run: 'echo \'{"quality": 95}\'',
        },
        {
          id: "check",
          type: "transform",
          transform: "$work.json.quality",
          restart: {
            step: "work",
            when: "$work.json.quality < 80",  // 95 >= 80, so no restart
            maxRestarts: 3,
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    expect(result.results.work.output).toEqual({ quality: 95 });
    // check step should execute once, no restart
    expect(result.results.check.output).toBe(95);
  });

  it("clears intermediate step results on restart", async () => {
    const tmpFile = `/tmp/squid-restart-clear-${Date.now()}`;

    const pipeline: Pipeline = {
      name: "test-restart-clear",
      steps: [
        {
          id: "step-a",
          type: "run",
          run: `count=$(cat ${tmpFile} 2>/dev/null || echo 0); count=$((count + 1)); echo $count > ${tmpFile}; echo "{\\"v\\": $count}"`,
        },
        {
          id: "step-b",
          type: "run",
          run: 'echo \'{"middle": true}\'',
        },
        {
          id: "step-c",
          type: "transform",
          transform: "$step-a.json.v",
          restart: {
            step: "step-a",
            when: "$step-a.json.v < 2",
            maxRestarts: 3,
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    // step-a should show the final value (2), not the first (1)
    expect(result.results["step-a"].output).toEqual({ v: 2 });
    // step-b should have re-run (result exists and is fresh)
    expect(result.results["step-b"].output).toEqual({ middle: true });

    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpFile); } catch {}
  });

  it("throws on non-existent restart target", async () => {
    const pipeline: Pipeline = {
      name: "test-bad-target",
      steps: [
        {
          id: "work",
          type: "run",
          run: 'echo \'{"x": 1}\'',
          restart: {
            step: "nonexistent",
            when: "true",
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not found");
  });

  it("allows self-restart (step restarts itself)", async () => {
    const tmpFile = `/tmp/squid-restart-self-${Date.now()}`;

    const pipeline: Pipeline = {
      name: "test-self-restart",
      steps: [
        {
          id: "setup",
          type: "run",
          run: 'echo \'{"ready": true}\'',
        },
        {
          id: "review",
          type: "run",
          run: `count=$(cat ${tmpFile} 2>/dev/null || echo 0); count=$((count + 1)); echo $count > ${tmpFile}; echo "{\\"score\\": $((count * 30))}"`,
          restart: {
            step: "review",    // self-restart
            when: "$review.json.score < 75",
            maxRestarts: 3,
          },
        },
        {
          id: "result",
          type: "transform",
          transform: "$review.json.score",
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    // Runs: score=30 (restart), score=60 (restart), score=90 (stop)
    expect(result.results.review.output).toEqual({ score: 90 });
    expect(result.results.result.output).toBe(90);

    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpFile); } catch {}
  });

  it("self-restart respects maxRestarts", async () => {
    // Always-failing self-restart with maxRestarts=2
    const pipeline: Pipeline = {
      name: "test-self-restart-max",
      steps: [
        {
          id: "check",
          type: "run",
          run: 'echo \'{"score": 10}\'',
          restart: {
            step: "check",    // self-restart
            when: "$check.json.score < 75",
            maxRestarts: 2,
          },
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("completed");
    // Exhausted after 2 restarts, continues forward
    expect(result.results.check.meta?.restartExhausted).toBe(true);
    expect(result.results.check.meta?.restartCount).toBe(2);
  });

  it("throws on forward jump", async () => {
    const pipeline: Pipeline = {
      name: "test-forward-jump",
      steps: [
        {
          id: "early",
          type: "run",
          run: 'echo \'{"x": 1}\'',
          restart: {
            step: "late",
            when: "true",
          },
        },
        {
          id: "late",
          type: "run",
          run: "echo done",
        },
      ],
    };

    const result = await runPipeline(pipeline);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("forward jumps not allowed");
  });

  it("parses restart string shorthand", () => {
    const p = parsePipeline({
      name: "t",
      steps: [
        { id: "a", run: "echo" },
        { id: "b", run: "echo", restart: "a" },
      ],
    });
    expect(p.steps[1].restart?.step).toBe("a");
    expect(p.steps[1].restart?.when).toBe("true");
    expect(p.steps[1].restart?.maxRestarts).toBe(3);
  });

  it("parses restart full config", () => {
    const p = parsePipeline({
      name: "t",
      steps: [
        { id: "a", run: "echo" },
        {
          id: "b",
          run: "echo",
          restart: {
            step: "a",
            when: "$a.json.score < 80",
            maxRestarts: 5,
          },
        },
      ],
    });
    expect(p.steps[1].restart?.step).toBe("a");
    expect(p.steps[1].restart?.when).toBe("$a.json.score < 80");
    expect(p.steps[1].restart?.maxRestarts).toBe(5);
  });

  it("works with spawn steps in test mode (iterative agent refinement)", async () => {
    // Simulates: agent writes code → reviewer scores it → if score < 80, restart from agent
    let spawnCount = 0;

    const pipeline: Pipeline = {
      name: "test-agent-refinement",
      steps: [
        {
          id: "write-code",
          type: "spawn",
          spawn: { task: "Write code" },
        },
        {
          id: "review",
          type: "spawn",
          spawn: { task: "Review the code" },
        },
        {
          id: "decide",
          type: "transform",
          transform: "$review.json.score",
          restart: {
            step: "write-code",
            when: "$review.json.score < 80",
            maxRestarts: 3,
          },
        },
      ],
    };

    const result = await runPipeline(pipeline, {
      mode: "test",
      hooks: {
        onSpawn: async (step) => {
          spawnCount++;
          if (step.id === "review") {
            // First two reviews: low score. Third: high score.
            const score = spawnCount >= 5 ? 90 : 50;
            return {
              status: "accepted",
              output: { score, feedback: score < 80 ? "needs work" : "looks good" },
            };
          }
          return {
            status: "accepted",
            output: { code: "function() {}", version: spawnCount },
          };
        },
      },
    });

    expect(result.status).toBe("completed");
    // write-code ran 3 times (initial + 2 restarts), review ran 3 times
    expect(spawnCount).toBe(6);
    // Final review score should be 90
    expect((result.results.review.output as any).score).toBe(90);
  });
});
