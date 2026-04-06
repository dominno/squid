/**
 * Squid - OpenClaw-native agentic pipeline framework
 *
 * Public API for programmatic usage.
 */

// Core types
export type {
  Pipeline,
  Step,
  StepType,
  StepResult,
  StepError,
  StepStatus,
  SpawnConfig,
  GateConfig,
  GateInputField,
  GateDecision,
  ParallelConfig,
  LoopConfig,
  BranchConfig,
  RetryConfig,
  RestartConfig,
  PipelineRefConfig,
  PipelineContext,
  PipelineHooks,
  PipelineEvent,
  PipelineEventType,
  PipelineEventEmitter,
  AgentAdapter,
  OpenClawAdapter,
  SpawnResult,
  ResumeToken,
  ExecutionMode,
  ErrorStrategy,
  PipelineGraph,
  GraphNode,
  GraphEdge,
  ArgDef,
} from "./core/types.js";

// Parser
export { parseFile, parseString, parsePipeline, ParseError } from "./core/parser.js";

// Runtime
export { runPipeline, type RunOptions, type RunResult } from "./core/runtime.js";

// Expressions
export { resolveRef, interpolate, evaluateCondition } from "./core/expressions.js";

// Resume
export { encodeResumeToken, decodeResumeToken } from "./core/resume.js";

// Events
export { createEventEmitter, createNoopEmitter, createEvent } from "./core/events.js";

// Gate Utilities
export {
  generateShortId,
  registerShortId,
  resolveShortId,
  clearShortIds,
  validateGateInput,
  validateApprover,
  type GateValidationResult,
} from "./core/gate-utils.js";

// Visualization
export { buildGraph, toMermaid } from "./core/graph.js";

// Agent Adapters
export { createOpenClawAdapter, type OpenClawConfig } from "./core/openclaw-adapter.js";
export {
  registerAdapter,
  getAdapter,
  listAdapters,
  resolveAdapter,
  createClaudeCodeAdapter,
  createOpenCodeAdapter,
  setupBuiltinAdapters,
} from "./core/adapters/index.js";

// Testing
export { createTestRunner, TestRunner, type TestResult } from "./testing/index.js";

// YAML Test Runner
export {
  runTestFile,
  type TestFile,
  type TestCase,
  type TestSuiteResult,
  type TestCaseResult,
  type TestAssertions,
} from "./testing/yaml-runner.js";
