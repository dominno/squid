/**
 * Squid YAML/JSON Parser
 *
 * Parses pipeline definition files into typed Pipeline objects.
 * Validates structure and provides clear error messages.
 *
 * KISS: YAML in → typed Pipeline out. No intermediate representations.
 */

import { readFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import type {
  Pipeline,
  Step,
  StepType,
  SpawnConfig,
  GateConfig,
  ParallelConfig,
  LoopConfig,
  BranchConfig,
  PipelineRefConfig,
  RetryConfig,
  RestartConfig,
  ArgDef,
  ErrorStrategy,
} from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────

export function parseFile(filePath: string): Pipeline {
  const absPath = resolve(filePath);
  const ext = extname(absPath).toLowerCase();
  const raw = readFileSync(absPath, "utf-8");

  let pipeline: Pipeline;
  if (ext === ".json") {
    pipeline = parsePipeline(JSON.parse(raw), absPath);
  } else {
    const yaml = loadYaml();
    pipeline = parsePipeline(yaml.parse(raw), absPath);
  }

  // Track source directory for resolving relative sub-pipeline paths
  pipeline.sourceDir = dirname(absPath);
  return pipeline;
}

export function parseString(content: string, format: "yaml" | "json" = "yaml"): Pipeline {
  if (format === "json") {
    return parsePipeline(JSON.parse(content));
  }
  const yaml = loadYaml();
  return parsePipeline(yaml.parse(content));
}

export function parsePipeline(raw: unknown, source?: string): Pipeline {
  if (!raw || typeof raw !== "object") {
    throw new ParseError("Pipeline must be a YAML/JSON object", source);
  }

  const obj = raw as Record<string, unknown>;

  const pipeline: Pipeline = {
    name: requireString(obj, "name", source),
    steps: [],
  };

  if (obj.description != null) pipeline.description = String(obj.description);
  if (obj.version != null) pipeline.version = String(obj.version);
  if (obj.cwd != null) pipeline.cwd = String(obj.cwd);
  if (obj.env != null) pipeline.env = parseEnv(obj.env, source);
  if (obj.args != null) pipeline.args = parseArgs(obj.args, source);
  if (obj.agent != null) pipeline.agent = String(obj.agent);
  if (obj.onError != null) pipeline.onError = parseErrorStrategy(obj.onError, source);

  if (!Array.isArray(obj.steps)) {
    throw new ParseError("Pipeline must have a 'steps' array", source);
  }

  pipeline.steps = obj.steps.map((s: unknown, i: number) =>
    parseStep(s, source, `steps[${i}]`)
  );

  validatePipeline(pipeline, source);
  return pipeline;
}

// ─── Step Parsing ─────────────────────────────────────────────────────

function parseStep(raw: unknown, source?: string, path?: string): Step {
  if (!raw || typeof raw !== "object") {
    throw new ParseError(`Step at ${path} must be an object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const id = requireString(obj, "id", source, path);
  const type = inferStepType(obj, source, path);

  const step: Step = { id, type };

  // Execution config based on type
  switch (type) {
    case "run":
      step.run = String(obj.run ?? obj.command ?? obj.exec);
      break;
    case "spawn":
      step.spawn = parseSpawnConfig(obj.spawn, source, `${path}.spawn`);
      break;
    case "gate":
      step.gate = parseGateConfig(obj.gate, source, `${path}.gate`);
      break;
    case "parallel":
      step.parallel = parseParallelConfig(obj.parallel, source, `${path}.parallel`);
      break;
    case "loop":
      step.loop = parseLoopConfig(obj.loop, source, `${path}.loop`);
      break;
    case "branch":
      step.branch = parseBranchConfig(obj.branch, source, `${path}.branch`);
      break;
    case "transform":
      step.transform = String(obj.transform);
      break;
    case "pipeline":
      step.pipeline = parsePipelineRefConfig(obj.pipeline, source, `${path}.pipeline`);
      break;
  }

  // Optional fields
  if (obj.description != null) step.description = String(obj.description);
  if (obj.input != null) step.input = String(obj.input);
  if (obj.output != null) step.output = String(obj.output);
  if (obj.when != null) step.when = String(obj.when);
  if (obj.timeout != null) step.timeout = validatePositive(obj.timeout, "timeout", source, path);
  if (obj.env != null) step.env = parseEnv(obj.env, source);
  if (obj.cwd != null) step.cwd = String(obj.cwd);
  if (obj.tags != null) step.tags = (obj.tags as string[]).map(String);
  if (obj.meta != null) step.meta = obj.meta as Record<string, unknown>;

  if (obj.retry != null) {
    step.retry = parseRetryConfig(obj.retry, source, `${path}.retry`);
  }

  if (obj.restart != null) {
    step.restart = parseRestartConfig(obj.restart, source, `${path}.restart`);
  }

  return step;
}

const VALID_STEP_TYPES = new Set<StepType>([
  "run", "spawn", "gate", "parallel", "loop", "branch", "transform", "pipeline",
]);

function inferStepType(obj: Record<string, unknown>, source?: string, path?: string): StepType {
  // Explicit type takes precedence
  if (obj.type) {
    if (!VALID_STEP_TYPES.has(obj.type as StepType)) {
      throw new ParseError(
        `Invalid step type '${obj.type}' at ${path}. Must be one of: ${[...VALID_STEP_TYPES].join(", ")}`,
        source
      );
    }
    return obj.type as StepType;
  }

  // Infer from present keys
  if (obj.run != null || obj.command != null || obj.exec != null) return "run";
  if (obj.spawn != null) return "spawn";
  if (obj.gate != null) return "gate";
  if (obj.parallel != null) return "parallel";
  if (obj.loop != null) return "loop";
  if (obj.branch != null) return "branch";
  if (obj.transform != null) return "transform";
  if (obj.pipeline != null) return "pipeline";

  throw new ParseError(
    `Cannot infer step type at ${path}. Provide one of: ${[...VALID_STEP_TYPES].join(", ")}`,
    source
  );
}

// ─── Config Parsers ───────────────────────────────────────────────────

function parseSpawnConfig(raw: unknown, source?: string, path?: string): SpawnConfig {
  if (typeof raw === "string") {
    return { task: raw };
  }

  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be a string or object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: SpawnConfig = {
    task: requireString(obj, "task", source, path),
  };

  if (obj.agent != null) config.agent = String(obj.agent);
  if (obj.agentId != null) config.agentId = String(obj.agentId);
  if (obj.model != null) config.model = String(obj.model);
  if (obj.thinking != null) config.thinking = validateEnum(obj.thinking, ["off", "low", "high"], "thinking", source, path);
  if (obj.runtime != null) config.runtime = validateEnum(obj.runtime, ["subagent", "acp"], "runtime", source, path);
  if (obj.cwd != null) config.cwd = String(obj.cwd);
  if (obj.timeout != null) config.timeout = validatePositive(obj.timeout, "timeout", source, path);
  if (obj.mode != null) config.mode = validateEnum(obj.mode, ["run", "session"], "mode", source, path);
  if (obj.sandbox != null) config.sandbox = validateEnum(obj.sandbox, ["inherit", "require"], "sandbox", source, path);
  if (obj.maxConcurrent != null) config.maxConcurrent = Number(obj.maxConcurrent);
  if (obj.attachments != null && Array.isArray(obj.attachments)) {
    config.attachments = (obj.attachments as Record<string, unknown>[]).map((a) => ({
      name: String(a.name),
      content: String(a.content),
      encoding: a.encoding != null ? a.encoding as "utf8" | "base64" : undefined,
      mimeType: a.mimeType != null ? String(a.mimeType) : undefined,
    }));
  }

  return config;
}

function parseGateConfig(raw: unknown, source?: string, path?: string): GateConfig {
  if (typeof raw === "string") {
    return { prompt: raw };
  }
  if (typeof raw === "boolean") {
    return { prompt: "Approve this step?", autoApprove: raw };
  }

  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be a string, boolean, or object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: GateConfig = {
    prompt: requireString(obj, "prompt", source, path),
  };

  if (obj.items != null) config.items = obj.items as unknown[];
  if (obj.preview != null) config.preview = String(obj.preview);
  if (obj.autoApprove != null) config.autoApprove = Boolean(obj.autoApprove);
  if (obj.timeout != null) config.timeout = Number(obj.timeout);
  if (obj.approvers != null) config.approvers = (obj.approvers as string[]).map(String);
  if (obj.requiredApprovers != null) config.requiredApprovers = (obj.requiredApprovers as string[]).map(String);
  if (obj.allowSelfApproval != null) config.allowSelfApproval = Boolean(obj.allowSelfApproval);
  if (obj.input != null) {
    if (!Array.isArray(obj.input)) {
      throw new ParseError(`${path}.input must be an array of field definitions`, source);
    }
    config.input = (obj.input as Record<string, unknown>[]).map((f, i) => {
      if (!f.name) {
        throw new ParseError(`${path}.input[${i}] must have a 'name' field`, source);
      }
      const fieldType = f.type != null
        ? validateEnum(f.type, ["string", "number", "boolean", "select"], `input[${i}].type`, source, path)
        : "string" as const;
      return {
        name: String(f.name),
        type: fieldType,
        label: f.label != null ? String(f.label) : undefined,
        description: f.description != null ? String(f.description) : undefined,
        required: f.required != null ? Boolean(f.required) : undefined,
        default: f.default,
        options: f.options != null ? (f.options as string[]).map(String) : undefined,
        validation: f.validation != null ? String(f.validation) : undefined,
      };
    });
  }

  return config;
}

function parseParallelConfig(raw: unknown, source?: string, path?: string): ParallelConfig {
  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be an object with 'branches'`, source);
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.branches || typeof obj.branches !== "object") {
    throw new ParseError(`${path}.branches must be an object`, source);
  }

  const branches: Record<string, Step[]> = {};
  for (const [key, value] of Object.entries(obj.branches as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new ParseError(`${path}.branches.${key} must be an array of steps`, source);
    }
    branches[key] = value.map((s, i) => parseStep(s, source, `${path}.branches.${key}[${i}]`));
  }

  const config: ParallelConfig = { branches };

  if (obj.maxConcurrent != null) config.maxConcurrent = Number(obj.maxConcurrent);
  if (obj.failFast != null) config.failFast = Boolean(obj.failFast);
  if (obj.merge != null) config.merge = validateEnum(obj.merge, ["object", "array", "first"], "merge", source, path);

  return config;
}

function parseLoopConfig(raw: unknown, source?: string, path?: string): LoopConfig {
  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be an object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: LoopConfig = {
    over: requireString(obj, "over", source, path),
    steps: [],
  };

  if (!Array.isArray(obj.steps)) {
    throw new ParseError(`${path}.steps must be an array`, source);
  }

  config.steps = obj.steps.map((s, i) => parseStep(s, source, `${path}.steps[${i}]`));

  if (obj.as != null) config.as = String(obj.as);
  if (obj.index != null) config.index = String(obj.index);
  if (obj.maxConcurrent != null) config.maxConcurrent = Number(obj.maxConcurrent);
  if (obj.maxIterations != null) config.maxIterations = Number(obj.maxIterations);
  if (obj.collect != null) config.collect = String(obj.collect);

  return config;
}

function parseBranchConfig(raw: unknown, source?: string, path?: string): BranchConfig {
  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be an object`, source);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.conditions)) {
    throw new ParseError(`${path}.conditions must be an array`, source);
  }

  const config: BranchConfig = {
    conditions: obj.conditions.map((c: unknown, i: number) => {
      const cond = c as Record<string, unknown>;
      if (!cond.when || !Array.isArray(cond.steps)) {
        throw new ParseError(
          `${path}.conditions[${i}] must have 'when' and 'steps'`,
          source
        );
      }
      return {
        when: String(cond.when),
        steps: (cond.steps as unknown[]).map((s, j) =>
          parseStep(s, source, `${path}.conditions[${i}].steps[${j}]`)
        ),
      };
    }),
  };

  if (obj.default != null) {
    if (!Array.isArray(obj.default)) {
      throw new ParseError(`${path}.default must be an array of steps`, source);
    }
    config.default = (obj.default as unknown[]).map((s, i) =>
      parseStep(s, source, `${path}.default[${i}]`)
    );
  }

  return config;
}

function parsePipelineRefConfig(raw: unknown, source?: string, path?: string): PipelineRefConfig {
  // String shorthand: pipeline: "./sub-pipeline.yaml"
  if (typeof raw === "string") {
    return { file: raw };
  }

  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be a string or object with 'file'`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: PipelineRefConfig = {
    file: requireString(obj, "file", source, path),
  };

  if (obj.args != null) {
    if (typeof obj.args !== "object") {
      throw new ParseError(`${path}.args must be an object`, source);
    }
    config.args = obj.args as Record<string, unknown>;
  }
  if (obj.env != null) config.env = parseEnv(obj.env, source);
  if (obj.cwd != null) config.cwd = String(obj.cwd);

  return config;
}

function parseRetryConfig(raw: unknown, source?: string, path?: string): RetryConfig {
  if (typeof raw === "number") {
    return { maxAttempts: raw };
  }

  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be a number or object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: RetryConfig = {
    maxAttempts: Number(obj.maxAttempts ?? obj.max ?? 3),
  };

  if (obj.backoff != null) config.backoff = validateEnum(obj.backoff, ["fixed", "exponential", "exponential-jitter"], "backoff", source, path);
  if (obj.delayMs != null) config.delayMs = Number(obj.delayMs);
  if (obj.maxDelayMs != null) config.maxDelayMs = Number(obj.maxDelayMs);
  if (obj.retryOn != null) config.retryOn = (obj.retryOn as string[]).map(String);

  return config;
}

function parseRestartConfig(raw: unknown, source?: string, path?: string): RestartConfig {
  if (typeof raw === "string") {
    // Shorthand: restart: "step-id" — always restart, max 3
    return { step: raw, when: "true", maxRestarts: 3 };
  }

  if (!raw || typeof raw !== "object") {
    throw new ParseError(`${path} must be a string or object`, source);
  }

  const obj = raw as Record<string, unknown>;
  const config: RestartConfig = {
    step: requireString(obj, "step", source, path),
    when: requireString(obj, "when", source, path),
  };

  if (obj.maxRestarts != null) config.maxRestarts = Number(obj.maxRestarts);

  return config;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function parseArgs(raw: unknown, source?: string): Record<string, ArgDef> {
  if (!raw || typeof raw !== "object") {
    throw new ParseError("'args' must be an object", source);
  }

  const args: Record<string, ArgDef> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      args[key] = { default: value };
    } else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      args[key] = {
        default: v.default,
        description: v.description != null ? String(v.description) : undefined,
        required: v.required != null ? Boolean(v.required) : undefined,
        type: v.type as ArgDef["type"],
      };
    } else {
      args[key] = { default: value };
    }
  }
  return args;
}

