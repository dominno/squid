import { describe, it, expect } from "vitest";
import { parsePipeline, parseString, ParseError } from "../src/core/parser.js";

describe("parser", () => {
  describe("parsePipeline", () => {
    it("parses a minimal pipeline", () => {
      const pipeline = parsePipeline({
        name: "test",
        steps: [{ id: "s1", run: "echo hello" }],
      });

      expect(pipeline.name).toBe("test");
      expect(pipeline.steps).toHaveLength(1);
      expect(pipeline.steps[0].id).toBe("s1");
      expect(pipeline.steps[0].type).toBe("run");
      expect(pipeline.steps[0].run).toBe("echo hello");
    });

    it("parses args with defaults", () => {
      const pipeline = parsePipeline({
        name: "test",
        args: {
          env: { default: "staging", description: "Target env" },
          image: { required: true },
        },
        steps: [{ id: "s1", run: "echo" }],
      });

      expect(pipeline.args?.env.default).toBe("staging");
      expect(pipeline.args?.env.description).toBe("Target env");
      expect(pipeline.args?.image.required).toBe(true);
    });

    it("parses env and cwd", () => {
      const pipeline = parsePipeline({
        name: "test",
        env: { FOO: "bar" },
        cwd: "/tmp",
        steps: [{ id: "s1", run: "echo" }],
      });

      expect(pipeline.env).toEqual({ FOO: "bar" });
      expect(pipeline.cwd).toBe("/tmp");
    });

    it("throws on missing name", () => {
      expect(() => parsePipeline({ steps: [] })).toThrow(ParseError);
    });

    it("throws on missing steps", () => {
      expect(() => parsePipeline({ name: "test" })).toThrow("steps");
    });

    it("throws on duplicate step ids", () => {
      expect(() =>
        parsePipeline({
          name: "test",
          steps: [
            { id: "s1", run: "a" },
            { id: "s1", run: "b" },
          ],
        })
      ).toThrow("Duplicate step id");
    });
  });

  describe("step type inference", () => {
    it("infers run from 'run' key", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", run: "echo hi" }],
      });
      expect(p.steps[0].type).toBe("run");
    });

    it("infers run from 'command' key", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", command: "echo hi" }],
      });
      expect(p.steps[0].type).toBe("run");
      expect(p.steps[0].run).toBe("echo hi");
    });

    it("infers spawn from 'spawn' key", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", spawn: { task: "do something" } }],
      });
      expect(p.steps[0].type).toBe("spawn");
      expect(p.steps[0].spawn?.task).toBe("do something");
    });

    it("infers gate from 'gate' key", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", gate: "Approve?" }],
      });
      expect(p.steps[0].type).toBe("gate");
      expect(p.steps[0].gate?.prompt).toBe("Approve?");
    });

    it("uses explicit type over inference", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", type: "transform", transform: "$args.x" }],
      });
      expect(p.steps[0].type).toBe("transform");
    });

    it("throws when type cannot be inferred", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s" }] })
      ).toThrow("Cannot infer step type");
    });
  });

  describe("spawn config", () => {
    it("parses string shorthand", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", spawn: "do the thing" }],
      });
      expect(p.steps[0].spawn?.task).toBe("do the thing");
    });

    it("parses full spawn config", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            spawn: {
              task: "analyze code",
              agentId: "my-agent",
              model: "claude-sonnet-4-6",
              thinking: "high",
              runtime: "subagent",
              timeout: 300,
              mode: "run",
            },
          },
        ],
      });

      const spawn = p.steps[0].spawn!;
      expect(spawn.task).toBe("analyze code");
      expect(spawn.agentId).toBe("my-agent");
      expect(spawn.model).toBe("claude-sonnet-4-6");
      expect(spawn.thinking).toBe("high");
      expect(spawn.runtime).toBe("subagent");
      expect(spawn.timeout).toBe(300);
      expect(spawn.mode).toBe("run");
    });
  });

  describe("gate config", () => {
    it("parses string shorthand", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", gate: "Approve?" }],
      });
      expect(p.steps[0].gate?.prompt).toBe("Approve?");
    });

    it("parses boolean shorthand", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", gate: true }],
      });
      expect(p.steps[0].gate?.autoApprove).toBe(true);
    });

    it("parses full gate config", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            gate: {
              prompt: "Deploy?",
              preview: "summary here",
              timeout: 60,
              approvers: ["admin"],
            },
          },
        ],
      });

      const gate = p.steps[0].gate!;
      expect(gate.prompt).toBe("Deploy?");
      expect(gate.preview).toBe("summary here");
      expect(gate.timeout).toBe(60);
      expect(gate.approvers).toEqual(["admin"]);
    });
  });

  describe("parallel config", () => {
    it("parses parallel branches", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "p",
            parallel: {
              branches: {
                a: [{ id: "a1", run: "echo a" }],
                b: [{ id: "b1", run: "echo b" }],
              },
              maxConcurrent: 2,
              failFast: false,
              merge: "array",
            },
          },
        ],
      });

      const par = p.steps[0].parallel!;
      expect(Object.keys(par.branches)).toEqual(["a", "b"]);
      expect(par.branches.a[0].id).toBe("a1");
      expect(par.maxConcurrent).toBe(2);
      expect(par.failFast).toBe(false);
      expect(par.merge).toBe("array");
    });
  });

  describe("loop config", () => {
    it("parses loop", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "l",
            loop: {
              over: "$args.items",
              as: "item",
              maxConcurrent: 4,
              maxIterations: 100,
              steps: [{ id: "inner", run: "echo" }],
            },
          },
        ],
      });

      const loop = p.steps[0].loop!;
      expect(loop.over).toBe("$args.items");
      expect(loop.as).toBe("item");
      expect(loop.maxConcurrent).toBe(4);
      expect(loop.maxIterations).toBe(100);
      expect(loop.steps).toHaveLength(1);
    });
  });

  describe("branch config", () => {
    it("parses branch with conditions and default", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "br",
            branch: {
              conditions: [
                {
                  when: "$s1.json.type == \"error\"",
                  steps: [{ id: "handle-error", run: "echo error" }],
                },
              ],
              default: [{ id: "handle-ok", run: "echo ok" }],
            },
          },
        ],
      });

      const branch = p.steps[0].branch!;
      expect(branch.conditions).toHaveLength(1);
      expect(branch.conditions[0].when).toBe('$s1.json.type == "error"');
      expect(branch.default).toHaveLength(1);
    });
  });

  describe("retry config", () => {
    it("parses number shorthand", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", run: "echo", retry: 3 }],
      });
      expect(p.steps[0].retry?.maxAttempts).toBe(3);
    });

    it("parses full retry config", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            run: "curl example.com",
            retry: {
              maxAttempts: 5,
              backoff: "exponential-jitter",
              delayMs: 2000,
              maxDelayMs: 60000,
              retryOn: ["ECONNRESET"],
            },
          },
        ],
      });

      const retry = p.steps[0].retry!;
      expect(retry.maxAttempts).toBe(5);
      expect(retry.backoff).toBe("exponential-jitter");
      expect(retry.delayMs).toBe(2000);
      expect(retry.maxDelayMs).toBe(60000);
      expect(retry.retryOn).toEqual(["ECONNRESET"]);
    });
  });

  describe("optional step fields", () => {
    it("parses when, timeout, env, cwd, tags", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            run: "echo",
            when: "$prev.approved",
            timeout: 60,
            env: { KEY: "val" },
            cwd: "/tmp",
            tags: ["deploy", "prod"],
            description: "Deploy step",
          },
        ],
      });

      const step = p.steps[0];
      expect(step.when).toBe("$prev.approved");
      expect(step.timeout).toBe(60);
      expect(step.env).toEqual({ KEY: "val" });
      expect(step.cwd).toBe("/tmp");
      expect(step.tags).toEqual(["deploy", "prod"]);
      expect(step.description).toBe("Deploy step");
    });
  });

  describe("parseString", () => {
    it("parses YAML string", () => {
      const yaml = `
name: test
steps:
  - id: s1
    run: echo hello
`;
      const p = parseString(yaml, "yaml");
      expect(p.name).toBe("test");
      expect(p.steps[0].run).toBe("echo hello");
    });

    it("parses JSON string", () => {
      const json = JSON.stringify({
        name: "test",
        steps: [{ id: "s1", run: "echo hello" }],
      });
      const p = parseString(json, "json");
      expect(p.name).toBe("test");
    });
  });

  describe("onError strategy", () => {
    it("parses valid strategies", () => {
      for (const strategy of ["fail", "skip", "continue"]) {
        const p = parsePipeline({
          name: "t",
          steps: [{ id: "s", run: "echo" }],
          onError: strategy,
        });
        expect(p.onError).toBe(strategy);
      }
    });

    it("throws on invalid strategy", () => {
      expect(() =>
        parsePipeline({
          name: "t",
          steps: [{ id: "s", run: "echo" }],
          onError: "ignore",
        })
      ).toThrow("Invalid onError strategy");
    });
  });

  describe("pipeline ref config", () => {
    it("parses string shorthand", () => {
      const p = parsePipeline({
        name: "t",
        steps: [{ id: "s", pipeline: "./sub.yaml" }],
      });
      expect(p.steps[0].type).toBe("pipeline");
      expect(p.steps[0].pipeline?.file).toBe("./sub.yaml");
    });

    it("parses full pipeline config", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            pipeline: {
              file: "./build.yaml",
              args: { env: "prod", count: 5 },
              env: { VERBOSE: "1" },
              cwd: "/workspace",
            },
          },
        ],
      });

      const ref = p.steps[0].pipeline!;
      expect(ref.file).toBe("./build.yaml");
      expect(ref.args).toEqual({ env: "prod", count: 5 });
      expect(ref.env).toEqual({ VERBOSE: "1" });
      expect(ref.cwd).toBe("/workspace");
    });

    it("parses pipeline with $ref args", () => {
      const p = parsePipeline({
        name: "t",
        steps: [
          {
            id: "s",
            pipeline: {
              file: "./sub.yaml",
              args: { target: "$args.env", data: "$fetch.json" },
            },
          },
        ],
      });

      const ref = p.steps[0].pipeline!;
      expect(ref.args?.target).toBe("$args.env");
      expect(ref.args?.data).toBe("$fetch.json");
    });
  });

  describe("YAML validation errors", () => {
    it("throws on non-object input", () => {
      expect(() => parsePipeline("not an object")).toThrow("Pipeline must be a YAML/JSON object");
      expect(() => parsePipeline(null)).toThrow("Pipeline must be a YAML/JSON object");
      expect(() => parsePipeline(42)).toThrow("Pipeline must be a YAML/JSON object");
    });

    it("throws on missing name", () => {
      expect(() => parsePipeline({ steps: [] })).toThrow("Missing required field 'name'");
    });

    it("throws on missing steps", () => {
      expect(() => parsePipeline({ name: "t" })).toThrow("must have a 'steps' array");
    });

    it("throws on steps not being an array", () => {
      expect(() => parsePipeline({ name: "t", steps: "not-array" })).toThrow("must have a 'steps' array");
    });

    it("throws on step without id", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ run: "echo" }] })
      ).toThrow("Missing required field 'id'");
    });

    it("throws on step with unknown type", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s" }] })
      ).toThrow("Cannot infer step type");
    });

    it("throws on duplicate step ids", () => {
      expect(() =>
        parsePipeline({
          name: "t",
          steps: [
            { id: "dup", run: "a" },
            { id: "dup", run: "b" },
          ],
        })
      ).toThrow("Duplicate step id 'dup'");
    });

    it("throws on invalid spawn config", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", spawn: 42 }] })
      ).toThrow("must be a string or object");
    });

    it("throws on spawn without task", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", spawn: { agentId: "x" } }] })
      ).toThrow("Missing required field 'task'");
    });

    it("throws on parallel without branches", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", parallel: {} }] })
      ).toThrow("branches must be an object");
    });

    it("throws on loop without steps", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", loop: { over: "$x" } }] })
      ).toThrow("steps must be an array");
    });

    it("throws on branch without conditions", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", branch: {} }] })
      ).toThrow("conditions must be an array");
    });

    it("throws on invalid pipeline ref", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", pipeline: 42 }] })
      ).toThrow("must be a string or object");
    });

    it("throws on pipeline ref without file", () => {
      expect(() =>
        parsePipeline({ name: "t", steps: [{ id: "s", pipeline: { args: {} } }] })
      ).toThrow("Missing required field 'file'");
    });

    it("includes source path in error messages", () => {
      expect(() =>
        parsePipeline({ steps: [] }, "/path/to/pipeline.yaml")
      ).toThrow("(in /path/to/pipeline.yaml)");
    });

    it("validates nested step ids in parallel branches", () => {
      expect(() =>
        parsePipeline({
          name: "t",
          steps: [
            { id: "s", run: "echo" },
            {
              id: "p",
              parallel: {
                branches: {
                  a: [{ id: "s", run: "echo" }], // duplicate "s"
                },
              },
            },
          ],
        })
      ).toThrow("Duplicate step id 's'");
    });

    it("validates parseString with invalid YAML", () => {
      expect(() => parseString("{{invalid yaml", "yaml")).toThrow();
    });

    it("validates parseString with invalid JSON", () => {
      expect(() => parseString("{bad json", "json")).toThrow();
    });
  });
});
