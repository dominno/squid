/**
 * Claude Code Agent Adapter
 *
 * Spawns sub-agents via Claude Code CLI (`claude`).
 * Each spawn step becomes a `claude -p "task" --output-format json` invocation.
 *
 * Uses async execution (non-blocking) to support parallel spawns.
 *
 * Requires: Claude Code CLI installed and authenticated.
 * Env: CLAUDE_MODEL (optional model override)
 */

import { execAsync, shellEscape } from "../async-exec.js";
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
      const args: string[] = ["-p", spawnConfig.task, "--output-format", "json"];

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

        let output: unknown = result.stdout.trim();
        try {
          const parsed = JSON.parse(result.stdout.trim());
          // Claude Code --output-format json wraps result in envelope:
          // { "type": "result", "result": "actual output", ... }
          // Extract the inner result if present
          if (parsed && typeof parsed === "object" && "result" in parsed && parsed.type === "result") {
            const inner = (parsed as Record<string, unknown>).result;
            // Try to parse the inner result as JSON too (it's often a JSON string)
            if (typeof inner === "string") {
              try {
                output = JSON.parse(inner);
              } catch {
                output = inner;
              }
            } else {
              output = inner;
            }
          } else {
            output = parsed;
          }
        } catch {
          // Not JSON — keep as string
        }

        return {
          status: "accepted",
          output,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; exitCode?: number };
        return {
          status: "error",
          error: error.message ?? `claude exited with code ${error.exitCode}`,
        };
      }
    },

    async waitForCompletion(): Promise<StepResult> {
      return {
        stepId: "",
        status: "completed",
        output: { note: "claude-code adapter: spawn completed asynchronously" },
      };
    },

    async getSessionStatus(): Promise<"completed"> {
      return "completed";
    },
  };
}
