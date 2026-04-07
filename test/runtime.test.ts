import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/core/runtime.js";
import type { Pipeline, AgentAdapter, SpawnConfig, PipelineContext } from "../src/core/types.js";

function createAdapter(
  overrides: Partial<AgentAdapter> = {}
): AgentAdapter {
  return {
    name: "test-mock",
    async spawn() {
      return {
        status: "accepted" as const,
        childSessionKey: "mock-session",
        output: { mocked: true },
      };
    },
    async waitForCompletion() {
      return { stepId: "", status: "completed" as const, output: { done: true } };
    },
    async getSessionStatus() {
      return "completed" as const;
    },
    ...overrides,
  };
}

describe("runPipeline", () => {
  describe("run steps", () => {
    it("executes a simple echo command", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [{ id: "echo", type: "run", run: "echo hello" }],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("completed");
      expect(result.results.echo.status).toBe("completed");
      expect(result.results.echo.stdout).toBe("hello");
    });

    it("parses JSON output from commands", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "json", type: "run", run: 'echo \'{"key":"value"}\'' },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.json.output).toEqual({ key: "value" });
    });

    it("resolves args in commands", async () => {
      const pipeline: Pipeline = {
        name: "test",
        args: { name: { default: "world" } },
        steps: [{ id: "greet", type: "run", run: "echo ${args.name}" }],
      };

      const result = await runPipeline(pipeline, {
        args: { name: "squid" },
      });
      expect(result.results.greet.stdout).toBe("squid");
    });

    it("fails on bad command", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "bad", type: "run", run: "nonexistent-command-xyz" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("failed");
      expect(result.results.bad.status).toBe("failed");
      expect(result.results.bad.error?.message).toBeTruthy();
    });
  });

  describe("dry-run mode", () => {
    it("does not execute commands in dry-run", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "dangerous", type: "run", run: "rm -rf /" },
        ],
      };

      const result = await runPipeline(pipeline, { mode: "dry-run" });
      expect(result.status).toBe("completed");
      expect(result.results.dangerous.meta?.dryRun).toBe(true);
    });
  });

  describe("conditions (when)", () => {
    it("skips step when condition is false", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "s1", type: "run", run: 'echo \'{"ready":false}\'' },
          { id: "s2", type: "run", run: "echo should-not-run", when: "$s1.json.ready" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.s2.status).toBe("skipped");
    });

    it("executes step when condition is true", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "s1", type: "run", run: 'echo \'{"ready":true}\'' },
          { id: "s2", type: "run", run: "echo ran", when: "$s1.json.ready" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.s2.status).toBe("completed");
      expect(result.results.s2.stdout).toBe("ran");
    });
  });

  describe("gate steps", () => {
    it("halts on gate in run mode", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "build", type: "run", run: "echo built" },
          { id: "approve", type: "gate", gate: { prompt: "Deploy?" } },
          { id: "deploy", type: "run", run: "echo deployed" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("halted");
      expect(result.resumeToken).toBeDefined();
      expect(result.resumeToken?.resumeAtStep).toBe("approve");
      // deploy should not have run
      expect(result.results.deploy).toBeUndefined();
    });

    it("auto-approves gates in test mode", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "approve", type: "gate", gate: { prompt: "OK?" } },
          { id: "next", type: "run", run: "echo proceeded" },
        ],
      };

      const result = await runPipeline(pipeline, { mode: "test" });
      expect(result.status).toBe("completed");
      expect(result.results.approve.status).toBe("completed");
      expect(result.results.next.stdout).toBe("proceeded");
    });

    it("uses hook for gate decisions", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "gate1", type: "gate", gate: { prompt: "Approve?" } },
          { id: "after", type: "run", run: "echo done" },
        ],
      };

      const result = await runPipeline(pipeline, {
        hooks: {
          onGateReached: async () => true,
        },
      });

      expect(result.status).toBe("completed");
      expect(result.results.after.stdout).toBe("done");
    });
  });

  describe("spawn steps", () => {
    it("spawns via adapter", async () => {
      const spawned: SpawnConfig[] = [];
      const adapter = createAdapter({
        async spawn(config) {
          spawned.push(config);
          return {
            status: "accepted",
            childSessionKey: "child-1",
            output: { result: "analyzed" },
          };
        },
      });

      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "analyze",
            type: "spawn",
            spawn: { task: "Analyze the code", agentId: "analyst" },
          },
        ],
      };

      const result = await runPipeline(pipeline, { adapter });
      expect(result.status).toBe("completed");
      expect(spawned).toHaveLength(1);
      expect(spawned[0].task).toBe("Analyze the code");
      expect(spawned[0].agentId).toBe("analyst");
    });

    it("dry-run does not spawn", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "s",
            type: "spawn",
            spawn: { task: "something" },
          },
        ],
      };

      const result = await runPipeline(pipeline, { mode: "dry-run" });
      expect(result.results.s.meta?.dryRun).toBe(true);
    });
  });

  describe("transform steps", () => {
    it("resolves a reference", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "data", type: "run", run: 'echo \'{"x":42}\'' },
          { id: "pick", type: "transform", transform: "$data.json.x" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.pick.output).toBe(42);
    });

    it("interpolates a JSON template", async () => {
      const pipeline: Pipeline = {
        name: "test",
        args: { env: { default: "prod" } },
        steps: [
          {
            id: "tmpl",
            type: "transform",
            transform: '{"environment": "${args.env}"}',
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.tmpl.output).toEqual({ environment: "prod" });
    });
  });

  describe("parallel steps", () => {
    it("executes branches concurrently", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "par",
            type: "parallel",
            parallel: {
              branches: {
                a: [{ id: "a1", type: "run", run: "echo branch-a" }],
                b: [{ id: "b1", type: "run", run: "echo branch-b" }],
              },
              merge: "object",
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("completed");
      const output = result.results.par.output as Record<string, unknown>;
      expect(output.a).toBe("branch-a");
      expect(output.b).toBe("branch-b");
    });

    it("merges as array", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "par",
            type: "parallel",
            parallel: {
              branches: {
                a: [{ id: "a1", type: "run", run: "echo 1" }],
                b: [{ id: "b1", type: "run", run: "echo 2" }],
              },
              merge: "array",
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      const output = result.results.par.output as unknown[];
      expect(output).toContain(1);
      expect(output).toContain(2);
    });
  });

  describe("loop steps", () => {
    it("iterates over array", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "data", type: "run", run: 'echo \'["a","b","c"]\'' },
          {
            id: "loop",
            type: "loop",
            loop: {
              over: "$data.json",
              steps: [{ id: "inner", type: "run", run: "echo item" }],
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("completed");
      const loopOutput = result.results.loop.output as unknown[];
      expect(loopOutput).toHaveLength(3);
    });
  });

  describe("branch steps", () => {
    it("takes first matching condition", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "data", type: "run", run: 'echo \'{"type":"error"}\'' },
          {
            id: "route",
            type: "branch",
            branch: {
              conditions: [
                {
                  when: '$data.json.type == "error"',
                  steps: [{ id: "handle-err", type: "run", run: "echo error-path" }],
                },
                {
                  when: '$data.json.type == "ok"',
                  steps: [{ id: "handle-ok", type: "run", run: "echo ok-path" }],
                },
              ],
              default: [{ id: "handle-default", type: "run", run: "echo default" }],
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results["handle-err"]?.stdout).toBe("error-path");
      expect(result.results["handle-ok"]).toBeUndefined();
    });

    it("takes default when no condition matches", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "data", type: "run", run: 'echo \'{"type":"unknown"}\'' },
          {
            id: "route",
            type: "branch",
            branch: {
              conditions: [
                {
                  when: '$data.json.type == "error"',
                  steps: [{ id: "err", type: "run", run: "echo err" }],
                },
              ],
              default: [{ id: "def", type: "run", run: "echo default" }],
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.def?.stdout).toBe("default");
    });

    it("skips when no match and no default", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "data", type: "run", run: 'echo \'{"type":"other"}\'' },
          {
            id: "route",
            type: "branch",
            branch: {
              conditions: [
                {
                  when: '$data.json.type == "error"',
                  steps: [{ id: "err", type: "run", run: "echo err" }],
                },
              ],
            },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.route.status).toBe("skipped");
    });
  });

  describe("onError strategies", () => {
    it("continues past failures with onError: continue", async () => {
      const pipeline: Pipeline = {
        name: "test",
        onError: "continue",
        steps: [
          { id: "fail", type: "run", run: "nonexistent-command-xyz" },
          { id: "after", type: "run", run: "echo still-running" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.fail.status).toBe("failed");
      expect(result.results.after.stdout).toBe("still-running");
    });

    it("skips failures with onError: skip", async () => {
      const pipeline: Pipeline = {
        name: "test",
        onError: "skip",
        steps: [
          { id: "fail", type: "run", run: "nonexistent-command-xyz" },
          { id: "after", type: "run", run: "echo continued" },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.fail.status).toBe("skipped");
    });
  });

  describe("abort signal", () => {
    it("cancels on abort", async () => {
      const controller = new AbortController();
      // Abort immediately
      controller.abort();

      const pipeline: Pipeline = {
        name: "test",
        steps: [
          { id: "s1", type: "run", run: "echo 1" },
          { id: "s2", type: "run", run: "echo 2" },
        ],
      };

      const result = await runPipeline(pipeline, {
        signal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
    });
  });

  describe("args resolution", () => {
    it("uses defaults when not provided", async () => {
      const pipeline: Pipeline = {
        name: "test",
        args: { env: { default: "dev" } },
        steps: [{ id: "s", type: "run", run: "echo ${args.env}" }],
      };

      const result = await runPipeline(pipeline);
      expect(result.results.s.stdout).toBe("dev");
    });

    it("overrides defaults with provided args", async () => {
      const pipeline: Pipeline = {
        name: "test",
        args: { env: { default: "dev" } },
        steps: [{ id: "s", type: "run", run: "echo ${args.env}" }],
      };

      const result = await runPipeline(pipeline, { args: { env: "prod" } });
      expect(result.results.s.stdout).toBe("prod");
    });

    it("throws on missing required args", async () => {
      const pipeline: Pipeline = {
        name: "test",
        args: { image: { required: true } },
        steps: [{ id: "s", type: "run", run: "echo" }],
      };

      await expect(runPipeline(pipeline)).rejects.toThrow("Missing required argument");
    });
  });

  describe("hooks", () => {
    it("calls lifecycle hooks", async () => {
      const events: string[] = [];

      const pipeline: Pipeline = {
        name: "test",
        steps: [{ id: "s1", type: "run", run: "echo hi" }],
      };

      await runPipeline(pipeline, {
        hooks: {
          onPipelineStart: async () => { events.push("pipeline-start"); },
          onStepStart: async (step) => { events.push(`step-start:${step.id}`); },
          onStepComplete: async (step) => { events.push(`step-complete:${step.id}`); },
          onPipelineComplete: async () => { events.push("pipeline-complete"); },
        },
      });

      expect(events).toEqual([
        "pipeline-start",
        "step-start:s1",
        "step-complete:s1",
        "pipeline-complete",
      ]);
    });
  });

  describe("pipeline steps (sub-pipeline)", () => {
    it("executes a sub-pipeline from file", async () => {
      const { resolve } = await import("node:path");
      const subPath = resolve(
        import.meta.dirname ?? ".",
        "../skills/squid-pipeline/examples/sub-build.yaml"
      );

      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "sub",
            type: "pipeline",
            pipeline: { file: subPath, args: { target: "prod" } },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("completed");
      expect(result.results.sub.status).toBe("completed");
      const output = result.results.sub.output as Record<string, unknown>;
      expect(output.artifact).toBe("app-prod.tar.gz");
      expect(output.target).toBe("prod");
      expect(output.lint_errors).toBe(0);
    });

    it("passes parent args to sub-pipeline via $refs", async () => {
      const { resolve } = await import("node:path");
      const subPath = resolve(
        import.meta.dirname ?? ".",
        "../skills/squid-pipeline/examples/sub-build.yaml"
      );

      const pipeline: Pipeline = {
        name: "test",
        args: { env: { default: "staging" } },
        steps: [
          {
            id: "sub",
            type: "pipeline",
            pipeline: { file: subPath, args: { target: "$args.env" } },
          },
        ],
      };

      const result = await runPipeline(pipeline, { args: { env: "qa" } });
      expect(result.status).toBe("completed");
      const output = result.results.sub.output as Record<string, unknown>;
      expect(output.target).toBe("qa");
      expect(output.artifact).toBe("app-qa.tar.gz");
    });

    it("resolves ${...} interpolation args to sub-pipeline (not bare $ref)", async () => {
      const { resolve } = await import("node:path");
      const subPath = resolve(
        import.meta.dirname ?? ".",
        "../skills/squid-pipeline/examples/sub-build.yaml"
      );

      const pipeline: Pipeline = {
        name: "test",
        args: { env: { default: "staging" } },
        steps: [
          {
            id: "sub",
            type: "pipeline",
            // Use ${args.env} interpolation syntax instead of $args.env bare ref
            pipeline: { file: subPath, args: { target: "${args.env}" } },
          },
        ],
      };

      const result = await runPipeline(pipeline, { args: { env: "prod" } });
      expect(result.status).toBe("completed");
      const output = result.results.sub.output as Record<string, unknown>;
      expect(output.target).toBe("prod");
      expect(output.artifact).toBe("app-prod.tar.gz");
    });

    it("resolves ${step.json.field} interpolation args to sub-pipeline", async () => {
      const { resolve } = await import("node:path");
      const subPath = resolve(
        import.meta.dirname ?? ".",
        "../skills/squid-pipeline/examples/sub-build.yaml"
      );

      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "setup",
            type: "run",
            run: 'echo \'{"env": "canary"}\'',
          },
          {
            id: "sub",
            type: "pipeline",
            // ${setup.json.env} starts with $ but contains ${...} so must use interpolation
            pipeline: { file: subPath, args: { target: "${setup.json.env}" } },
          },
        ],
      };

      const result = await runPipeline(pipeline);
      expect(result.status).toBe("completed");
      const output = result.results.sub.output as Record<string, unknown>;
      expect(output.target).toBe("canary");
      expect(output.artifact).toBe("app-canary.tar.gz");
    });

    it("dry-run does not execute sub-pipeline", async () => {
      const pipeline: Pipeline = {
        name: "test",
        steps: [
          {
            id: "sub",
            type: "pipeline",
            pipeline: { file: "./nonexistent.yaml" },
          },
        ],
      };

      const result = await runPipeline(pipeline, { mode: "dry-run" });
      expect(result.results.sub.meta?.dryRun).toBe(true);
    });
  });
});
