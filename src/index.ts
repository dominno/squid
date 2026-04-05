/**
 * Squid-Claw - OpenClaw-native agentic pipeline framework
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
  ParallelConfig,
  LoopConfig,
  BranchConfig,
  RetryConfig,
  PipelineContext,
  PipelineHooks,
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

// Visualization
export { buildGraph, toMermaid } from "./core/graph.js";

// OpenClaw Adapter
export { createOpenClawAdapter, type OpenClawConfig } from "./core/openclaw-adapter.js";

// Testing
export { createTestRunner, TestRunner, type TestResult } from "./testing/index.js";
