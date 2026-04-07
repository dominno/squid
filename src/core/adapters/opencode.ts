/**
 * OpenCode Agent Adapter
 *
 * Spawns sub-agents via OpenCode CLI (`opencode`).
 * Each spawn step becomes an `opencode run --message "task"` invocation.
 *
 * Uses async execution (non-blocking) to support parallel spawns.
 *
 * Requires: OpenCode CLI installed and configured.
 * Env: OPENCODE_MODEL (optional model override)
 */

import { execAsync, shellEscape } from "../async-exec.js";
import { parseAgentOutput } from "../json-extract.js";
import type { AgentAdapter, SpawnConfig, SpawnResult, StepResult, PipelineContext } from "../types.js";

export function createOpenCodeAdapter(config: {
  bin?: string;
  defaultModel?: string;
} = {}): AgentAdapter {
  const bin = config.bin ?? "opencode";
  const defaultModel = config.defaultModel ?? process.env.OPENCODE_MODEL;

  return {
    name: "opencode",

    async spawn(spawnConfig: SpawnConfig, ctx: PipelineContext): Promise<SpawnResult> {
      const args: string[] = ["run", "--message", spawnConfig.task];

      // Model override
      const model = spawnConfig.model ?? defaultModel;
      if (model) {
        args.push("--model", model);
      }

      const cwd = spawnConfig.cwd ?? ctx.cwd;

      try {
        const result = await execAsync(bin, args, {
          cwd,
          timeoutMs: (spawnConfig.timeout ?? 600) * 1000,
        });

        const output = parseAgentOutput(result.stdout);

        return {
          status: "accepted",
          output,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; exitCode?: number };
        return {
          status: "error",
          error: error.message ?? `opencode exited with code ${error.exitCode}`,
        };
      }
    },

    async waitForCompletion(): Promise<StepResult> {
      return {
        stepId: "",
        status: "completed",
        output: { note: "opencode adapter: spawn completed asynchronously" },
      };
    },

    async getSessionStatus(): Promise<"completed"> {
      return "completed";
    },
  };
}
