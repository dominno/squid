/**
 * YAML Test Runner
 *
 * Runs pipeline tests defined in .test.yaml files.
 * Supports sandbox (nothing executes) and integration (run steps execute) modes.
 *
 * Usage:
 *   squid test deploy.test.yaml
 *   squid test                    # finds all *.test.yaml files
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { parseFile } from "../core/parser.js";
import { runPipeline, type RunResult } from "../core/runtime.js";
import type {
  Pipeline,
  Step,
  StepResult,
  SpawnConfig,
  SpawnResult,
  PipelineContext,
  PipelineHooks,
  AgentAdapter,
  ExecutionMode,
} from "../core/types.js";

// ─── Test File Schema ─────────────────────────────────────────────────

export interface TestFile {
  pipeline: string;                  // Path to pipeline YAML (relative to test file)
  tests: TestCase[];
}

export interface TestCase {
  name: string;                      // Test name
  mode?: "sandbox" | "integration";  // Default: sandbox
  args?: Record<string, unknown>;    // Pipeline arguments
  env?: Record<string, string>;      // Environment overrides
  mocks?: {
    run?: Record<string, MockRunResult>;     // stepId → mock output
    spawn?: Record<string, MockSpawnResult>; // stepId → mock output
  };
  gates?: Record<string, boolean>;   // stepId → approve/reject
  assert: TestAssertions;
}

export interface MockRunResult {
  output?: unknown;
  stdout?: string;
  status?: "completed" | "failed";
  error?: string;
}

export interface MockSpawnResult {
  output?: unknown;
  status?: "accepted" | "error";
  error?: string;
}

export interface TestAssertions {
  status?: "completed" | "failed" | "halted" | "cancelled";
  steps?: Record<string, StepAssertion>;
  output?: unknown;                  // Assert on final pipeline output
}

export type StepAssertion =
  | "completed"
  | "failed"
  | "skipped"
  | { status: string }
  | { output: unknown }
  | { outputContains: string }
  | { outputPath: string; equals: unknown };

// ─── Test Results ─────────────────────────────────────────────────────

export interface TestSuiteResult {
  file: string;
  pipeline: string;
  total: number;
  passed: number;
  failed: number;
  results: TestCaseResult[];
  duration: number;
}

export interface TestCaseResult {
  name: string;
  passed: boolean;
  errors: string[];
  duration: number;
}

// ─── Runner ───────────────────────────────────────────────────────────

export async function runTestFile(testFilePath: string): Promise<TestSuiteResult> {
  const absPath = resolve(testFilePath);
  const testDir = dirname(absPath);
  const startTime = Date.now();

  // Parse test file
  const raw = readFileSync(absPath, "utf-8");
  const yaml = loadYaml();
  const testFile = yaml.parse(raw) as TestFile;

  if (!testFile.pipeline) {
    throw new Error(`Test file must have a 'pipeline' field: ${absPath}`);
  }
  if (!Array.isArray(testFile.tests) || testFile.tests.length === 0) {
    throw new Error(`Test file must have a 'tests' array: ${absPath}`);
  }

  // Load pipeline
  const pipelinePath = resolve(testDir, testFile.pipeline);
  const pipeline = parseFile(pipelinePath);

  const results: TestCaseResult[] = [];

  for (const testCase of testFile.tests) {
    const caseResult = await runTestCase(pipeline, testCase);
    results.push(caseResult);
  }

  return {
    file: absPath,
    pipeline: pipelinePath,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
    duration: Date.now() - startTime,
  };
}

async function runTestCase(
  pipeline: Pipeline,
  testCase: TestCase
): Promise<TestCaseResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const mode: ExecutionMode = testCase.mode ?? "sandbox";

  // Build hooks from mocks
  const hooks = buildHooks(testCase);

  // Build mock adapter
  const adapter: AgentAdapter = {
    name: "test-yaml",
    async spawn() {
      return { status: "accepted", output: { mocked: true } };
    },
    async waitForCompletion() {
      return { stepId: "", status: "completed", output: {} };
    },
    async getSessionStatus() {
      return "completed";
    },
  };

  let runResult: RunResult;
  try {
    runResult = await runPipeline(pipeline, {
      args: testCase.args,
      env: testCase.env,
      mode,
      hooks,
      adapter,
    });
  } catch (err) {
    return {
      name: testCase.name,
      passed: false,
      errors: [`Pipeline threw: ${err instanceof Error ? err.message : String(err)}`],
      duration: Date.now() - startTime,
    };
  }

  // Run assertions
  if (testCase.assert.status) {
    if (runResult.status !== testCase.assert.status) {
      errors.push(
        `Expected pipeline status '${testCase.assert.status}', got '${runResult.status}'`
      );
    }
  }

  if (testCase.assert.output !== undefined) {
    if (!deepEqual(runResult.output, testCase.assert.output)) {
      errors.push(
        `Expected pipeline output ${JSON.stringify(testCase.assert.output)}, got ${JSON.stringify(runResult.output)}`
      );
    }
  }

  if (testCase.assert.steps) {
    for (const [stepId, assertion] of Object.entries(testCase.assert.steps)) {
      const stepResult = runResult.results[stepId];
      if (!stepResult) {
        errors.push(`Step '${stepId}' was not executed`);
        continue;
      }

      if (typeof assertion === "string") {
        // Short form: just check status
        if (stepResult.status !== assertion) {
          errors.push(
            `Step '${stepId}': expected status '${assertion}', got '${stepResult.status}'`
          );
        }
      } else if ("status" in assertion) {
        if (stepResult.status !== assertion.status) {
          errors.push(
            `Step '${stepId}': expected status '${assertion.status}', got '${stepResult.status}'`
          );
        }
      } else if ("output" in assertion) {
        if (!deepEqual(stepResult.output, assertion.output)) {
          errors.push(
            `Step '${stepId}': expected output ${JSON.stringify(assertion.output)}, got ${JSON.stringify(stepResult.output)}`
          );
        }
      } else if ("outputContains" in assertion) {
        const outputStr = JSON.stringify(stepResult.output);
        if (!outputStr.includes(assertion.outputContains)) {
          errors.push(
            `Step '${stepId}': output does not contain '${assertion.outputContains}'`
          );
        }
      } else if ("outputPath" in assertion) {
        const actual = getNestedValue(stepResult.output, assertion.outputPath.split("."));
        if (!deepEqual(actual, assertion.equals)) {
          errors.push(
            `Step '${stepId}': ${assertion.outputPath} = ${JSON.stringify(actual)}, expected ${JSON.stringify(assertion.equals)}`
          );
        }
      }
    }
  }

  return {
    name: testCase.name,
    passed: errors.length === 0,
    errors,
    duration: Date.now() - startTime,
  };
}

// ─── Hook Builder ─────────────────────────────────────────────────────

function buildHooks(testCase: TestCase): PipelineHooks {
  const runMocks = testCase.mocks?.run ?? {};
  const spawnMocks = testCase.mocks?.spawn ?? {};
  const gateMocks = testCase.gates ?? {};

  return {
    onRun: async (step, command, ctx) => {
      const mock = runMocks[step.id];
      if (mock) {
        return {
          stepId: step.id,
          status: mock.status ?? "completed",
          output: mock.output,
          stdout: mock.stdout ?? (typeof mock.output === "string" ? mock.output : JSON.stringify(mock.output)),
          error: mock.error ? { message: mock.error } : undefined,
        };
      }
      // In sandbox mode with no mock, return null so runtime uses default sandbox behavior
      return null;
    },

    onSpawn: async (step, config, ctx) => {
      const mock = spawnMocks[step.id];
      if (mock) {
        return {
          status: mock.status ?? "accepted",
          childSessionKey: `mock-${step.id}`,
          output: mock.output,
          error: mock.error,
        };
      }
      // Default mock
      return {
        status: "accepted",
        childSessionKey: `mock-${step.id}`,
        output: { mocked: true },
      };
    },

    onGateReached: async (step, gate, ctx) => {
      const decision = gateMocks[step.id];
      if (decision !== undefined) return decision;
      // Default: auto-approve
      return true;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  return keysA.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key]
    )
  );
}

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

let _yaml: typeof import("yaml") | null = null;
function loadYaml() {
  if (!_yaml) {
    const require = createRequire(import.meta.url);
    _yaml = require("yaml") as typeof import("yaml");
  }
  return _yaml;
}
