/**
 * Auto-register built-in agent adapters.
 * Call this once at startup to make "openclaw", "claude-code", "opencode" available.
 */

import { registerAdapter } from "./registry.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createOpenCodeAdapter } from "./opencode.js";
import { createOpenClawAdapter } from "../openclaw-adapter.js";

let initialized = false;

export function setupBuiltinAdapters(): void {
  if (initialized) return;
  initialized = true;

  // Register OpenClaw (default)
  registerAdapter(createOpenClawAdapter());

  // Register Claude Code
  registerAdapter(createClaudeCodeAdapter());

  // Register OpenCode
  registerAdapter(createOpenCodeAdapter());
}
