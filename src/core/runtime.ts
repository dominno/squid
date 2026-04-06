/**
 * Squid Pipeline Runtime
 *
 * Executes parsed Pipeline definitions step-by-step.
 * Handles: sequential flow, parallel branches, loops, gates,
 * spawning sub-agents via OpenClaw, retries, and resume.
 *
 * SOLID:
 *   - Single Responsibility: Runtime only executes; parsing is separate.
 *   - Open/Closed: New step types via StepExecutor map, not runtime changes.
 *   - Dependency Inversion: OpenClawAdapter injected, not hardcoded.
 *
 * DRY: Retry logic is reusable across all step types.
 * KISS: Linear step execution with well-defined branching primitives.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Pipeline,
  Step,
  StepResult,
  StepError,
  PipelineContext,
  PipelineHooks,
  PipelineEventEmitter,
  GateDecision,
  AgentAdapter,
  OpenClawAdapter,
  SpawnConfig,
  RetryConfig,
  ResumeToken,
  ExecutionMode,
  ErrorStrategy,
} from "./types.js";
import { resolveRef, evaluateCondition, interpolate } from "./expressions.js";
import { parseFile } from "./parser.js";
import { resolveAdapter } from "./adapters/registry.js";
import { createNoopEmitter, createEvent } from "./events.js";
import { generateShortId, registerShortId, validateGateInput, validateApprover } from "./gate-utils.js";

// ─── Public API ───────────────────────────────────────────────────────

export interface RunOptions {
  args?: Record<string, unknown>;
  env?: Record<string, string>;
  cwd?: string;
  mode?: ExecutionMode;
  /** @deprecated Use the adapter registry instead: registerAdapter() + pipeline.agent / spawn.agent */
  adapter?: AgentAdapter;
  hooks?: PipelineHooks;
  signal?: AbortSignal;
  resumeToken?: ResumeToken;
  initiatedBy?: string;            // Who started this pipeline run
  events?: PipelineEventEmitter;   // Custom event emitter (default: noop)
}

export interface RunResult {
  pipelineId: string;
  runId: string;
  status: "completed" | "failed" | "halted" | "cancelled";
  results: Record<string, StepResult>;
  output?: unknown;
  resumeToken?: ResumeToken;
  error?: string;
  duration: number;
}

