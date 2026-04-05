/**
 * Squid-Claw Test Harness
 *
 * Provides mock adapters and test utilities for pipeline testing.
 * No real OpenClaw calls needed — everything is mockable.
 *
 * Usage:
 *   import { createTestRunner } from "squid-claw/testing";
 *   const runner = createTestRunner()
 *     .mockSpawn("research", { output: { data: "..." } })
 *     .approveGate("review")
 *     .run(pipeline);
 */

import type {
  OpenClawAdapter,
  SpawnConfig,
  SpawnResult,
  StepResult,
  PipelineContext,
  PipelineHooks,
  Pipeline,
  Step,
  GateConfig,
} from "../core/types.js";
import { runPipeline, type RunOptions, type RunResult } from "../core/runtime.js";

// ─── Test Runner Builder ──────────────────────────────────────────────

export class TestRunner {
  private spawnMocks = new Map<string, MockSpawnHandler>();
  private gateMocks = new Map<string, boolean>();
  private stepOverrides = new Map<string, StepResult>();
  private capturedSteps: Array<{ step: Step; result: StepResult }> = [];
  private runOptions: Partial<RunOptions> = {};

  /**
   * Mock a spawn step by step ID.
   * When the pipeline reaches this step, it returns the mock result
   * instead of calling OpenClaw.
   */
  mockSpawn(
    stepId: string,
    result: Partial<SpawnResult> & { output?: unknown }
  ): this {
    this.spawnMocks.set(stepId, () =>
      Promise.resolve({
        status: "accepted" as const,
        childSessionKey: `mock-session-${stepId}`,
        ...result,
      })
    );
    return this;
  }

  /**
   * Mock a spawn step with a dynamic handler.
   */
  mockSpawnHandler(
    stepId: string,
    handler: MockSpawnHandler
  ): this {
    this.spawnMocks.set(stepId, handler);
    return this;
  }

  /**
   * Auto-approve a gate step.
   */
  approveGate(stepId: string): this {
    this.gateMocks.set(stepId, true);
    return this;
  }

  /**
   * Auto-reject a gate step.
   */
  rejectGate(stepId: string): this {
    this.gateMocks.set(stepId, false);
    return this;
  }

  /**
   * Override any step's result entirely.
   */
  overrideStep(stepId: string, result: Partial<StepResult>): this {
    this.stepOverrides.set(stepId, {
      stepId,
      status: "completed",
      ...result,
    });
    return this;
  }

  /**
   * Set pipeline args.
   */
  withArgs(args: Record<string, unknown>): this {
    this.runOptions.args = args;
    return this;
  }

  /**
   * Set environment variables.
   */
  withEnv(env: Record<string, string>): this {
    this.runOptions.env = env;
    return this;
  }

  /**
   * Execute the pipeline in test mode.
   */
  async run(pipeline: Pipeline): Promise<TestResult> {
    const self = this;
    this.capturedSteps = [];

    const adapter: OpenClawAdapter = {
      async spawn(config: SpawnConfig, ctx: PipelineContext) {
        // Find step ID from context (match by task)
        for (const [stepId, handler] of self.spawnMocks) {
          // Match by step ID presence in context results or by task content
          return handler(config, ctx);
        }
        // Default mock: succeed with empty output
        return {
          status: "accepted" as const,
          childSessionKey: `mock-${Date.now()}`,
          output: { mocked: true },
        };
      },

      /* v8 ignore start -- adapter fallbacks; onSpawn hook intercepts all spawn steps */
      async waitForCompletion(childSessionKey: string) {
        return {
          stepId: "",
          status: "completed" as const,
          output: { sessionKey: childSessionKey, mocked: true },
        };
      },

      async getSessionStatus() {
        return "completed" as const;
      },
      /* v8 ignore stop */
    };

    const hooks: PipelineHooks = {
      onStepStart: async (step, ctx) => {
        // Check for step overrides
        const override = self.stepOverrides.get(step.id);
        if (override) {
          ctx.results.set(step.id, override);
        }
      },

      onStepComplete: async (step, result) => {
        self.capturedSteps.push({ step, result });
      },

      onGateReached: async (step, _gate, _ctx) => {
        const decision = self.gateMocks.get(step.id);
        if (decision != null) return decision;
        // Default: auto-approve in test mode
        return true;
      },

      onSpawn: async (step, config, ctx) => {
        const handler = self.spawnMocks.get(step.id);
        if (handler) return handler(config, ctx);
        return {
          status: "accepted" as const,
          childSessionKey: `mock-${step.id}`,
          output: { mocked: true },
        };
      },
    };

    const result = await runPipeline(pipeline, {
      ...this.runOptions,
      mode: "test",
      adapter,
      hooks,
    });

    return {
      ...result,
      capturedSteps: this.capturedSteps,
      getStepResult: (stepId: string) =>
        this.capturedSteps.find((c) => c.step.id === stepId)?.result,
      assertStepCompleted: (stepId: string) => {
        const step = self.capturedSteps.find((c) => c.step.id === stepId);
        if (!step) throw new Error(`Step '${stepId}' was not executed`);
        if (step.result.status !== "completed") {
          throw new Error(
            `Step '${stepId}' status is '${step.result.status}', expected 'completed'`
          );
        }
      },
      assertStepSkipped: (stepId: string) => {
        const step = self.capturedSteps.find((c) => c.step.id === stepId);
        if (!step) throw new Error(`Step '${stepId}' was not executed`);
        if (step.result.status !== "skipped") {
          throw new Error(
            `Step '${stepId}' status is '${step.result.status}', expected 'skipped'`
          );
        }
      },
    };
  }
}

// ─── Types ────────────────────────────────────────────────────────────

type MockSpawnHandler = (
  config: SpawnConfig,
  ctx: PipelineContext
) => Promise<SpawnResult>;

export interface TestResult extends RunResult {
  capturedSteps: Array<{ step: Step; result: StepResult }>;
  getStepResult: (stepId: string) => StepResult | undefined;
  assertStepCompleted: (stepId: string) => void;
  assertStepSkipped: (stepId: string) => void;
}

// ─── Factory ──────────────────────────────────────────────────────────

export function createTestRunner(): TestRunner {
  return new TestRunner();
}
