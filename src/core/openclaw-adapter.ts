/**
 * OpenClaw Adapter
 *
 * Real integration with OpenClaw's sessions_spawn API.
 * Supports two modes:
 *   1. Gateway HTTP API (OPENCLAW_URL + OPENCLAW_TOKEN)
 *   2. CLI invocation (openclaw agent --inline)
 *
 * The adapter maps Squid-Claw's SpawnConfig to OpenClaw's SessionsSpawnToolSchema:
 *
 *   Squid-Claw SpawnConfig  →  OpenClaw sessions_spawn
 *   ─────────────────────────────────────────────────────
 *   task                    →  task
 *   agentId                 →  agentId
 *   model                   →  model
 *   thinking                →  thinking
 *   runtime                 →  runtime ("subagent" | "acp")
 *   cwd                     →  cwd
 *   timeout                 →  runTimeoutSeconds
 *   mode                    →  mode ("run" | "session")
 *   sandbox                 →  sandbox ("inherit" | "require")
 *   attachments             →  attachments
 */

import { execSync } from "node:child_process";
import type {
  OpenClawAdapter,
  SpawnConfig,
  SpawnResult,
  StepResult,
  PipelineContext,
} from "./types.js";

// ─── Configuration ────────────────────────────────────────────────────

export interface OpenClawConfig {
  /** Gateway URL (e.g., http://localhost:3000) */
  url?: string;
  /** Auth token */
  token?: string;
  /** How to invoke: "http" for gateway API, "cli" for openclaw CLI */
  mode?: "http" | "cli";
  /** Path to openclaw binary (default: "openclaw") */
  cliBin?: string;
  /** Default poll interval for waiting (ms) */
  pollIntervalMs?: number;
  /** Default spawn timeout (ms) */
  defaultTimeoutMs?: number;
}

// ─── Factory ──────────────────────────────────────────────────────────

export function createOpenClawAdapter(
  config: OpenClawConfig = {}
): OpenClawAdapter {
  const resolvedConfig = resolveConfig(config);

  if (resolvedConfig.mode === "cli") {
    return createCliAdapter(resolvedConfig);
  }

  return createHttpAdapter(resolvedConfig);
}

// ─── HTTP Adapter (Gateway API) ───────────────────────────────────────

function createHttpAdapter(config: ResolvedConfig): OpenClawAdapter {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (config.token) h["Authorization"] = `Bearer ${config.token}`;
    return h;
  };

  return {
    async spawn(spawnConfig: SpawnConfig): Promise<SpawnResult> {
      const payload = mapToSessionsSpawn(spawnConfig);

      const response = await fetch(`${config.url}/api/sessions/spawn`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          status: "error",
          error: `HTTP ${response.status}: ${body}`,
        };
      }

      const data = await response.json() as Record<string, unknown>;
      return {
        status: (data.status as SpawnResult["status"]) ?? "accepted",
        childSessionKey: data.childSessionKey as string | undefined,
        runId: data.runId as string | undefined,
        output: data.output,
        error: data.error as string | undefined,
      };
    },

    async waitForCompletion(
      childSessionKey: string,
      timeoutMs?: number
    ): Promise<StepResult> {
      const timeout = timeoutMs ?? config.defaultTimeoutMs;
      const deadline = Date.now() + timeout;
      const pollInterval = config.pollIntervalMs;

      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `${config.url}/api/sessions/${childSessionKey}/status`,
            {
              headers: headers(),
              signal: AbortSignal.timeout(10_000),
            }
          );

          if (response.ok) {
            const data = await response.json() as Record<string, unknown>;
            const status = data.status as string;

            if (status === "done" || status === "completed") {
              return {
                stepId: "",
                status: "completed",
                output: data.output ?? data.result,
              };
            }
            if (status === "failed" || status === "error" || status === "killed") {
              return {
                stepId: "",
                status: "failed",
                error: {
                  message: (data.error as string) ?? `Session ${childSessionKey} ${status}`,
                },
              };
            }
            if (status === "timeout") {
              return {
                stepId: "",
                status: "failed",
                error: { message: `Session ${childSessionKey} timed out` },
              };
            }
          }
        } catch {
          // Network error — retry on next poll
        }

        await sleep(pollInterval);
      }

      return {
        stepId: "",
        status: "failed",
        error: { message: `Timeout (${timeout}ms) waiting for session ${childSessionKey}` },
      };
    },

    async getSessionStatus(sessionKey: string) {
      try {
        const response = await fetch(
          `${config.url}/api/sessions/${sessionKey}/status`,
          {
            headers: headers(),
            signal: AbortSignal.timeout(10_000),
          }
        );

        if (!response.ok) return "failed";

        const data = await response.json() as Record<string, unknown>;
        const status = data.status as string;

        const statusMap: Record<string, StepResult["status"]> = {
          running: "running",
          done: "completed",
          completed: "completed",
          failed: "failed",
          error: "failed",
          killed: "failed",
          timeout: "failed",
        };

        return statusMap[status] ?? "pending";
      } catch {
        return "failed";
      }
    },
  };
}

