#!/usr/bin/env node
/**
 * Squid CLI
 *
 * Commands:
 *   run <file>       Execute a pipeline
 *   resume <token>   Resume a halted pipeline
 *   validate <file>  Validate a pipeline file
 *   visualize <file> Generate Mermaid diagram
 *   dev <file>       Watch mode (re-run on change)
 */

import { parseArgs } from "node:util";
import { writeFileSync, existsSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { parseFile } from "../core/parser.js";
import { runPipeline, type RunOptions, type RunResult } from "../core/runtime.js";
import { decodeResumeToken, encodeResumeToken } from "../core/resume.js";
import { buildGraph, toMermaid } from "../core/graph.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "run":
      await cmdRun(args.slice(1));
      break;
    case "resume":
      await cmdResume(args.slice(1));
      break;
    case "validate":
      cmdValidate(args.slice(1));
      break;
    case "visualize":
    case "viz":
      cmdVisualize(args.slice(1));
      break;
    case "dev":
      await cmdDev(args.slice(1));
      break;
    case "init":
      cmdInit(args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      if (command && command.endsWith(".yaml") || command?.endsWith(".yml") || command?.endsWith(".json")) {
        // Shortcut: squid pipeline.yaml → squid run pipeline.yaml
        await cmdRun(args);
      } else {
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
      }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────

async function cmdRun(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "args-json": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      test: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      cwd: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const filePath = positionals[0];
  if (!filePath) {
    console.error("Usage: squid run <pipeline.yaml> [options]");
    process.exit(1);
  }

  const pipeline = parseFile(filePath);
  const pipelineArgs = values["args-json"]
    ? JSON.parse(values["args-json"] as string)
    : {};

  const options: RunOptions = {
    args: pipelineArgs,
    cwd: values.cwd as string,
    mode: values["dry-run"] ? "dry-run" : values.test ? "test" : "run",
    hooks: values.verbose
      ? {
          onStepStart: async (step) => {
            console.error(`  → [${step.id}] ${step.type}...`);
          },
          onStepComplete: async (step, result) => {
            const icon = result.status === "completed" ? "✓" : result.status === "skipped" ? "⊘" : "✗";
            console.error(`  ${icon} [${step.id}] ${result.status} (${result.duration ?? 0}ms)`);
          },
        }
      : {},
  };

  const result = await runPipeline(pipeline, options);
  printResult(result);
}

async function cmdResume(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      token: { type: "string", short: "t" },
      approve: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const tokenStr = (values.token as string) ?? positionals[0];
  if (!tokenStr) {
    console.error("Usage: squid resume --token <token> --approve yes|no");
    process.exit(1);
  }

  const resumeToken = decodeResumeToken(tokenStr);
  const approve = values.approve;

  if (approve != null) {
    resumeToken.gateDecision = approve === "yes" || approve === "true" || approve === "1";
  }

  // Re-load the pipeline file (need to find it from token context)
  // For now, require the file as a positional arg
  const filePath = positionals[approve ? 0 : 1];
  if (!filePath) {
    console.error("Usage: squid resume <pipeline.yaml> --token <token> --approve yes|no");
    process.exit(1);
  }

  const pipeline = parseFile(filePath);
  const result = await runPipeline(pipeline, {
    args: resumeToken.args,
    resumeToken,
    hooks: values.verbose
      ? {
          onStepStart: async (step) => console.error(`  → [${step.id}]...`),
          onStepComplete: async (_, result) => console.error(`  ✓ [${result.stepId}] ${result.status}`),
        }
      : {},
  });

  printResult(result);
}

function cmdValidate(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: squid validate <pipeline.yaml>");
    process.exit(1);
  }

  try {
    const pipeline = parseFile(filePath);
    console.log(`Pipeline '${pipeline.name}' is valid.`);
    console.log(`  Steps: ${pipeline.steps.length}`);
    console.log(`  Args: ${Object.keys(pipeline.args ?? {}).join(", ") || "none"}`);

    const types = pipeline.steps.map((s) => s.type);
    const typeCounts = types.reduce((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`  Step types: ${Object.entries(typeCounts).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  } catch (err) {
    console.error(`Validation failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function cmdVisualize(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: squid visualize <pipeline.yaml>");
    process.exit(1);
  }

  const pipeline = parseFile(filePath);
  const graph = buildGraph(pipeline);
  const mermaid = toMermaid(graph);

  console.log(mermaid);
}

async function cmdDev(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: squid dev <pipeline.yaml>");
    process.exit(1);
  }

  const absPath = resolve(filePath);
  console.error(`Watching ${absPath} for changes...`);

  const runOnce = async () => {
    console.error(`\n--- Running pipeline ---`);
    try {
      const pipeline = parseFile(absPath);
      const result = await runPipeline(pipeline, {
        mode: "dry-run",
        hooks: {
          onStepStart: async (step) => console.error(`  → [${step.id}]...`),
          onStepComplete: async (_, result) =>
            console.error(`  ✓ [${result.stepId}] ${result.status}`),
        },
      });
      printResult(result);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }
  };

  await runOnce();

  watchFile(absPath, { interval: 1000 }, async () => {
    await runOnce();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────

function cmdInit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: "string", short: "t", default: "basic" },
      name: { type: "string", short: "n" },
      output: { type: "string", short: "o" },
    },
    strict: false,
  });

  const template = (values.template as string) ?? "basic";
  const name = (values.name as string) ?? "my-pipeline";
  const outputPath = (values.output as string) ?? `${name}.yaml`;

  if (existsSync(outputPath)) {
    console.error(`File already exists: ${outputPath}`);
    process.exit(1);
  }

  const content = getTemplate(template, name);
  writeFileSync(outputPath, content, "utf-8");
  console.log(`Created ${outputPath} (template: ${template})`);
  console.log(`\nNext steps:`);
  console.log(`  squid validate ${outputPath}`);
  console.log(`  squid run ${outputPath} --dry-run`);
  console.log(`  squid viz ${outputPath}`);
}

function getTemplate(template: string, name: string): string {
  switch (template) {
    case "basic":
      return TEMPLATE_BASIC.replace(/{{name}}/g, name);
    case "agent":
      return TEMPLATE_AGENT.replace(/{{name}}/g, name);
    case "parallel":
      return TEMPLATE_PARALLEL.replace(/{{name}}/g, name);
    case "full":
      return TEMPLATE_FULL.replace(/{{name}}/g, name);
    default:
      console.error(
        `Unknown template: ${template}. Available: basic, agent, parallel, full`
      );
      process.exit(1);
  }
}

const TEMPLATE_BASIC = `# Squid Pipeline: {{name}}
# Run: squid run {{name}}.yaml

name: {{name}}
description: A simple pipeline

args:
  env:
    default: dev
    description: Target environment

steps:
  - id: build
    type: run
    description: Build the project
    run: echo "Building for \${args.env}..."

  - id: test
    type: run
    description: Run tests
    run: echo "Running tests..."
    retry: 2

  - id: approve
    type: gate
    gate: "Deploy to \${args.env}?"

  - id: deploy
    type: run
    description: Deploy
    run: echo "Deploying to \${args.env}..."
    when: \$approve.approved
`;

const TEMPLATE_AGENT = `# Squid Pipeline: {{name}}
# Run: squid run {{name}}.yaml --args-json '{"task": "..."}'

name: {{name}}
description: Pipeline with AI sub-agents

args:
  task:
    description: Task for the agent to perform
    required: true

steps:
  - id: research
    type: spawn
    description: Research and analyze
    spawn:
      task: |
        Research and analyze: \${args.task}
        Output a JSON summary with findings and recommendations.
      model: claude-sonnet-4-6
      thinking: high
      timeout: 120

  - id: review
    type: gate
    gate:
      prompt: "Review the research findings. Approve to proceed."
      preview: \$research.json

  - id: implement
    type: spawn
    description: Implement recommendations
    spawn:
      task: |
        Based on these findings, implement the recommendations:
        \${research.json}
      timeout: 300
    when: \$review.approved
`;

const TEMPLATE_PARALLEL = `# Squid Pipeline: {{name}}
# Run: squid run {{name}}.yaml

name: {{name}}
description: Pipeline with parallel execution

steps:
  - id: prepare
    type: run
    run: echo '{"items":["a","b","c"]}'

  - id: parallel-work
    type: parallel
    description: Process multiple tasks in parallel
    parallel:
      maxConcurrent: 3
      failFast: true
      merge: object
      branches:
        task-a:
          - id: a1
            type: run
            run: echo "Processing task A"
        task-b:
          - id: b1
            type: run
            run: echo "Processing task B"
        task-c:
          - id: c1
            type: run
            run: echo "Processing task C"

  - id: aggregate
    type: transform
    description: Combine results
    transform: \$parallel-work.json
`;

const TEMPLATE_FULL = `# Squid Pipeline: {{name}}
# Full-featured pipeline showcasing all step types
# Run: squid run {{name}}.yaml --args-json '{"target": "prod"}'

name: {{name}}
description: Full-featured pipeline with all step types
version: "1.0"

args:
  target:
    default: staging
    description: Deployment target
  maxWorkers:
    default: 4

env:
  PIPELINE_NAME: {{name}}

steps:
  # 1. Run: Execute a shell command
  - id: setup
    type: run
    description: Setup workspace
    run: echo '{"ready":true, "items":["x","y","z"]}'

  # 2. Branch: Conditional routing
  - id: route
    type: branch
    description: Choose path based on target
    branch:
      conditions:
        - when: \$args.target == "prod"
          steps:
            - id: prod-check
              type: run
              run: echo "Production safety check passed"
      default:
        - id: dev-check
          type: run
          run: echo "Dev/staging - skipping safety check"

  # 3. Parallel: Fan-out concurrent work
  - id: build
    type: parallel
    parallel:
      maxConcurrent: 3
      merge: object
      branches:
        backend:
          - id: build-backend
            type: run
            run: echo "Backend built"
        frontend:
          - id: build-frontend
            type: run
            run: echo "Frontend built"

  # 4. Loop: Iterate over items
  - id: process-items
    type: loop
    description: Process each item
    loop:
      over: \$setup.json.items
      as: item
      maxConcurrent: 2
      steps:
        - id: process
          type: run
          run: echo "Processed item"

  # 5. Spawn: AI sub-agent
  - id: review
    type: spawn
    description: AI review of changes
    spawn:
      task: "Review the build output and summarize quality metrics."
      model: claude-sonnet-4-6
      timeout: 120

  # 6. Gate: Human approval
  - id: deploy-gate
    type: gate
    gate:
      prompt: "Deploy {{name}} to \${args.target}?"
      preview: \$review.json

  # 7. Deploy with retry
  - id: deploy
    type: run
    description: Deploy to target
    run: echo "Deployed to \${args.target}"
    when: \$deploy-gate.approved
    retry:
      maxAttempts: 3
      backoff: exponential-jitter

  # 8. Transform: Shape output
  - id: summary
    type: transform
    transform: '{"pipeline":"{{name}}", "target":"\${args.target}", "status":"complete"}'
`;

// ─── Output ───────────────────────────────────────────────────────────

function printResult(result: RunResult) {
  const envelope = {
    protocolVersion: 1,
    pipeline: result.pipelineId,
    runId: result.runId,
    status: result.status,
    output: result.output,
    duration: result.duration,
    ...(result.resumeToken
      ? {
          requiresApproval: {
            resumeToken: encodeResumeToken(result.resumeToken),
            resumeAtStep: result.resumeToken.resumeAtStep,
          },
        }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  };

  console.log(JSON.stringify(envelope, null, 2));

  // Exit code based on status
  if (result.status === "failed") process.exit(1);
  if (result.status === "halted") process.exit(2);
}

function printHelp() {
  console.log(`
squid - OpenClaw-native agentic pipeline framework

Usage:
  squid run <pipeline.yaml> [options]    Execute a pipeline
  squid resume <file> --token <t> --approve yes|no
  squid validate <pipeline.yaml>         Validate syntax
  squid visualize <pipeline.yaml>        Output Mermaid diagram
  squid dev <pipeline.yaml>              Watch mode (dry-run on save)
  squid init [options]                   Scaffold a new pipeline

Init templates:
  --template basic      Simple build/test/deploy (default)
  --template agent      Pipeline with AI sub-agents
  --template parallel   Parallel execution showcase
  --template full       All step types demonstrated
  --name <name>         Pipeline name (default: my-pipeline)
  --output <file>       Output file path

Options:
  --args-json '{"key":"val"}'   Pipeline arguments as JSON
  --dry-run                     Print what would execute
  --test                        Use mock adapters
  --verbose, -v                 Step-by-step output
  --cwd <dir>                   Working directory

Examples:
  squid run deploy.yaml --args-json '{"env":"staging"}'
  squid validate pipeline.yaml
  squid viz pipeline.yaml > diagram.md
`);
}

function printVersion() {
  console.log("squid 0.1.0");
}

// ─── Entry ────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