function parseEnv(raw: unknown, source?: string): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    throw new ParseError("'env' must be an object", source);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    env[key] = String(value);
  }
  return env;
}

function parseErrorStrategy(raw: unknown, source?: string): ErrorStrategy {
  const val = String(raw);
  if (val === "fail" || val === "skip" || val === "continue") return val;
  throw new ParseError(
    `Invalid onError strategy: '${val}'. Must be 'fail', 'skip', or 'continue'`,
    source
  );
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  source?: string,
  path?: string
): string {
  if (obj[key] == null) {
    throw new ParseError(
      `Missing required field '${key}'${path ? ` at ${path}` : ""}`,
      source
    );
  }
  return String(obj[key]);
}

function validateEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  source?: string,
  path?: string
): T[number] {
  const str = String(value);
  if (!allowed.includes(str)) {
    throw new ParseError(
      `Invalid value '${str}' for ${field}${path ? ` at ${path}` : ""}. Must be one of: ${allowed.join(", ")}`,
      source
    );
  }
  return str as T[number];
}

function validatePositive(
  value: unknown,
  field: string,
  source?: string,
  path?: string
): number {
  const num = Number(value);
  if (isNaN(num) || num <= 0) {
    throw new ParseError(
      `${field}${path ? ` at ${path}` : ""} must be a positive number, got '${value}'`,
      source
    );
  }
  return num;
}

