# Workflow Patterns

Common patterns for building pipelines with Squid.

---

## Pattern 1: Linear Pipeline

The simplest pattern — steps execute in sequence.

```yaml
name: linear
steps:
  - id: fetch
    type: run
    run: curl -s https://api.example.com/data

  - id: process
    type: run
    run: jq '.items[] | select(.active)' <<< '${fetch.stdout}'

  - id: report
    type: run
    run: echo "Found ${process.json.length} active items"
```

---

## Pattern 2: Gate-Protected Deploy

Build, test, get approval, then deploy. The classic CI/CD gate.

```yaml
name: deploy
args:
  env: { default: staging }
  image: { required: true }

steps:
  - id: build
    type: run
    run: docker build -t ${args.image} .
    retry: 2

  - id: test
    type: run
    run: docker run --rm ${args.image} npm test

  - id: approve
    type: gate
    gate:
      prompt: "Deploy ${args.image} to ${args.env}?"
      preview: $test.json

  - id: deploy
    type: run
    run: kubectl set image deployment/app app=${args.image} -n ${args.env}
    when: $approve.approved
    retry:
      maxAttempts: 3
      backoff: exponential
```

---

## Pattern 3: Multi-Agent Collaboration

Multiple AI agents work on different aspects of a task, then a reviewer combines their work.

```yaml
name: multi-agent
args:
  task: { required: true }

steps:
  - id: plan
    type: spawn
    spawn:
      task: "Create a plan for: ${args.task}"
      thinking: high

  - id: work
    type: parallel
    parallel:
      maxConcurrent: 3
      branches:
        research:
          - id: researcher
            type: spawn
            spawn: "Research: ${args.task}. Plan: ${plan.json}"
        implement:
          - id: coder
            type: spawn
            spawn: "Implement: ${args.task}. Plan: ${plan.json}"
        test:
          - id: tester
            type: spawn
            spawn: "Write tests for: ${args.task}. Plan: ${plan.json}"

  - id: review
    type: spawn
    spawn:
      task: |
        Review all outputs:
        Research: ${researcher.json}
        Code: ${coder.json}
        Tests: ${tester.json}
        Provide a unified summary.
      thinking: high
```

---

## Pattern 4: Fan-Out / Fan-In

Process a batch of items in parallel, then aggregate results.

```yaml
name: batch-process
steps:
  - id: discover
    type: run
    run: find /data -name "*.json" -printf '"%p"\n' | jq -s '.'

  - id: process
    type: loop
    loop:
      over: $discover.json
      as: file
      maxConcurrent: 10
      steps:
        - id: analyze
          type: spawn
          spawn:
            task: "Analyze the data file at: ${item}"
            timeout: 60

  - id: aggregate
    type: spawn
    spawn:
      task: |
        Aggregate these analysis results into a summary report:
        ${process.json}
```

---

## Pattern 5: Retry with Escalation

Try an operation, and if it keeps failing, escalate to a different approach.

```yaml
name: resilient-deploy
steps:
  - id: deploy
    type: run
    run: kubectl apply -f deploy.yaml
    retry:
      maxAttempts: 3
      backoff: exponential
      retryOn: ["timeout", "connection refused"]

  - id: check
    type: branch
    branch:
      conditions:
        - when: $deploy.status == "failed"
          steps:
            - id: rollback
              type: run
              run: kubectl rollout undo deployment/app

            - id: alert
              type: spawn
              spawn: "Deployment failed after 3 retries. Rolled back. Diagnose the issue."

            - id: human-review
              type: gate
              gate: "Deployment failed and was rolled back. Review the diagnosis and decide next steps."
      default:
        - id: verify
          type: run
          run: kubectl rollout status deployment/app --timeout=120s
```

---

## Pattern 6: Iterative Refinement Loop

Have an agent produce work, review it, and iterate until quality is met. Uses a loop over a fixed number of iterations with early exit via conditions.