export async function runPipeline(
  pipeline: Pipeline,
  options: RunOptions = {}
): Promise<RunResult> {
  const startTime = Date.now();
  const runId = randomUUID();

  // Resolve args: defaults ← provided
  const args = resolveArgs(pipeline, options.args ?? {});

  // Build context
  const events = options.events ?? createNoopEmitter();

  const ctx: PipelineContext = {
    pipelineId: pipeline.name,
    runId,
    args,
    env: { ...process.env as Record<string, string>, ...pipeline.env, ...options.env },
    cwd: options.cwd ?? pipeline.cwd ?? process.cwd(),
    sourceDir: pipeline.sourceDir,
    agent: pipeline.agent,
    initiatedBy: options.initiatedBy,
    results: new Map(),
    state: new Map(),
    mode: options.mode ?? "run",
    signal: options.signal,
    hooks: options.hooks ?? {},
    events,
  };

  // Wire up agent adapter (legacy single adapter or per-step via registry)
  const adapter = options.adapter ?? createDefaultAdapter();

  // Resume: restore completed results
  let startIndex = 0;
  if (options.resumeToken) {
    const token = options.resumeToken;
    for (const [id, result] of Object.entries(token.completedResults)) {
      ctx.results.set(id, result);
    }
    startIndex = pipeline.steps.findIndex((s) => s.id === token.resumeAtStep);
    if (startIndex === -1) startIndex = 0;

    // Apply gate decision if resuming from a gate
    if (token.gateDecision != null) {
      const gateStep = pipeline.steps[startIndex];
      if (gateStep) {
        const gateResult: StepResult = {
          stepId: gateStep.id,
          status: token.gateDecision ? "completed" : "skipped",
          output: {
            approved: token.gateDecision,
            ...(token.gateInput ? { input: token.gateInput } : {}),
            ...(token.approvedBy ? { approvedBy: token.approvedBy } : {}),
          },
          meta: {
            approved: token.gateDecision,
            ...(token.approvedBy ? { approvedBy: token.approvedBy } : {}),
          },
        };
        ctx.results.set(gateStep.id, gateResult);
        startIndex++;
      }
    }
  }

  await ctx.hooks.onPipelineStart?.(pipeline, ctx);
  events.emit(createEvent("pipeline:start", pipeline.name, runId, undefined, undefined, { args, mode: ctx.mode }));

  let finalStatus: RunResult["status"] = "completed";
  let resumeToken: ResumeToken | undefined;
  let lastError: string | undefined;

  // Track restart counts per step to enforce maxRestarts
  const restartCounts = new Map<string, number>();

  // Build step index lookup for restart jumps
  const stepIndexMap = new Map<string, number>();
  for (let idx = 0; idx < pipeline.steps.length; idx++) {
    stepIndexMap.set(pipeline.steps[idx].id, idx);
  }

  try {
    for (let i = startIndex; i < pipeline.steps.length; i++) {
      // Check abort
      if (ctx.signal?.aborted) {
        finalStatus = "cancelled";
        break;
      }

      const step = pipeline.steps[i];
      const result = await executeStep(step, ctx, adapter, pipeline.onError);

      if (result.status === "waiting_approval") {
        // Create resume token with short ID and halt
        const gateShortId = result.meta?.shortId as string | undefined;
        resumeToken = {
          version: 1,
          pipelineId: pipeline.name,
          runId,
          resumeAtStep: step.id,
          completedResults: Object.fromEntries(ctx.results),
          args,
          initiatedBy: ctx.initiatedBy,
          shortId: gateShortId,
          createdAt: Date.now(),
        };
        // Register short ID for lookup
        if (gateShortId) {
          const { encodeResumeToken } = await import("./resume.js");
          registerShortId(gateShortId, encodeResumeToken(resumeToken));
        }
        finalStatus = "halted";
        break;
      }

      if (result.status === "failed" && pipeline.onError !== "continue") {
        finalStatus = "failed";
        lastError = result.error?.message;
        if (pipeline.onError !== "skip") break;
      }

      // ─── Restart: jump back to a previous step ─────────
      if (step.restart && evaluateCondition(step.restart.when, ctx)) {
        const targetId = step.restart.step;
        const targetIndex = stepIndexMap.get(targetId);
        if (targetIndex == null) {
          throw new Error(
            `Restart target step '${targetId}' not found in pipeline '${pipeline.name}'`
          );
        }
        if (targetIndex >= i) {
          throw new Error(
            `Restart target '${targetId}' must be before current step '${step.id}' (forward jumps not allowed)`
          );
        }

        const maxRestarts = step.restart.maxRestarts ?? 3;
        const count = (restartCounts.get(step.id) ?? 0) + 1;
        restartCounts.set(step.id, count);

        if (count > maxRestarts) {
          // Exhausted restarts — continue forward
          result.meta = {
            ...result.meta,
            restartExhausted: true,
            restartCount: count - 1,
          };
          ctx.results.set(step.id, result);
          continue;
        }

        // Clear results for steps that will re-execute
        for (let j = targetIndex; j <= i; j++) {
          ctx.results.delete(pipeline.steps[j].id);
        }

        // Jump back (the for-loop will increment i, so set to targetIndex - 1)
        i = targetIndex - 1;
      }
    }
  } catch (err) {
    finalStatus = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }

  await ctx.hooks.onPipelineComplete?.(pipeline, ctx.results, ctx);
  events.emit(createEvent("pipeline:complete", pipeline.name, runId, undefined, undefined, {
    status: finalStatus, duration: Date.now() - startTime,
  }));

  // Determine final output from last completed step
  const lastResult = findLastCompletedResult(pipeline.steps, ctx.results);

  return {
    pipelineId: pipeline.name,
    runId,
    status: finalStatus,
    results: Object.fromEntries(ctx.results),
    output: lastResult?.output,
    resumeToken,
    error: lastError,
    duration: Date.now() - startTime,
  };
}

// ─── Step Execution ───────────────────────────────────────────────────

