/**
 * Squid-Claw Core Types
 *
 * SOLID: Each interface has a single responsibility.
 * Open/Closed: Extend via StepType union, never modify existing types.
 * Liskov: All step types satisfy the Step contract.
 * Interface Segregation: Separate configs for spawn/gate/retry/loop.
 * Dependency Inversion: Runtime depends on abstractions, not implementations.
 */

// ─── Pipeline Definition ─────────────────────────────────────────────

export interface Pipeline {
  name: string;
  description?: string;
  version?: string;
  args?: Record<string, ArgDef>;
  env?: Record<string, string>;
  cwd?: string;
  steps: Step[];
  onError?: ErrorStrategy;
  sourceDir?: string;              // Directory of the source YAML file (set by parseFile)
}

export interface ArgDef {
  default?: unknown;
  description?: string;
  required?: boolean;
  type?: "string" | "number" | "boolean" | "object";
}

// ─── Steps ───────────────────────────────────────────────────────────

export type StepType =
  | "run"
  | "spawn"
  | "gate"
  | "parallel"
  | "loop"
  | "branch"
  | "transform"
  | "pipeline";

export interface Step {
  id: string;
  type: StepType;
  description?: string;

  // Execution
  run?: string;                    // Shell command
  spawn?: SpawnConfig;             // OpenClaw sessions_spawn
  gate?: GateConfig;               // Approval gate
  parallel?: ParallelConfig;       // Fan-out / fan-in
  loop?: LoopConfig;               // Iteration
  branch?: BranchConfig;           // Conditional routing
  transform?: string;              // Inline JS/TS expression
  pipeline?: PipelineRefConfig;    // Run a sub-pipeline YAML

  // Data flow
  input?: string;                  // Reference: $stepId.json | $stepId.stdout | $args.key
  output?: string;                 // Named output key (default: step id)

  // Control flow
  when?: string;                   // Condition expression
  retry?: RetryConfig;             // Retry on failure
  restart?: RestartConfig;         // Jump back to a previous step
  timeout?: number;                // Timeout in seconds
  env?: Record<string, string>;    // Step-level env vars
  cwd?: string;                    // Step working directory

  // Metadata
  tags?: string[];
  meta?: Record<string, unknown>;
}

// ─── Spawn (OpenClaw sessions_spawn) ─────────────────────────────────

export interface SpawnConfig {
  task: string;                    // Task description for sub-agent
  agentId?: string;                // Target agent ID
  model?: string;                  // Model override
  thinking?: "off" | "low" | "high";
  runtime?: "subagent" | "acp";
  cwd?: string;                    // Workspace directory
  timeout?: number;                // Seconds
  mode?: "run" | "session";        // Ephemeral or persistent
  attachments?: SpawnAttachment[];
  sandbox?: "inherit" | "require";
  maxConcurrent?: number;          // For spawn inside parallel/loop
}

export interface SpawnAttachment {
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}

// ─── Gate (Approval / Human-in-the-loop) ─────────────────────────────

export interface GateConfig {
  prompt: string;                  // Approval prompt
  items?: unknown[];               // Items to display
  preview?: string;                // Preview text
  autoApprove?: boolean;           // Skip in CI/test mode
  timeout?: number;                // Auto-reject after N seconds
  approvers?: string[];            // Required approver IDs
}

// ─── Parallel (Fan-out / Fan-in) ──────────────────────────────────────

export interface ParallelConfig {
  branches: Record<string, Step[]>; // Named branches → step sequences
  maxConcurrent?: number;           // Concurrency limit
  failFast?: boolean;               // Abort all on first failure (default: true)
  merge?: "object" | "array" | "first"; // How to combine results
}

// ─── Loop ─────────────────────────────────────────────────────────────

export interface LoopConfig {
  over: string;                    // Expression yielding iterable: $stepId.json | $args.items
  as?: string;                     // Iterator variable name (default: "item")
  index?: string;                  // Index variable name (default: "index")
  steps: Step[];                   // Steps to execute per iteration
  maxConcurrent?: number;          // Parallel iterations
  maxIterations?: number;          // Safety limit (default: 1000)
  collect?: string;                // Output key for collected results
}

// ─── Branch (Conditional Routing) ─────────────────────────────────────

export interface BranchConfig {
  conditions: BranchCondition[];
  default?: Step[];                // Fallback if no condition matches
}

