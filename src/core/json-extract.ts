/**
 * Robust JSON extraction from agent output.
 *
 * Agents (OpenClaw, Claude Code, OpenCode) often return JSON wrapped in:
 *   - Markdown code fences: ```json\n{...}\n```
 *   - Prose with embedded JSON objects
 *   - Raw JSON (ideal case)
 *
 * This module extracts valid JSON from any of these formats.
 */

/**
 * Try to parse raw output as JSON. Falls back to extracting JSON from
 * markdown fences or embedded objects in prose.
 *
 * @returns Parsed JSON value, or the original string if no JSON found.
 */
export function parseAgentOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // 1. Try direct JSON parse (fast path)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not raw JSON — try extraction
  }

  // 2. Try markdown fence extraction
  const fenced = extractFromFence(trimmed);
  if (fenced !== undefined) return fenced;

  // 3. Try embedded JSON object extraction
  const embedded = extractFirstObject(trimmed);
  if (embedded !== undefined) return embedded;

  // 4. Give up — return raw string
  return trimmed;
}

/**
 * Extract JSON from markdown code fences.
 * Handles: ```json ... ```, ``` ... ```, ```JSON ... ```
 */
function extractFromFence(raw: string): unknown | undefined {
  const match = raw.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (!match) return undefined;

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return undefined;
  }
}

/**
 * Extract the first valid JSON object {...} from a string.
 * Handles nested braces correctly.
 */
function extractFirstObject(raw: string): unknown | undefined {
  const start = raw.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") depth--;
    if (depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}
