/**
 * Claude Code Agent Adapter
 *
 * Spawns sub-agents via Claude Code CLI (`claude`).
 * Each spawn step becomes a `claude -p "task"` invocation.
 *
 * Requires: Claude Code CLI installed and authenticated.
 * Env: CLAUDE_MODEL (optional model override)
 */

import { execSync } from "node:child_process";
import type { AgentAdapter, SpawnConfig, SpawnResult, StepResult, PipelineContext } from "../types.js";

export function createClaudeCodeAdapter(config: {
  bin?: string;
  defaultModel?: string;
} = {}): AgentAdapter {
  const bin = config.bin ?? "claude";
  const defaultModel = config.defaultModel ?? process.env.CLAUDE_MODEL;

  return {
    name: "claude-code",

    async spawn(spawnConfig: SpawnConfig, ctx: PipelineContext): Promise<SpawnResult> {
      const args: string[] = ["-p"];

      // Task as the prompt
      args.push(shellEscape(spawnConfig.task));

      // Model override
      const model = spawnConfig.model ?? defaultModel;
      if (model) {
        args.push("--model", model);
      }

      // Working directory
      const cwd = spawnConfig.cwd ?? ctx.cwd;

      // Output format
      args.push("--output-format", "json");

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
          error: error.message ?? `claude exited with status ${error.status}`,
        };
      }
    },

    async waitForCompletion(): Promise<StepResult> {
      // Claude Code CLI is synchronous — spawn already waited
      return {
        stepId: "",
        status: "completed",
        output: { note: "claude-code adapter: spawn completed synchronously" },
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
