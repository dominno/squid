# Migrating from Lobster to Squid-Claw

## Quick Reference

| Lobster | Squid-Claw | Notes |
|---------|------------|-------|
| `run: cmd` | `type: run`, `run: cmd` | Explicit type |
| `command: cmd` | `type: run`, `run: cmd` | `command` also works |
| `approval: "prompt"` | `type: gate`, `gate: "prompt"` | Separate step type |
| `approval: true` | `type: gate`, `gate: { autoApprove: true }` | |
| `pipeline: cmd \| cmd` | `type: run`, `run: cmd` or `type: spawn` | No pipeline DSL needed |
| `stdin: $step.json` | `input: $step.json` | Renamed |
| `when: $step.approved` | `when: $step.approved` | Same syntax |
| `when: $step.skipped` | `when: $step.skipped` | Same syntax |
| (no retry) | `retry: { maxAttempts: 3 }` | New feature |
| (no parallel) | `type: parallel` | New feature |
| (no loop) | `type: loop` | New feature |
| (no branch) | `type: branch` | New feature |
| `lobster run --file f` | `squid-claw run f` | Shorter |
| `lobster resume --token t` | `squid-claw resume f --token t` | Need file path |
| `--mode tool` | Default behavior | Tool envelope is default |
| `--args-json '{}'` | `--args-json '{}'` | Same |

## Step-by-Step Migration

### 1. Convert run steps

**Lobster:**
```yaml
steps:
  - id: fetch
    run: curl -s https://api.example.com/data
```

**Squid-Claw:**
```yaml
steps:
  - id: fetch
    type: run
    run: curl -s https://api.example.com/data
```

Change: Add `type: run`. The `run:` key stays the same.

### 2. Convert approvals to gates

**Lobster:**
```yaml
- id: confirm
  approval: "Deploy to production?"
  stdin: $fetch.json
```

**Squid-Claw:**
```yaml
- id: confirm
  type: gate
  gate:
    prompt: "Deploy to production?"
    preview: $fetch.json
```

Changes:
- `approval:` → `type: gate` + `gate:`
- `stdin:` → `preview:` (for display) or `input:` (for data flow)

### 3. Convert pipeline commands to spawn or run

**Lobster:**
```yaml
- id: advice
  pipeline: >
    llm.invoke --prompt "Should I wear a jacket?"
  stdin: $fetch.json
```

**Squid-Claw:**
```yaml
- id: advice
  type: spawn
  input: $fetch.json
  spawn:
    task: |
      Given this weather data: ${fetch.json}
      Should I wear a jacket?
    model: claude-haiku-4-5
```

Change: Replace `pipeline:` with native `spawn:`. The AI agent handles the task directly — no shell piping through `llm.invoke`.

### 4. Convert stdin references to input

**Lobster:**
```yaml
- id: process
  run: jq '.items'
  stdin: $fetch.json
```

**Squid-Claw:**
```yaml
- id: process
  type: run
  run: echo '${fetch.json}' | jq '.items'
```

Or better — use a transform:
```yaml
- id: process
  type: transform
  transform: $fetch.json.items
```

### 5. Add features Lobster didn't have

Now you can add retry, parallel, loops, and branching:

```yaml
# Retry flaky steps
- id: deploy
  type: run
  run: kubectl apply -f deploy.yaml
  retry:
    maxAttempts: 3
    backoff: exponential

# Parallel execution
- id: build
  type: parallel
  parallel:
    branches:
      api: [{ id: api, type: run, run: "npm run build:api" }]
      ui:  [{ id: ui, type: run, run: "npm run build:ui" }]

# Loop over items
- id: notify
  type: loop
  loop:
    over: $users.json
    steps:
      - id: send
        type: run
        run: notify-cli --user ${item.email} --message "Deployed!"
```

## Full Example

### Before (Lobster)

```yaml
name: jacket-advice
args:
  location:
    default: Phoenix
steps:
  - id: fetch
    run: weather --json ${location}

  - id: confirm
    approval: Want jacket advice?
    stdin: $fetch.json

  - id: advice
    pipeline: >
      llm.invoke --prompt "Given this weather, should I wear a jacket?"
    stdin: $fetch.json
    when: $confirm.approved
```

### After (Squid-Claw)

```yaml
name: jacket-advice
description: Weather-based jacket recommendation

args:
  location:
    default: Phoenix

steps:
  - id: fetch
    type: run
    run: weather --json ${args.location}
    retry:
      maxAttempts: 3
      backoff: exponential

  - id: confirm
    type: gate
    gate:
      prompt: "Want jacket advice for ${args.location}?"
      preview: $fetch.json

  - id: advice
    type: spawn
    input: $fetch.json
    spawn:
      task: |
        Given this weather data for ${args.location}:
        ${fetch.json}
        Should I wear a jacket? Respond with JSON.
      model: claude-haiku-4-5
      timeout: 30
    when: $confirm.approved
```

### What improved:
- `retry:` on the weather API call (Lobster had none)
- `preview:` in the gate shows data to the approver
- `spawn:` replaces `pipeline: llm.invoke` — native sub-agent
- `${args.location}` is explicit (Lobster used bare `${location}`)
- `description:` on the pipeline for documentation

## Environment Variables

Same variables work in both:

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_URL` | OpenClaw gateway URL |
| `OPENCLAW_TOKEN` | Auth token |
| `CLAWD_URL` | Legacy fallback |
| `CLAWD_TOKEN` | Legacy fallback |

## Testing Migration

Lobster had limited testing (script flags). Squid-Claw has a full TestRunner:

```typescript
import { createTestRunner } from "squid-claw/testing";
import { parseFile } from "squid-claw";

const pipeline = parseFile("jacket-advice.yaml");

// Test the happy path
const result = await createTestRunner()
  .mockSpawn("advice", { output: { recommendation: "yes", reason: "cold" } })
  .approveGate("confirm")
  .withArgs({ location: "Chicago" })
  .run(pipeline);

result.assertStepCompleted("advice");
```