async function executeStep(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter,
  onError?: ErrorStrategy
): Promise<StepResult> {
  // Condition check
  if (step.when && !evaluateCondition(step.when, ctx)) {
    const result: StepResult = {
      stepId: step.id,
      status: "skipped",
      meta: { reason: "condition_false" },
    };
    ctx.results.set(step.id, result);
    await ctx.hooks.onStepComplete?.(step, result, ctx);
    ctx.events.emit(createEvent("step:skip", ctx.pipelineId, ctx.runId, step.id, step.type, { reason: "condition_false" }));
    return result;
  }

  await ctx.hooks.onStepStart?.(step, ctx);
  ctx.events.emit(createEvent("step:start", ctx.pipelineId, ctx.runId, step.id, step.type));

  const startedAt = Date.now();
  let result: StepResult;

  try {
    // Apply retry wrapper if configured
    if (step.retry) {
      result = await withRetry(step, step.retry, ctx, adapter);
    } else {
      result = await executeStepOnce(step, ctx, adapter);
    }
  } catch (err) {
    const error: StepError = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      retryable: false,
    };

    result = {
      stepId: step.id,
      status: "failed",
      error,
      startedAt,
      completedAt: Date.now(),
      duration: Date.now() - startedAt,
    };

    if (onError === "skip") {
      result.status = "skipped";
      result.meta = { reason: "error_skipped" };
    }

    await ctx.hooks.onStepError?.(step, error, ctx);
    ctx.events.emit(createEvent("step:error", ctx.pipelineId, ctx.runId, step.id, step.type, { error: error.message }));
  }

  result.startedAt = startedAt;
  result.completedAt = Date.now();
  result.duration = result.completedAt - startedAt;

  ctx.results.set(step.id, result);
  await ctx.hooks.onStepComplete?.(step, result, ctx);
  ctx.events.emit(createEvent("step:complete", ctx.pipelineId, ctx.runId, step.id, step.type, {
    status: result.status, duration: result.duration,
  }));

  return result;
}

