/**
 * Gate Utilities
 *
 * Short approval IDs, structured input validation, caller identity checks.
 */

import { randomBytes } from "node:crypto";
import type { GateConfig, GateInputField } from "./types.js";

// ─── Short Approval IDs ──────────────────────────────────────────────

const shortIdStore = new Map<string, string>(); // shortId → full token

export function generateShortId(): string {
  return randomBytes(4).toString("hex"); // 8 hex chars
}

export function registerShortId(shortId: string, fullToken: string): void {
  shortIdStore.set(shortId, fullToken);
}

export function resolveShortId(shortId: string): string | undefined {
  return shortIdStore.get(shortId);
}

export function clearShortIds(): void {
  shortIdStore.clear();
}

// ─── Structured Input Validation ─────────────────────────────────────

export interface GateValidationResult {
  valid: boolean;
  errors: string[];
  values: Record<string, unknown>;
}

export function validateGateInput(
  fields: GateInputField[],
  input: Record<string, unknown>
): GateValidationResult {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};

  for (const field of fields) {
    const value = input[field.name];
    const isRequired = field.required !== false; // default true

    // Check required
    if (value === undefined || value === null || value === "") {
      if (isRequired) {
        if (field.default !== undefined) {
          values[field.name] = field.default;
          continue;
        }
        errors.push(`Field '${field.name}' is required`);
        continue;
      }
      values[field.name] = field.default;
      continue;
    }

    // Type check
    switch (field.type) {
      case "string": {
        if (typeof value !== "string") {
          errors.push(`Field '${field.name}' must be a string`);
          break;
        }
        if (field.validation) {
          const regex = new RegExp(field.validation);
          if (!regex.test(value)) {
            errors.push(
              `Field '${field.name}' does not match pattern: ${field.validation}`
            );
            break;
          }
        }
        values[field.name] = value;
        break;
      }
      case "number": {
        const num = typeof value === "number" ? value : Number(value);
        if (isNaN(num)) {
          errors.push(`Field '${field.name}' must be a number`);
          break;
        }
        values[field.name] = num;
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") {
          values[field.name] = value;
        } else if (value === "true" || value === "1") {
          values[field.name] = true;
        } else if (value === "false" || value === "0") {
          values[field.name] = false;
        } else {
          errors.push(`Field '${field.name}' must be a boolean`);
        }
        break;
      }
      case "select": {
        if (!field.options || !field.options.includes(String(value))) {
          errors.push(
            `Field '${field.name}' must be one of: ${(field.options ?? []).join(", ")}`
          );
          break;
        }
        values[field.name] = String(value);
        break;
      }
      default:
        values[field.name] = value;
    }
  }

  return { valid: errors.length === 0, errors, values };
}

// ─── Caller Identity ─────────────────────────────────────────────────

export function validateApprover(
  gate: GateConfig,
  approverId?: string,
  initiatedBy?: string
): { allowed: boolean; reason?: string } {
  // Check self-approval
  if (
    approverId &&
    initiatedBy &&
    approverId === initiatedBy &&
    gate.allowSelfApproval === false
  ) {
    return { allowed: false, reason: "Self-approval is not allowed" };
  }

  // Check required approvers
  if (gate.requiredApprovers && gate.requiredApprovers.length > 0) {
    if (!approverId) {
      return { allowed: false, reason: "Approver identity is required" };
    }
    if (!gate.requiredApprovers.includes(approverId)) {
      return {
        allowed: false,
        reason: `'${approverId}' is not in requiredApprovers: ${gate.requiredApprovers.join(", ")}`,
      };
    }
  }

  return { allowed: true };
}