export interface BranchCondition {
  when: string;                    // Condition expression
  steps: Step[];                   // Steps to execute if true
}

// ─── Pipeline Ref (Sub-Pipeline) ──────────────────────────────────────

export interface PipelineRefConfig {
  file: string;                    // Path to sub-pipeline YAML/JSON
  args?: Record<string, unknown>;  // Arguments to pass (can use $refs)
  env?: Record<string, string>;    // Extra env vars
  cwd?: string;                    // Working directory override
}

// ─── Retry ────────────────────────────────────────────────────────────

export interface RetryConfig {
  maxAttempts: number;             // Total attempts (including first)
  backoff?: "fixed" | "exponential" | "exponential-jitter";
  delayMs?: number;                // Base delay (default: 1000)
  maxDelayMs?: number;             // Cap delay (default: 30000)
  retryOn?: string[];              // Error types/patterns to retry on
}

// ─── Restart (Jump Back) ──────────────────────────────────────────────

export interface RestartConfig {
  step: string;                    // Step ID to jump back to
  when: string;                    // Condition — restart only if true
  maxRestarts?: number;            // Safety limit (default: 3)
}

// ─── Error Handling ───────────────────────────────────────────────────

export type ErrorStrategy = "fail" | "skip" | "continue";

// ─── Execution State ──────────────────────────────────────────────────

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting_approval"
  | "retrying";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output?: unknown;                // Structured output (JSON)
  stdout?: string;                 // Raw stdout
  stderr?: string;                 // Raw stderr
  error?: StepError;
  startedAt?: number;
  completedAt?: number;
  duration?: number;               // Milliseconds
  attempts?: number;               // Retry count
  childSessionKey?: string;        // For spawn steps
  meta?: Record<string, unknown>;
}

export interface StepError {
  message: string;
  code?: string;
  stack?: string;
  retryable?: boolean;
}

// ─── Pipeline Execution Context ───────────────────────────────────────

export interface PipelineContext {
  pipelineId: string;
  runId: string;
  args: Record<string, unknown>;
  env: Record<string, string>;
  cwd: string;
  sourceDir?: string;              // Directory of the pipeline source file
  results: Map<string, StepResult>;
  state: Map<string, unknown>;     // User-managed state
  mode: ExecutionMode;
  signal?: AbortSignal;
  hooks: PipelineHooks;
}

export type ExecutionMode = "run" | "dry-run" | "test";

// ─── Hooks (Extension Points) ─────────────────────────────────────────

export interface PipelineHooks {
  onStepStart?: (step: Step, ctx: PipelineContext) => Promise<void>;
  onStepComplete?: (step: Step, result: StepResult, ctx: PipelineContext) => Promise<void>;
  onStepError?: (step: Step, error: StepError, ctx: PipelineContext) => Promise<void>;
  onGateReached?: (step: Step, gate: GateConfig, ctx: PipelineContext) => Promise<boolean>;
  onSpawn?: (step: Step, spawn: SpawnConfig, ctx: PipelineContext) => Promise<SpawnResult>;
  onPipelineStart?: (pipeline: Pipeline, ctx: PipelineContext) => Promise<void>;
  onPipelineComplete?: (pipeline: Pipeline, results: Map<string, StepResult>, ctx: PipelineContext) => Promise<void>;
}

// ─── OpenClaw Integration ─────────────────────────────────────────────

export interface SpawnResult {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  output?: unknown;
  error?: string;
}

export interface OpenClawAdapter {
  spawn(config: SpawnConfig, ctx: PipelineContext): Promise<SpawnResult>;
  waitForCompletion(childSessionKey: string, timeoutMs?: number): Promise<StepResult>;
  getSessionStatus(sessionKey: string): Promise<StepStatus>;
}

// ─── Resume Token ─────────────────────────────────────────────────────

export interface ResumeToken {
  version: 1;
  pipelineId: string;
  runId: string;
  resumeAtStep: string;           // Step ID to resume from
  completedResults: Record<string, StepResult>;
  args: Record<string, unknown>;
  gateDecision?: boolean;          // Approval decision for gate step
  createdAt: number;
}

// ─── Visualization ────────────────────────────────────────────────────

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  type: StepType;
  label: string;
  status?: StepStatus;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  conditional?: boolean;
}