async function executeStepOnce(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  switch (step.type) {
    case "run":
      return executeRun(step, ctx);
    case "spawn":
      return executeSpawn(step, ctx, adapter);
    case "gate":
      return executeGate(step, ctx);
    case "parallel":
      return executeParallel(step, ctx, adapter);
    case "loop":
      return executeLoop(step, ctx, adapter);
    case "branch":
      return executeBranch(step, ctx, adapter);
    case "transform":
      return executeTransform(step, ctx);
    case "pipeline":
      return executePipelineRef(step, ctx, adapter);
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

// ─── Run (Shell Command) ──────────────────────────────────────────────

async function executeRun(step: Step, ctx: PipelineContext): Promise<StepResult> {
  const command = interpolate(step.run!, ctx);
  const cwd = step.cwd ?? ctx.cwd;

  if (ctx.mode === "dry-run") {
    return {
      stepId: step.id,
      status: "completed",
      output: { command, dryRun: true },
      meta: { dryRun: true },
    };
  }

  // Sandbox mode: never execute — use onRun hook or return empty mock
  if (ctx.mode === "sandbox") {
    const hookResult = await ctx.hooks.onRun?.(step, command, ctx);
    if (hookResult) return { ...hookResult, stepId: step.id };
    return {
      stepId: step.id,
      status: "completed",
      output: { command, sandbox: true },
      meta: { sandbox: true },
    };
  }

  // onRun hook: if provided and returns a result, use it instead of executing
  // (allows mocking specific run steps in integration mode)
  if (ctx.hooks.onRun) {
    const hookResult = await ctx.hooks.onRun(step, command, ctx);
    if (hookResult) return { ...hookResult, stepId: step.id };
  }

  const execOpts: ExecSyncOptions = {
    cwd,
    env: { ...ctx.env, ...step.env },
    timeout: (step.timeout ?? 300) * 1000,
    maxBuffer: 50 * 1024 * 1024,
    encoding: "utf-8",
  };

  try {
    const stdout = execSync(command, execOpts) as unknown as string;
    const trimmed = stdout?.trim() ?? "";

    let output: unknown = trimmed;
    try {
      output = JSON.parse(trimmed);
    } catch {
      // Not JSON, keep as string
    }

    return {
      stepId: step.id,
      status: "completed",
      output,
      stdout: trimmed,
    };
  } catch (err: unknown) {
    const execError = err as { stderr?: string; message?: string; status?: number };
    throw new Error(
      `Command failed (exit ${execError.status}): ${execError.stderr ?? execError.message}`
    );
  }
}

// ─── Spawn (OpenClaw sessions_spawn) ──────────────────────────────────

async function executeSpawn(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const config = step.spawn!;

  // Interpolate task description
  const resolvedConfig: SpawnConfig = {
    ...config,
    task: interpolate(config.task, ctx),
    cwd: config.cwd ? interpolate(config.cwd, ctx) : ctx.cwd,
  };

  if (ctx.mode === "dry-run") {
    return {
      stepId: step.id,
      status: "completed",
      output: { spawn: resolvedConfig, dryRun: true },
      meta: { dryRun: true },
    };
  }

  if (ctx.mode === "test") {
    // In test mode, use the hook to provide mock spawn
    const hookResult = await ctx.hooks.onSpawn?.(step, resolvedConfig, ctx);
    if (hookResult) {
      return {
        stepId: step.id,
        status: hookResult.status === "accepted" ? "completed" : "failed",
        output: hookResult.output,
        childSessionKey: hookResult.childSessionKey,
        error: hookResult.error
          ? { message: hookResult.error }
          : undefined,
      };
    }
  }

  // Resolve adapter: step.agent → pipeline.agent → legacy adapter
  let resolvedAdapter = adapter;
  if (config.agent || ctx.agent) {
    try {
      resolvedAdapter = resolveAdapter(config.agent, ctx.agent);
    } catch {
      // Fall through to legacy adapter if registry has no match
    }
  }

  const spawnResult = await resolvedAdapter.spawn(resolvedConfig, ctx);

  if (spawnResult.status !== "accepted") {
    return {
      stepId: step.id,
      status: "failed",
      error: { message: spawnResult.error ?? `Spawn ${spawnResult.status}` },
    };
  }

  // Wait for completion
  if (spawnResult.childSessionKey) {
    const timeout = (config.timeout ?? 600) * 1000;
    const completionResult = await resolvedAdapter.waitForCompletion(
      spawnResult.childSessionKey,
      timeout
    );
    return {
      ...completionResult,
      stepId: step.id,
      childSessionKey: spawnResult.childSessionKey,
    };
  }

  return {
    stepId: step.id,
    status: "completed",
    output: spawnResult.output,
    childSessionKey: spawnResult.childSessionKey,
  };
}

// ─── Gate (Approval) ──────────────────────────────────────────────────

async function executeGate(
  step: Step,
  ctx: PipelineContext
): Promise<StepResult> {
  const gate = step.gate!;

  // Check hook for programmatic approval (takes priority over auto-approve)
  if (ctx.hooks.onGateReached) {
    const hookResult = await ctx.hooks.onGateReached(step, gate, ctx);

    // Hook can return boolean (legacy) or GateDecision (structured)
    const decision: GateDecision = typeof hookResult === "boolean"
      ? { approved: hookResult }
      : hookResult;

    // Validate caller identity if configured
    if (decision.approved && (gate.requiredApprovers || gate.allowSelfApproval === false)) {
      const identity = validateApprover(gate, decision.approvedBy, ctx.initiatedBy);
      if (!identity.allowed) {
        return {
          stepId: step.id,
          status: "skipped",
          output: { approved: false, reason: identity.reason },
          meta: { approved: false, identityRejected: true, reason: identity.reason },
        };
      }
    }

    // Validate structured input if configured
    if (decision.approved && gate.input && decision.input) {
      const validation = validateGateInput(gate.input, decision.input);
      if (!validation.valid) {
        return {
          stepId: step.id,
          status: "skipped",
          output: { approved: false, validationErrors: validation.errors },
          meta: { approved: false, validationErrors: validation.errors },
        };
      }
      decision.input = validation.values; // use validated/coerced values
    }

    const eventType = decision.approved ? "gate:approved" : "gate:rejected";
    ctx.events.emit(createEvent(eventType, ctx.pipelineId, ctx.runId, step.id, "gate", {
      approvedBy: decision.approvedBy, hasInput: !!decision.input,
    }));

    return {
      stepId: step.id,
      status: decision.approved ? "completed" : "skipped",
      output: {
        approved: decision.approved,
        ...(decision.input ? { input: decision.input } : {}),
        ...(decision.approvedBy ? { approvedBy: decision.approvedBy } : {}),
      },
      meta: {
        approved: decision.approved,
        ...(decision.approvedBy ? { approvedBy: decision.approvedBy } : {}),
      },
    };
  }

  // Auto-approve in test/dry-run mode
  if (ctx.mode === "test" || ctx.mode === "dry-run" || gate.autoApprove) {
    ctx.events.emit(createEvent("gate:approved", ctx.pipelineId, ctx.runId, step.id, "gate", { autoApproved: true }));
    return {
      stepId: step.id,
      status: "completed",
      output: { approved: true },
      meta: { approved: true, autoApproved: true },
    };
  }

  // Generate short approval ID
  const shortId = generateShortId();

  ctx.events.emit(createEvent("gate:waiting", ctx.pipelineId, ctx.runId, step.id, "gate", {
    prompt: interpolate(gate.prompt, ctx), shortId, hasInput: !!gate.input,
  }));

  // Halt for external approval (resume token)
  return {
    stepId: step.id,
    status: "waiting_approval",
    output: {
      prompt: interpolate(gate.prompt, ctx),
      shortId,
      items: gate.items,
      preview: gate.preview ? interpolate(gate.preview, ctx) : undefined,
      ...(gate.input ? { inputFields: gate.input } : {}),
      ...(gate.requiredApprovers ? { requiredApprovers: gate.requiredApprovers } : {}),
    },
    meta: { gate: true, shortId },
  };
}

// ─── Parallel (Fan-out / Fan-in) ──────────────────────────────────────

async function executeParallel(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const config = step.parallel!;
  const branchEntries = Object.entries(config.branches);
  const maxConcurrent = config.maxConcurrent ?? branchEntries.length;
  const failFast = config.failFast ?? true;

  const results: Record<string, unknown> = {};
  const errors: StepError[] = [];
  const controller = new AbortController();

  // Execute branches with concurrency limit
  const semaphore = createSemaphore(maxConcurrent);

  const branchPromises = branchEntries.map(
    async ([branchName, branchSteps]) => {
      await semaphore.acquire();
      try {
        if (controller.signal.aborted) return;

        for (const branchStep of branchSteps) {
          if (controller.signal.aborted) return;

          const result = await executeStep(branchStep, ctx, adapter);
          if (result.status === "failed" && failFast) {
            controller.abort();
            errors.push(result.error!);
            return;
          }
        }

        // Collect last step's output for this branch
        const lastStep = branchSteps[branchSteps.length - 1];
        if (lastStep) {
          const lastResult = ctx.results.get(lastStep.id);
          results[branchName] = lastResult?.output;
        }
      } finally {
        semaphore.release();
      }
    }
  );

  await Promise.allSettled(branchPromises);

  if (errors.length > 0) {
    return {
      stepId: step.id,
      status: "failed",
      error: errors[0],
      output: results,
    };
  }

  // Merge results based on strategy
  let output: unknown;
  switch (config.merge) {
    case "array":
      output = Object.values(results);
      break;
    case "first":
      output = Object.values(results)[0];
      break;
    case "object":
    default:
      output = results;
  }

  return {
    stepId: step.id,
    status: "completed",
    output,
  };
}

// ─── Loop ─────────────────────────────────────────────────────────────

async function executeLoop(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const config = step.loop!;

  // Resolve the iterable
  const items = resolveRef(config.over, ctx);
  if (!Array.isArray(items)) {
    throw new Error(
      `Loop 'over' must resolve to an array, got ${typeof items} for '${config.over}'`
    );
  }

  const maxIterations = config.maxIterations ?? 1000;
  const iteratorVar = config.as ?? "item";
  const indexVar = config.index ?? "index";
  const collected: unknown[] = [];

  const maxConcurrent = config.maxConcurrent ?? 1;

  if (maxConcurrent <= 1) {
    // Sequential loop
    for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
      if (ctx.signal?.aborted) break;

      ctx.state.set("__loop_item", items[i]);
      ctx.state.set("__loop_index", i);
      ctx.state.set(iteratorVar, items[i]);
      ctx.state.set(indexVar, i);

      let lastOutput: unknown;
      for (const loopStep of config.steps) {
        // Create scoped step ID to avoid collision
        const scopedStep = {
          ...loopStep,
          id: `${loopStep.id}_${i}`,
        };
        const result = await executeStep(scopedStep, ctx, adapter);
        if (result.status === "failed") {
          return {
            stepId: step.id,
            status: "failed",
            error: result.error,
            output: collected,
          };
        }
        lastOutput = result.output;
      }
      collected.push(lastOutput);
    }
  } else {
    // Parallel loop with concurrency limit
    const semaphore = createSemaphore(maxConcurrent);
    const promises = items.slice(0, maxIterations).map(async (item, i) => {
      await semaphore.acquire();
      try {
        // Create isolated context for loop iteration
        const loopCtx: PipelineContext = {
          ...ctx,
          state: new Map(ctx.state),
          results: new Map(ctx.results),
        };
        loopCtx.state.set("__loop_item", item);
        loopCtx.state.set("__loop_index", i);
        loopCtx.state.set(iteratorVar, item);
        loopCtx.state.set(indexVar, i);

        let lastOutput: unknown;
        for (const loopStep of config.steps) {
          const scopedStep = { ...loopStep, id: `${loopStep.id}_${i}` };
          const result = await executeStep(scopedStep, loopCtx, adapter);
          lastOutput = result.output;

          // Propagate results back to main context
          ctx.results.set(scopedStep.id, result);
        }
        return lastOutput;
      } finally {
        semaphore.release();
      }
    });

    const results = await Promise.all(promises);
    collected.push(...results);
  }

  // Clean up loop variables
  ctx.state.delete("__loop_item");
  ctx.state.delete("__loop_index");

  return {
    stepId: step.id,
    status: "completed",
    output: collected,
  };
}

// ─── Branch (Conditional Routing) ─────────────────────────────────────

async function executeBranch(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const config = step.branch!;

  // Find first matching condition
  for (const condition of config.conditions) {
    if (evaluateCondition(condition.when, ctx)) {
      return executeSubSteps(step.id, condition.steps, ctx, adapter);
    }
  }

  // Default branch
  if (config.default) {
    return executeSubSteps(step.id, config.default, ctx, adapter);
  }

  return {
    stepId: step.id,
    status: "skipped",
    meta: { reason: "no_matching_branch" },
  };
}

async function executeSubSteps(
  parentId: string,
  steps: Step[],
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  let lastResult: StepResult | undefined;

  for (const subStep of steps) {
    lastResult = await executeStep(subStep, ctx, adapter);
    if (lastResult.status === "failed" || lastResult.status === "waiting_approval") {
      return { ...lastResult, stepId: parentId };
    }
  }

  return {
    stepId: parentId,
    status: "completed",
    output: lastResult?.output,
  };
}

// ─── Transform ────────────────────────────────────────────────────────

function executeTransform(step: Step, ctx: PipelineContext): StepResult {
  const expr = step.transform!;

  // Resolve input (available to interpolation via context)
  if (step.input) resolveRef(step.input, ctx);

  // Safe expression evaluation (no eval!)
  // Supports: JSON path access, basic array/object ops
  let output: unknown;

  if (expr.startsWith("$")) {
    // Reference resolution
    output = resolveRef(expr, ctx);
  } else if (expr.startsWith("{") || expr.startsWith("[")) {
    // JSON template with interpolation
    const resolved = interpolate(expr, ctx);
    try {
      output = JSON.parse(resolved);
    } catch {
      output = resolved;
    }
  } else {
    // String template
    output = interpolate(expr, ctx);
  }

  return {
    stepId: step.id,
    status: "completed",
    output,
  };
}

// ─── Pipeline Ref (Sub-Pipeline) ──────────────────────────────────────

async function executePipelineRef(
  step: Step,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const config = step.pipeline!;

  // Resolve file path relative to the parent pipeline's source directory,
  // falling back to cwd if the pipeline was created programmatically.
  const { resolve: resolvePath } = await import("node:path");
  const baseDir = config.cwd ?? ctx.sourceDir ?? ctx.cwd;
  const filePath = resolvePath(baseDir, interpolate(config.file, ctx));

  // Resolve args — values can be $refs
  const subArgs: Record<string, unknown> = {};
  if (config.args) {
    for (const [key, value] of Object.entries(config.args)) {
      if (typeof value === "string" && value.startsWith("$")) {
        subArgs[key] = resolveRef(value, ctx);
      } else if (typeof value === "string" && value.includes("${")) {
        subArgs[key] = interpolate(value, ctx);
      } else {
        subArgs[key] = value;
      }
    }
  }

  if (ctx.mode === "dry-run") {
    return {
      stepId: step.id,
      status: "completed",
      output: { pipeline: filePath, args: subArgs, dryRun: true },
      meta: { dryRun: true },
    };
  }

  // Parse and run the sub-pipeline
  const subPipeline = parseFile(filePath);

  const subResult = await runPipeline(subPipeline, {
    args: subArgs,
    env: { ...ctx.env, ...config.env },
    cwd: config.cwd ?? ctx.cwd,
    mode: ctx.mode,
    adapter,
    hooks: ctx.hooks,
    signal: ctx.signal,
  });

  // Map sub-pipeline result to step result
  if (subResult.status === "failed") {
    return {
      stepId: step.id,
      status: "failed",
      output: subResult.output,
      error: { message: subResult.error ?? `Sub-pipeline '${subPipeline.name}' failed` },
      meta: {
        subPipelineId: subResult.pipelineId,
        subRunId: subResult.runId,
        subDuration: subResult.duration,
      },
    };
  }

  if (subResult.status === "halted") {
    // Propagate the halt — the parent pipeline also halts
    return {
      stepId: step.id,
      status: "waiting_approval",
      output: subResult.output,
      meta: {
        subPipelineId: subResult.pipelineId,
        subRunId: subResult.runId,
        subResumeToken: subResult.resumeToken,
      },
    };
  }

  return {
    stepId: step.id,
    status: "completed",
    output: subResult.output,
    meta: {
      subPipelineId: subResult.pipelineId,
      subRunId: subResult.runId,
      subDuration: subResult.duration,
      subResults: subResult.results,
    },
  };
}

// ─── Retry Wrapper ────────────────────────────────────────────────────

async function withRetry(
  step: Step,
  config: RetryConfig,
  ctx: PipelineContext,
  adapter: AgentAdapter
): Promise<StepResult> {
  const maxAttempts = config.maxAttempts;
  const backoff = config.backoff ?? "exponential-jitter";
  const baseDelay = config.delayMs ?? 1000;
  const maxDelay = config.maxDelayMs ?? 30000;

  let lastError: StepError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeStepOnce(step, ctx, adapter);

      if (result.status !== "failed") {
        result.attempts = attempt;
        return result;
      }

      lastError = result.error;

      // Check if error matches retryOn patterns
      if (config.retryOn && lastError) {
        const shouldRetry = config.retryOn.some(
          (pattern) =>
            lastError!.message.includes(pattern) ||
            lastError!.code === pattern
        );
        if (!shouldRetry) {
          result.attempts = attempt;
          return result;
        }
      }
    } catch (err) {
      lastError = {
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }

    // Backoff before next attempt
    if (attempt < maxAttempts) {
      const delay = calculateDelay(attempt, backoff, baseDelay, maxDelay);
      await sleep(delay);
    }
  }

  return {
    stepId: step.id,
    status: "failed",
    error: lastError ?? { message: `Failed after ${maxAttempts} attempts` },
    attempts: maxAttempts,
  };
}