// ─── CLI Adapter ──────────────────────────────────────────────────────

function createCliAdapter(config: ResolvedConfig): OpenClawAdapter {
  const bin = config.cliBin;

  return {
    async spawn(spawnConfig: SpawnConfig): Promise<SpawnResult> {
      const args: string[] = ["agent", "--inline"];

      if (spawnConfig.agentId) args.push("--agent", spawnConfig.agentId);
      if (spawnConfig.model) args.push("--model", spawnConfig.model);
      if (spawnConfig.cwd) args.push("--cwd", spawnConfig.cwd);
      if (spawnConfig.timeout) args.push("--timeout", String(spawnConfig.timeout));

      // Pass task as the inline message
      args.push("--message", spawnConfig.task);

      try {
        const stdout = execSync(
          `${bin} ${args.map(shellEscape).join(" ")}`,
          {
            encoding: "utf-8",
            timeout: (spawnConfig.timeout ?? 600) * 1000,
            env: {
              ...process.env,
              ...(config.token ? { OPENCLAW_TOKEN: config.token } : {}),
            },
          }
        );

        let output: unknown = stdout.trim();
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          // Not JSON
        }

        return {
          status: "accepted",
          output,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; status?: number };
        return {
          status: "error",
          error: error.message ?? `CLI exited with status ${error.status}`,
        };
      }
    },

    async waitForCompletion(_childSessionKey: string): Promise<StepResult> {
      // CLI mode is synchronous — spawn already waited
      return {
        stepId: "",
        status: "completed",
        output: { note: "CLI mode: spawn completed synchronously" },
      };
    },

    async getSessionStatus(_sessionKey: string) {
      return "completed" as const;
    },
  };
}

// ─── Payload Mapping ──────────────────────────────────────────────────

/**
 * Maps Squid-Claw SpawnConfig to OpenClaw sessions_spawn tool schema.
 */
function mapToSessionsSpawn(config: SpawnConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    task: config.task,
  };

  if (config.agentId) payload.agentId = config.agentId;
  if (config.model) payload.model = config.model;
  if (config.thinking) payload.thinking = config.thinking;
  if (config.runtime) payload.runtime = config.runtime;
  if (config.cwd) payload.cwd = config.cwd;
  if (config.timeout) payload.runTimeoutSeconds = config.timeout;
  if (config.mode) payload.mode = config.mode;
  if (config.sandbox) payload.sandbox = config.sandbox;

  if (config.attachments?.length) {
    payload.attachments = config.attachments.map((a) => ({
      name: a.name,
      content: a.content,
      encoding: a.encoding ?? "utf8",
      mimeType: a.mimeType,
    }));
  }

  return payload;
}

// ─── Config Resolution ────────────────────────────────────────────────

interface ResolvedConfig {
  url: string;
  token: string;
  mode: "http" | "cli";
  cliBin: string;
  pollIntervalMs: number;
  defaultTimeoutMs: number;
}

function resolveConfig(config: OpenClawConfig): ResolvedConfig {
  const url = config.url
    ?? process.env.OPENCLAW_URL
    ?? process.env.CLAWD_URL
    ?? "http://localhost:3000";

  const token = config.token
    ?? process.env.OPENCLAW_TOKEN
    ?? process.env.CLAWD_TOKEN
    ?? "";

  // Auto-detect mode: if no URL is set but openclaw binary exists, use CLI
  let mode = config.mode;
  if (!mode) {
    if (config.url || process.env.OPENCLAW_URL || process.env.CLAWD_URL) {
      mode = "http";
    } else {
      try {
        execSync("which openclaw", { encoding: "utf-8" });
        mode = "cli";
      } catch {
        mode = "http"; // Fallback, will error on spawn if URL is localhost default
      }
    }
  }

  return {
    url,
    token,
    mode,
    cliBin: config.cliBin ?? "openclaw",
    pollIntervalMs: config.pollIntervalMs ?? 2000,
    defaultTimeoutMs: config.defaultTimeoutMs ?? 600_000,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
