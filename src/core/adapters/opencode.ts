/**
 * OpenCode Agent Adapter
 *
 * Spawns sub-agents via OpenCode CLI (`opencode`).
 * Each spawn step becomes an `opencode run` invocation.
 *
 * Requires: OpenCode CLI installed and configured.
 * Env: OPENCODE_MODEL (optional model override)
 */

import { execSync } from "node:child_process";
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
      const args: string[] = ["run"];

      // Task as inline message
      args.push("--message", shellEscape(spawnConfig.task));

      // Model override
      const model = spawnConfig.model ?? defaultModel;
      if (model) {
        args.push("--model", model);
      }

      // Working directory
      const cwd = spawnConfig.cwd ?? ctx.cwd;

      try {
        const stdout = execSync(
          `${bin} ${args.join(" ")}`,
          {
            encoding: "utf-8",
            timeout: (spawnConfig.timeout ?? 600) * 1000,
            cwd,
            maxBuffer: 50 * 1024 * 1024,
          }
        );

        let output: unknown = stdout.trim();
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          // Not JSON — keep as string
        }

        return {
          status: "accepted",
          output,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; status?: number };
        return {
          status: "error",
          error: error.message ?? `opencode exited with status ${error.status}`,
        };
      }
    },

    async waitForCompletion(): Promise<StepResult> {
      return {
        stepId: "",
        status: "completed",
        output: { note: "opencode adapter: spawn completed synchronously" },
      };
    },

    async getSessionStatus(): Promise<"completed"> {
      return "completed";
    },
  };
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