function calculateDelay(
  attempt: number,
  backoff: RetryConfig["backoff"],
  baseDelay: number,
  maxDelay: number
): number {
  switch (backoff) {
    case "fixed":
      return Math.min(baseDelay, maxDelay);
    case "exponential":
      return Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
    case "exponential-jitter":
    default: {
      const exponential = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * exponential * 0.5;
      return Math.min(exponential + jitter, maxDelay);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function resolveArgs(
  pipeline: Pipeline,
  provided: Record<string, unknown>
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  if (pipeline.args) {
    for (const [key, def] of Object.entries(pipeline.args)) {
      if (provided[key] !== undefined) {
        args[key] = provided[key];
      } else if (def.default !== undefined) {
        args[key] = def.default;
      } else if (def.required) {
        throw new Error(`Missing required argument: ${key}`);
      }
    }
  }

  // Pass through any extra args
  for (const [key, value] of Object.entries(provided)) {
    if (!(key in args)) {
      args[key] = value;
    }
  }

  return args;
}

function findLastCompletedResult(
  steps: Step[],
  results: Map<string, StepResult>
): StepResult | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const result = results.get(steps[i].id);
    if (result && result.status === "completed") return result;
  }
  return undefined;
}

function createSemaphore(max: number) {
  let current = 0;
  const queue: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      return new Promise((resolve) => {
        if (current < max) {
          current++;
          resolve();
        } else {
          queue.push(resolve);
        }
      });
    },
    release() {
      current--;
      const next = queue.shift();
      if (next) {
        current++;
        next();
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Default OpenClaw Adapter ─────────────────────────────────────────

function createDefaultAdapter(): AgentAdapter {
  return {
    name: "openclaw",
    async spawn(config: SpawnConfig): Promise<{
      status: "accepted" | "forbidden" | "error";
      childSessionKey?: string;
      output?: unknown;
      error?: string;
    }> {
      // Default: call OpenClaw CLI via shell
      const url = process.env.OPENCLAW_URL ?? process.env.CLAWD_URL;
      const token = process.env.OPENCLAW_TOKEN ?? process.env.CLAWD_TOKEN;

      if (!url) {
        throw new Error(
          "OPENCLAW_URL not set. Provide an OpenClawAdapter or set OPENCLAW_URL env var."
        );
      }

      const payload = {
        task: config.task,
        agentId: config.agentId,
        model: config.model,
        thinking: config.thinking,
        runtime: config.runtime ?? "subagent",
        cwd: config.cwd,
        runTimeoutSeconds: config.timeout,
        mode: config.mode ?? "run",
        sandbox: config.sandbox,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(`${url}/api/sessions/spawn`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return {
          status: "error",
          error: `HTTP ${response.status}: ${await response.text()}`,
        };
      }

      return await response.json() as {
        status: "accepted" | "forbidden" | "error";
        childSessionKey?: string;
        output?: unknown;
        error?: string;
      };
    },

    async waitForCompletion(
      childSessionKey: string,
      timeoutMs = 600_000
    ): Promise<StepResult> {
      const url = process.env.OPENCLAW_URL ?? process.env.CLAWD_URL;
      if (!url) throw new Error("OPENCLAW_URL not set");

      const token = process.env.OPENCLAW_TOKEN ?? process.env.CLAWD_TOKEN;
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const deadline = Date.now() + timeoutMs;
      const pollInterval = 2000;

      while (Date.now() < deadline) {
        const response = await fetch(
          `${url}/api/sessions/${childSessionKey}/status`,
          { headers }
        );

        if (response.ok) {
          const data = await response.json() as {
            status: string;
            output?: unknown;
          };
          if (data.status === "done" || data.status === "completed") {
            return {
              stepId: "",
              status: "completed",
              output: data.output,
            };
          }
          if (data.status === "failed" || data.status === "error") {
            return {
              stepId: "",
              status: "failed",
              error: { message: `Spawned session failed: ${childSessionKey}` },
            };
          }
        }

        await sleep(pollInterval);
      }

      return {
        stepId: "",
        status: "failed",
        error: { message: `Timeout waiting for session ${childSessionKey}` },
      };
    },

    /* v8 ignore start -- getSessionStatus is not called in pipeline flow; used for external polling */
    async getSessionStatus(sessionKey: string) {
      const url = process.env.OPENCLAW_URL ?? process.env.CLAWD_URL;
      if (!url) throw new Error("OPENCLAW_URL not set");

      const token = process.env.OPENCLAW_TOKEN ?? process.env.CLAWD_TOKEN;
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(
        `${url}/api/sessions/${sessionKey}/status`,
        { headers }
      );

      if (!response.ok) return "failed" as const;

      const data = await response.json() as { status: string };
      return (data.status ?? "pending") as "pending" | "running" | "completed" | "failed";
    },
    /* v8 ignore stop */
  };
}
