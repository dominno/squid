/**
 * OpenClaw Agent Adapter
 *
 * Spawns sub-agents via the OpenClaw CLI:
 *   openclaw agent --agent <agentId> --json --message "Use sessions_spawn tool with: task=..."
 *
 * The CLI approach is required because sessions_spawn is an agent tool,
 * not a REST endpoint — it's only callable during an agent turn.
 *
 * Supports:
 *   - Agent ID targeting (--agent)
 *   - Timeout (--timeout)
 *   - JSON output parsing (--json)
 *   - Async execution (non-blocking)
 */

import { execAsync, shellEscape } from "./async-exec.js";
import { parseAgentOutput } from "./json-extract.js";
import type {
  AgentAdapter,
  SpawnConfig,
  SpawnResult,
  StepResult,
  PipelineContext,
} from "./types.js";

// ─── Configuration ────────────────────────────────────────────────────

export interface OpenClawConfig {
  /** Path to openclaw binary (default: "openclaw") */
  bin?: string;
  /** Default agent to use (default: "main") */
  defaultAgent?: string;
  /** Default spawn timeout (seconds) */
  defaultTimeoutSeconds?: number;
}

// ─── Factory ──────────────────────────────────────────────────────────

export function createOpenClawAdapter(config: OpenClawConfig = {}): AgentAdapter {
  const bin = config.bin ?? "openclaw";
  const defaultAgent = config.defaultAgent ?? "main";
  const defaultTimeout = config.defaultTimeoutSeconds ?? 600;

  return {
    name: "openclaw",

    async spawn(spawnConfig: SpawnConfig, ctx: PipelineContext): Promise<SpawnResult> {
      const agentId = spawnConfig.agentId ?? defaultAgent;
      const timeout = spawnConfig.timeout ?? defaultTimeout;

      // Build the sessions_spawn instruction for the agent
      const spawnInstruction = buildSpawnInstruction(spawnConfig);

      const args: string[] = [
        "agent",
        "--agent", agentId,
        "--json",
        "--timeout", String(timeout),
      ];

      // Pass thinking level directly to OpenClaw CLI
      if (spawnConfig.thinking) {
        args.push("--thinking", spawnConfig.thinking);
      }

      args.push("--message", spawnInstruction);

      try {
        const result = await execAsync(bin, args, {
          cwd: spawnConfig.cwd ?? ctx.cwd,
          timeoutMs: (timeout + 30) * 1000, // extra 30s buffer over agent timeout
        });

        // openclaw agent --json writes to stderr, not stdout
        const rawOutput = result.stdout.trim() || result.stderr.trim();

        // Extract agent response from OpenClaw JSON envelope:
        // The output contains log lines + a JSON object with { payloads: [{ text: "..." }], meta: {...} }
        // The agent's actual response is in payloads[0].text
        const output = extractOpenClawResponse(rawOutput);

        // Try to extract session key from output
        const childSessionKey = extractSessionKey(rawOutput);

        return {
          status: "accepted",
          output,
          childSessionKey,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; exitCode?: number; stderr?: string };
        return {
          status: "error",
          error: error.stderr?.trim() || error.message || `openclaw exited with code ${error.exitCode}`,
        };
      }
    },

    async waitForCompletion(_childSessionKey: string): Promise<StepResult> {
      // CLI mode: the openclaw agent command blocks until completion
      // so by the time spawn() returns, the agent has already finished
      return {
        stepId: "",
        status: "completed",
        output: { note: "openclaw CLI: agent completed during spawn" },
      };
    },

    /* v8 ignore start */
    async getSessionStatus(_sessionKey: string) {
      return "completed" as const;
    },
    /* v8 ignore stop */
  };
}

// ─── Instruction Builder ──────────────────────────────────────────────

/**
 * Build the message that tells the OpenClaw agent to use sessions_spawn.
 * The agent will call the tool during its turn.
 */
function buildSpawnInstruction(config: SpawnConfig): string {
  const parts: string[] = [
    `Use the sessions_spawn tool with the following parameters:`,
    `task: ${config.task}`,
  ];

  if (config.runtime) parts.push(`runtime: ${config.runtime}`);
  if (config.mode) parts.push(`mode: ${config.mode}`);
  if (config.model) parts.push(`model: ${config.model}`);
  if (config.thinking) parts.push(`thinking: ${config.thinking}`);
  if (config.sandbox) parts.push(`sandbox: ${config.sandbox}`);
  if (config.timeout) parts.push(`runTimeoutSeconds: ${config.timeout}`);

  parts.push(`\nReturn the full output from the spawned session.`);

  return parts.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract the agent's actual response from OpenClaw CLI output.
 *
 * openclaw agent --json writes to stderr with format:
 *   <log lines...>
 *   { "payloads": [{ "text": "agent response" }], "meta": {...} }
 *
 * The agent's response text is in payloads[0].text.
 * We extract that text, then parse it as JSON if possible.
 */
function extractOpenClawResponse(raw: string): unknown {
  // Find the JSON envelope in the output (skip leading log lines)
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return parseAgentOutput(raw);

  try {
    // Find the matching closing brace for the top-level object
    let depth = 0;
    for (let i = jsonStart; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") depth--;
      if (depth === 0) {
        const envelope = JSON.parse(raw.slice(jsonStart, i + 1));

        // Extract agent text from payloads[0].text
        const payloads = envelope?.payloads;
        if (Array.isArray(payloads) && payloads.length > 0) {
          const agentText = payloads[payloads.length - 1]?.text ?? "";
          return parseAgentOutput(agentText);
        }

        // Fallback: try the whole envelope
        return parseAgentOutput(JSON.stringify(envelope));
      }
    }
  } catch {
    // JSON parse failed — fall through
  }

  // Final fallback
  return parseAgentOutput(raw);
}

/**
 * Try to extract a session key from the agent output.
 * Looks for patterns like "agent:main:subagent:<uuid>"
 */
function extractSessionKey(output: string): string | undefined {
  const match = output.match(/agent:[^:\s]+:subagent:[0-9a-f-]+/i);
  return match?.[0];
}