```yaml
name: iterative-refine
args:
  maxIterations: { default: 3 }

steps:
  - id: first-draft
    type: spawn
    spawn: "Write a first draft of the technical spec"

  - id: refine
    type: loop
    loop:
      over: $args.maxIterations    # [0, 1, 2] for maxIterations=3
      steps:
        - id: review
          type: spawn
          spawn:
            task: |
              Review this draft and rate quality 1-10:
              ${first-draft.json}
              Output: { "score": number, "feedback": "..." }

        - id: check-quality
          type: branch
          branch:
            conditions:
              - when: $review.json.score >= 8
                steps:
                  - id: done
                    type: transform
                    transform: '{"status": "accepted", "score": ${review.json.score}}'
            default:
              - id: revise
                type: spawn
                spawn:
                  task: |
                    Revise the draft based on this feedback:
                    ${review.json.feedback}
```

---

## Pattern 7: Environment-Specific Pipelines

Use branches to handle different deployment targets.

```yaml
name: multi-env-deploy
args:
  env: { required: true }
  image: { required: true }

steps:
  - id: build
    type: run
    run: docker build -t ${args.image} .

  - id: deploy
    type: branch
    branch:
      conditions:
        - when: $args.env == "dev"
          steps:
            - id: deploy-dev
              type: run
              run: docker compose up -d

        - when: $args.env == "staging"
          steps:
            - id: deploy-staging
              type: run
              run: kubectl apply -f k8s/staging/ -n staging

        - when: $args.env == "prod"
          steps:
            - id: prod-gate
              type: gate
              gate: "Deploy ${args.image} to PRODUCTION?"
            - id: deploy-prod
              type: run
              run: kubectl apply -f k8s/prod/ -n production
              when: $prod-gate.approved
              retry:
                maxAttempts: 3
                backoff: exponential-jitter
```

---

## Pattern 8: Data Pipeline with Validation

ETL pipeline with schema validation between steps.

```yaml
name: etl
args:
  source: { required: true }
  destination: { required: true }

steps:
  - id: extract
    type: run
    run: etl-cli extract --source ${args.source} --format json
    retry: 3

  - id: validate
    type: spawn
    spawn:
      task: |
        Validate this data against our schema:
        ${extract.json}
        Output: { "valid": boolean, "errors": [...] }

  - id: check-valid
    type: branch
    branch:
      conditions:
        - when: "!$validate.json.valid"
          steps:
            - id: fix-data
              type: spawn
              spawn: "Fix these validation errors: ${validate.json.errors}"
      default:
        - id: pass
          type: transform
          transform: $extract.json

  - id: transform
    type: spawn
    spawn:
      task: "Transform this data for loading into ${args.destination}: ${extract.json}"

  - id: load
    type: run
    run: etl-cli load --dest ${args.destination} --data '${transform.json}'
    retry:
      maxAttempts: 3
      backoff: exponential
```

---

## Pattern 9: Monitoring and Alerting

Periodic check with conditional alerting.

```yaml
name: health-check
steps:
  - id: check
    type: parallel
    parallel:
      merge: object
      branches:
        api:
          - id: api-health
            type: run
            run: curl -sf https://api.example.com/health && echo '{"status":"ok"}' || echo '{"status":"down"}'
        db:
          - id: db-health
            type: run
            run: pg_isready -h db.example.com && echo '{"status":"ok"}' || echo '{"status":"down"}'
        cache:
          - id: cache-health
            type: run
            run: redis-cli -h cache.example.com ping && echo '{"status":"ok"}' || echo '{"status":"down"}'

  - id: alert
    type: branch
    branch:
      conditions:
        - when: $api-health.json.status == "down" || $db-health.json.status == "down"
          steps:
            - id: notify
              type: spawn
              spawn: "Services are down. API: ${api-health.json.status}, DB: ${db-health.json.status}. Diagnose and recommend fixes."
            - id: escalate
              type: gate
              gate: "Services down! Review diagnosis and approve remediation."
```

---

## Pattern 10: Sub-Pipeline Composition

The most powerful pattern. Break large workflows into reusable sub-pipelines, each in its own YAML file.

### File structure