// ─── Validation ───────────────────────────────────────────────────────

function validatePipeline(pipeline: Pipeline, source?: string): void {
  const ids = new Set<string>();

  function validateSteps(steps: Step[], scope: string) {
    for (const step of steps) {
      if (ids.has(step.id)) {
        throw new ParseError(
          `Duplicate step id '${step.id}' in ${scope}`,
          source
        );
      }
      ids.add(step.id);

      // Recursively validate nested steps
      if (step.parallel?.branches) {
        for (const [key, branchSteps] of Object.entries(step.parallel.branches)) {
          validateSteps(branchSteps, `${scope}.parallel.${key}`);
        }
      }
      if (step.loop?.steps) {
        validateSteps(step.loop.steps, `${scope}.loop`);
      }
      if (step.branch?.conditions) {
        for (const cond of step.branch.conditions) {
          validateSteps(cond.steps, `${scope}.branch`);
        }
        if (step.branch.default) {
          validateSteps(step.branch.default, `${scope}.branch.default`);
        }
      }
    }
  }

  validateSteps(pipeline.steps, pipeline.name);
}

// ─── Errors ───────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string, public source?: string) {
    super(source ? `${message} (in ${source})` : message);
    this.name = "ParseError";
  }
}

// ─── Lazy YAML loader ─────────────────────────────────────────────────

let _yaml: typeof import("yaml") | null = null;
function loadYaml() {
  if (!_yaml) {
    const require = createRequire(import.meta.url);
    _yaml = require("yaml") as typeof import("yaml");
  }
  return _yaml;
}
