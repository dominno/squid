# Getting Started with Squid

## Installation

```bash
git clone <your-repo>/squid
cd squid
npm install
npm run build
```

## Your First Pipeline

### 1. Scaffold a pipeline

```bash
npx squid init --template basic --name hello
```

This creates `hello.yaml`:

```yaml
name: hello
description: A simple pipeline

args:
  env:
    default: dev
    description: Target environment

steps:
  - id: build
    type: run
    description: Build the project
    run: echo "Building for ${args.env}..."

  - id: test
    type: run
    description: Run tests
    run: echo "Running tests..."
    retry: 2

  - id: approve
    type: gate
    gate: "Deploy to ${args.env}?"

  - id: deploy
    type: run
    description: Deploy
    run: echo "Deploying to ${args.env}..."
    when: $approve.approved
```

### 2. Validate

```bash
npx squid validate hello.yaml
```

Output:
```
Pipeline 'hello' is valid.
  Steps: 4
  Args: env
  Step types: run(3), gate(1)
```

### 3. Dry Run

See what would execute without running anything:

```bash
npx squid run hello.yaml --dry-run -v
```

### 4. Run for Real

```bash
npx squid run hello.yaml --args-json '{"env": "staging"}'
```

The pipeline will:
1. Run the build step
2. Run the test step (with retry on failure)
3. Halt at the gate and output a resume token
4. Wait for your approval

### 5. Resume After Approval

```bash
npx squid resume hello.yaml --token <token> --approve yes
```

### 6. Verbose Mode

Use `-v` to see step-by-step execution logs with timestamps, step types, outputs, and gate activity:

```bash
squid run hello.yaml -v
```

Output:

```
15:10:46.532 [pipeline] ▶ hello mode=run args={"env":"staging"}
15:10:46.535 [run]      → [build] starting...
15:10:46.850 [run]      ✓ [build] completed (315ms)
15:10:46.850 [output]     {"image":"app:latest","tag":"v2"}
15:10:46.851 [run]      → [test] starting...
15:10:47.200 [run]      ✓ [test] completed (349ms)
15:10:47.201 [gate]     → [approve] starting...
15:10:47.201 [gate]     ⏸ [approve] waiting for approval: Deploy to staging?
15:10:47.201 [gate]       Short ID: a1b2c3d4
```

Log icons:
- `▶` pipeline start
- `→` step starting
- `✓` completed
- `✗` error
- `⊘` skipped (condition false)
- `↻` retry
- `⏸` gate waiting
- `⚡` agent spawning

Combine with other flags:

```bash
squid run pipeline.yaml -v --dry-run    # see what would run
squid run pipeline.yaml -v --test       # auto-approve gates
```

### 7. Visualize

```bash
npx squid viz hello.yaml
```

Outputs a Mermaid diagram you can paste into any Markdown renderer.

## Concepts

### Steps

Every pipeline is a list of steps. Each step has:
- **id**: Unique identifier (used for references)
- **type**: What kind of step (run, spawn, gate, parallel, loop, branch, transform)
- **when**: Optional condition (skip if false)
- **retry**: Optional retry configuration
- **timeout**: Optional timeout in seconds

### Data Flow

Steps pass data via references:

```yaml
steps:
  - id: fetch
    type: run
    run: curl -s https://api.example.com/data

  # Reference fetch's output
  - id: process
    type: spawn
    spawn:
      task: "Process: ${fetch.json}"
```

| Reference | Description |
|-----------|-------------|
| `$stepId.json` | Parsed JSON output |
| `$stepId.stdout` | Raw stdout string |
| `$stepId.status` | Step status string |
| `$stepId.approved` | Boolean (gate steps) |
| `$args.key` | Pipeline argument |
| `$env.VAR` | Environment variable |
| `$item` | Current loop item |
| `$index` | Current loop index |

### Arguments

Define pipeline inputs with defaults and validation:

```yaml
args:
  env:
    default: dev
    description: Target environment
  image:
    required: true
    type: string
```

Pass at runtime:
```bash
squid run pipeline.yaml --args-json '{"env": "prod", "image": "app:v2"}'
```

## Next Steps

- [Step Types Guide](./step-types.md) — Deep dive into each step type
- [Agent Adapters](./adapters.md) — Setup OpenClaw, Claude Code, OpenCode, or custom agents
- [Workflow Patterns](./workflow-patterns.md) — Common patterns and recipes
- [Testing Guide](./testing.md) — How to test your pipelines
- [Migration from Lobster](./migration.md) — Convert Lobster workflows
