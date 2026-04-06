# Squid Documentation

Agentic pipeline framework with pluggable agent runtimes.

**Repository**: [github.com/dominno/squid](https://github.com/dominno/squid)

---

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](./getting-started.md) | Install, scaffold, run your first pipeline |
| [Step Types](./step-types.md) | All 8 step types: run, spawn, gate, parallel, loop, branch, transform, pipeline |
| [Workflow Patterns](./workflow-patterns.md) | 10 common patterns + anti-patterns |
| [Testing](./testing.md) | YAML tests (sandbox/integration), TypeScript TestRunner |
| [Agent Adapters](./adapters.md) | Setup OpenClaw, Claude Code, OpenCode, or custom agents |
| [Migration from Lobster](./migration.md) | Convert Lobster YAML workflows to Squid |

---

## Examples

All examples live in [`skills/squid-pipeline/examples/`](../skills/squid-pipeline/examples/).

| Example | Description |
|---------|-------------|
| [simple-deploy.yaml](../skills/squid-pipeline/examples/simple-deploy.yaml) | Basic build → test → gate → deploy |
| [orchestrator.yaml](../skills/squid-pipeline/examples/orchestrator.yaml) | Sub-pipeline composition (calls sub-build, sub-test, sub-deploy) |
| [sub-build.yaml](../skills/squid-pipeline/examples/sub-build.yaml) | Reusable build stage |
| [sub-test.yaml](../skills/squid-pipeline/examples/sub-test.yaml) | Reusable test stage |
| [sub-deploy.yaml](../skills/squid-pipeline/examples/sub-deploy.yaml) | Reusable deploy stage with prod gate |
| [multi-agent-dev.yaml](../skills/squid-pipeline/examples/multi-agent-dev.yaml) | 8 specialized agents: architect, coders, tester, reviewer, docs |
| [video-pipeline.yaml](../skills/squid-pipeline/examples/video-pipeline.yaml) | Content creation with parallel asset generation loops |
| [iterative-refinement.yaml](../skills/squid-pipeline/examples/iterative-refinement.yaml) | Restart loop: write → review → refine until quality threshold met |
| [advanced-gates.yaml](../skills/squid-pipeline/examples/advanced-gates.yaml) | Structured input fields, requiredApprovers, short IDs |
| [observability.yaml](../skills/squid-pipeline/examples/observability.yaml) | Event hooks, OTel spans, audit trails, chat notifications |
| [lobster-migration.yaml](../skills/squid-pipeline/examples/lobster-migration.yaml) | Side-by-side Lobster → Squid migration |

### Test files

| Test | Pipeline | Mode |
|------|----------|------|
| [simple-deploy.test.yaml](../skills/squid-pipeline/examples/simple-deploy.test.yaml) | simple-deploy.yaml | Sandbox + integration |
| [sub-build.test.yaml](../skills/squid-pipeline/examples/sub-build.test.yaml) | sub-build.yaml | Sandbox + integration |

---

## AI Agent Skill

The [`skills/squid-pipeline/`](../skills/squid-pipeline/) directory is a standalone [Agent Skill](https://agentskills.io) that teaches any AI agent how to author Squid pipelines.

| File | Purpose |
|------|---------|
| [SKILL.md](../skills/squid-pipeline/SKILL.md) | Main skill instructions (~225 lines) |
| [references/step-types.md](../skills/squid-pipeline/references/step-types.md) | Full step type reference + common options |
| [references/patterns.md](../skills/squid-pipeline/references/patterns.md) | 9 workflow patterns + anti-patterns |
| [references/testing.md](../skills/squid-pipeline/references/testing.md) | Test modes, assertions, TypeScript API |

---

## Quick Reference

### CLI

```bash
squid run <file> [--args-json '{}'] [--dry-run] [-v]
squid test [file.test.yaml]
squid resume <file> --token <token> --approve yes|no
squid validate <file>
squid viz <file>
squid init --template basic|agent|parallel|full --name <name>
squid dev <file>
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SQUID_AGENT` | Default agent adapter: `openclaw`, `claude-code`, `opencode` |
| `OPENCLAW_URL` | OpenClaw gateway URL |
| `OPENCLAW_TOKEN` | Auth token for OpenClaw |
| `CLAUDE_MODEL` | Default model for Claude Code adapter |
| `OPENCODE_MODEL` | Default model for OpenCode adapter |

### Data Flow

| Pattern | Value |
|---------|-------|
| `$stepId.json` | Parsed JSON output |
| `$stepId.stdout` | Raw stdout |
| `$stepId.approved` | Gate boolean |
| `$stepId.json.input.field` | Gate structured input |
| `$args.key` | Pipeline argument |
| `$env.VAR` | Environment variable |
| `$item` / `$index` | Loop context |
