/**
 * Agent Adapter Registry
 *
 * Central registry for pluggable agent runtimes.
 * Built-in: openclaw, claude-code, opencode.
 * Custom: register your own via registerAdapter().
 */

import type { AgentAdapter } from "../types.js";

const adapters = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): AgentAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}

/**
 * Resolve which adapter to use for a spawn step.
 * Priority: step.agent → pipeline.agent → env SQUID_AGENT → "openclaw"
 */
export function resolveAdapter(
  stepAgent?: string,
  pipelineAgent?: string
): AgentAdapter {
  const name =
    stepAgent ??
    pipelineAgent ??
    process.env.SQUID_AGENT ??
    "openclaw";

  const adapter = adapters.get(name);
  if (!adapter) {
    const available = listAdapters().join(", ");
    throw new Error(
      `Agent adapter '${name}' not found. Available: ${available || "none (register one first)"}`
    );
  }
  return adapter;
}