```
pipelines/
  release.yaml           # orchestrator
  stages/
    build.yaml           # reusable build
    test.yaml            # reusable test suite
    deploy.yaml          # reusable deploy (with prod gate)
    notify.yaml          # reusable notification
```

### Orchestrator (release.yaml)

```yaml
name: release
args:
  env: { default: staging }
  version: { required: true }

steps:
  - id: build
    type: pipeline
    pipeline:
      file: ./stages/build.yaml
      args:
        target: $args.env
        version: $args.version

  - id: test
    type: pipeline
    pipeline:
      file: ./stages/test.yaml

  - id: deploy
    type: pipeline
    pipeline:
      file: ./stages/deploy.yaml
      args:
        artifact: $build.json.artifact
        env: $args.env

  - id: notify
    type: pipeline
    pipeline:
      file: ./stages/notify.yaml
      args:
        message: "Released ${args.version} to ${args.env}"
        channel: releases
```

### Sub-pipeline (stages/build.yaml)

```yaml
name: build
args:
  target: { default: dev }
  version: { required: true }

steps:
  - id: compile
    type: run
    run: make build TARGET=${args.target} VERSION=${args.version}
    retry: 2

  - id: package
    type: run
    run: make package
```

### Key benefits

- **Reusability**: `deploy.yaml` works for staging, prod, canary — just pass different args
- **Testability**: Test each sub-pipeline independently with `squid run stages/build.yaml --test`
- **Readability**: The orchestrator is a high-level overview; details live in sub-pipelines
- **Team ownership**: Different teams can own different stages
- **Gate propagation**: A prod gate in `deploy.yaml` halts the entire orchestrator

### Passing data between sub-pipelines

Each sub-pipeline's output flows to the next via `$stepId.json`:

```yaml
# build output → test input → deploy input
- id: build
  type: pipeline
  pipeline: { file: ./build.yaml }

- id: test
  type: pipeline
  pipeline:
    file: ./test.yaml
    args:
      artifact: $build.json.artifact    # from build sub-pipeline

- id: deploy
  type: pipeline
  pipeline:
    file: ./deploy.yaml
    args:
      artifact: $build.json.artifact    # from build
      test_report: $test.json.report    # from test
```

### Running the complete example

```bash
# Validate all files
squid validate examples/orchestrator.yaml
squid validate examples/sub-build.yaml
squid validate examples/sub-test.yaml
squid validate examples/sub-deploy.yaml

# Dry run
squid run examples/orchestrator.yaml --dry-run -v

# Real run (staging — no prod gate)
squid run examples/orchestrator.yaml -v

# Real run (prod — halts at deploy gate)
squid run examples/orchestrator.yaml --args-json '{"env":"prod"}' -v
```

---

## Anti-Patterns

### Don't: Deep nesting

```yaml
# Bad: Hard to read and debug
- id: outer-loop
  type: loop
  loop:
    over: $data.json
    steps:
      - id: inner-loop
        type: loop
        loop:
          over: $item.children
          steps:
            - id: deep-branch
              type: branch
              # ... 5 more levels
```

**Instead**: Break into sub-pipelines and compose with `type: pipeline`:

```yaml
# Good: Flat orchestrator calling focused sub-pipelines
- id: process-parents
  type: loop
  loop:
    over: $data.json
    steps:
      - id: process-one
        type: pipeline
        pipeline:
          file: ./process-item.yaml
          args: { item: $item }
```

### Don't: Overuse transforms

```yaml
# Bad: Complex data manipulation in YAML
- id: t1
  type: transform
  transform: ...
- id: t2
  type: transform
  transform: ...
- id: t3
  type: transform
  transform: ...
```

**Instead**: Use a single `run` step with `jq` or a script, or a `spawn` step to have an agent do the transformation.

### Don't: Skip gates in production

```yaml
# Bad: autoApprove in production
- id: deploy-gate
  type: gate
  gate:
    prompt: "Deploy?"
    autoApprove: true   # Dangerous for prod!
```

**Instead**: Use `autoApprove` only for dev/CI. Let the `--test` flag handle it in CI pipelines.
