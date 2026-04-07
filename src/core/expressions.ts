/**
 * Expression Evaluator
 *
 * Resolves references like $stepId.json, $args.key, $env.VAR
 * and evaluates conditions for when/branch/loop directives.
 *
 * KISS: Simple reference resolution + safe expression evaluation.
 * No full JS eval — just property access, comparisons, and boolean logic.
 */

import type { PipelineContext, StepResult } from "./types.js";

// ─── Reference Resolution ─────────────────────────────────────────────

/**
 * Resolve a reference string to its value from pipeline context.
 *
 * Supported patterns:
 *   $stepId.json    → Parsed JSON output of step
 *   $stepId.stdout  → Raw stdout of step
 *   $stepId.status  → Status string
 *   $args.key       → Pipeline argument
 *   $env.VAR        → Environment variable
 *   $state.key      → User state
 *   $item           → Current loop item
 *   $index          → Current loop index
 *   literal         → Returned as-is
 */
export function resolveRef(ref: string, ctx: PipelineContext): unknown {
  if (!ref.startsWith("$")) return ref;

  const parts = ref.slice(1).split(".");
  const root = parts[0];
  const path = parts.slice(1);

  let value: unknown;

  switch (root) {
    case "args":
      value = ctx.args;
      break;
    case "env":
      value = ctx.env;
      break;
    case "state":
      value = Object.fromEntries(ctx.state);
      break;
    case "item":
      value = ctx.state.get("__loop_item");
      return path.length ? getNestedValue(value, path) : value;
    case "index":
      return ctx.state.get("__loop_index");
    default: {
      // $stepId.json | $stepId.stdout | $stepId.status
      const result = ctx.results.get(root);
      if (!result) return undefined;
      return resolveStepRef(result, path);
    }
  }

  return path.length ? getNestedValue(value, path) : value;
}

function resolveStepRef(result: StepResult, path: string[]): unknown {
  if (path.length === 0) return result.output ?? result.stdout;

  switch (path[0]) {
    case "json":
    case "output":
      return path.length > 1
        ? getNestedValue(result.output, path.slice(1))
        : result.output;
    case "stdout":
      return result.stdout;
    case "stderr":
      return result.stderr;
    case "status":
      return result.status;
    case "approved":
      return result.status === "completed" && result.meta?.approved === true;
    case "skipped":
      return result.status === "skipped";
    case "error":
      return result.error?.message;
    case "duration":
      return result.duration;
    case "childSessionKey":
      return result.childSessionKey;
    default:
      return getNestedValue(result.output, path);
  }
}

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current == null) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─── Template String Interpolation ────────────────────────────────────

/**
 * Interpolate ${...} references in a string.
 * E.g., "Hello ${args.name}, step ${fetch.status}" → resolved values.
 */
export function interpolate(template: string, ctx: PipelineContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const value = resolveRef(`$${expr.trim()}`, ctx);
    return value == null ? "" : String(value);
  });
}

// ─── Condition Evaluation ─────────────────────────────────────────────

/**
 * Evaluate a condition expression to a boolean.
 *
 * Supported:
 *   $step.approved           → boolean
 *   $step.status == "done"   → equality
 *   $step.status != "failed" → inequality
 *   $args.count > 5          → numeric comparison
 *   $step.json.ready         → truthy check
 *   true / false             → literals
 *   !$step.skipped           → negation
 *   $a.ready && $b.ready     → AND
 *   $a.ready || $b.ready     → OR
 */
export function evaluateCondition(expr: string, ctx: PipelineContext): boolean {
  const trimmed = expr.trim();

  // Literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // AND
  if (trimmed.includes("&&")) {
    return trimmed.split("&&").every((part) => evaluateCondition(part, ctx));
  }

  // OR
  if (trimmed.includes("||")) {
    return trimmed.split("||").some((part) => evaluateCondition(part, ctx));
  }

  // Negation
  if (trimmed.startsWith("!")) {
    return !evaluateCondition(trimmed.slice(1), ctx);
  }

  // Comparison operators
  const compMatch = trimmed.match(
    /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/
  );
  if (compMatch) {
    const leftRaw = compMatch[1].trim();
    const left = leftRaw.includes("${")
      ? parseValue(interpolate(leftRaw, ctx))
      : resolveRef(leftRaw, ctx);
    const op = compMatch[2];
    const rightRaw = compMatch[3].trim();
    const right = rightRaw.includes("${")
      ? parseValue(interpolate(rightRaw, ctx))
      : rightRaw.startsWith("$")
        ? resolveRef(rightRaw, ctx)
        : parseValue(rightRaw);
    return compare(left, op, right);
  }

  // Truthy check on a reference
  const value = resolveRef(trimmed, ctx);
  return isTruthy(value);
}

function parseValue(raw: string): unknown {
  // Strip quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "null" || raw === "undefined") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!isNaN(num)) return num;
  return raw;
}

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==": return left == right;
    case "!=": return left != right;
    case ">":  return Number(left) > Number(right);
    case "<":  return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    default: return false;
  }
}

function isTruthy(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
