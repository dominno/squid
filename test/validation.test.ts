/**
 * Tests for YAML syntax validation — verifies the parser rejects invalid values
 * with clear error messages for all enum/numeric fields.
 */

import { describe, it, expect } from "vitest";
import { parsePipeline, ParseError } from "../src/core/parser.js";

describe("step type validation", () => {
  it("rejects invalid step type", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", type: "invalid" }] })
    ).toThrow("Invalid step type 'invalid'");
  });

  it("error lists valid types", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", type: "foo" }] })
    ).toThrow("run, spawn, gate, parallel, loop, branch, transform, pipeline");
  });
});

describe("spawn validation", () => {
  it("rejects invalid thinking value", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", thinking: "mega" } }] })
    ).toThrow("Invalid value 'mega' for thinking");
  });

  it("accepts valid thinking values", () => {
    for (const val of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      const p = parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", thinking: val } }] });
      expect(p.steps[0].spawn?.thinking).toBe(val);
    }
  });

  it("rejects invalid runtime value", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", runtime: "docker" } }] })
    ).toThrow("Invalid value 'docker' for runtime");
  });

  it("rejects invalid mode value", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", mode: "daemon" } }] })
    ).toThrow("Invalid value 'daemon' for mode");
  });

  it("rejects invalid sandbox value", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", sandbox: "none" } }] })
    ).toThrow("Invalid value 'none' for sandbox");
  });

  it("rejects negative timeout", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", timeout: -1 } }] })
    ).toThrow("must be a positive number");
  });

  it("rejects zero timeout", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", spawn: { task: "x", timeout: 0 } }] })
    ).toThrow("must be a positive number");
  });
});

describe("parallel validation", () => {
  it("rejects invalid merge value", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{
          id: "p",
          parallel: {
            branches: { a: [{ id: "a1", run: "echo" }] },
            merge: "concat",
          },
        }],
      })
    ).toThrow("Invalid value 'concat' for merge");
  });

  it("error lists valid merge values", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{
          id: "p",
          parallel: {
            branches: { a: [{ id: "a1", run: "echo" }] },
            merge: "bad",
          },
        }],
      })
    ).toThrow("object, array, first");
  });
});

describe("retry validation", () => {
  it("rejects invalid backoff value", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{ id: "s", run: "echo", retry: { maxAttempts: 3, backoff: "linear" } }],
      })
    ).toThrow("Invalid value 'linear' for backoff");
  });

  it("error lists valid backoff values", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{ id: "s", run: "echo", retry: { maxAttempts: 3, backoff: "bad" } }],
      })
    ).toThrow("fixed, exponential, exponential-jitter");
  });
});

describe("step timeout validation", () => {
  it("rejects negative step timeout", () => {
    expect(() =>
      parsePipeline({ name: "t", steps: [{ id: "s", run: "echo", timeout: -5 }] })
    ).toThrow("must be a positive number");
  });

  it("accepts valid timeout", () => {
    const p = parsePipeline({ name: "t", steps: [{ id: "s", run: "echo", timeout: 300 }] });
    expect(p.steps[0].timeout).toBe(300);
  });
});

describe("gate input field validation", () => {
  it("rejects input field without name", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{
          id: "g",
          gate: {
            prompt: "OK?",
            input: [{ type: "string" }],
          },
        }],
      })
    ).toThrow("must have a 'name' field");
  });

  it("rejects invalid input field type", () => {
    expect(() =>
      parsePipeline({
        name: "t",
        steps: [{
          id: "g",
          gate: {
            prompt: "OK?",
            input: [{ name: "x", type: "date" }],
          },
        }],
      })
    ).toThrow("Invalid value 'date' for input[0].type");
  });

  it("accepts all valid input field types", () => {
    for (const type of ["string", "number", "boolean", "select"]) {
      const p = parsePipeline({
        name: "t",
        steps: [{
          id: "g",
          gate: {
            prompt: "OK?",
            input: [{ name: "x", type }],
          },
        }],
      });
      expect(p.steps[0].gate?.input?.[0].type).toBe(type);
    }
  });

  it("defaults input field type to string", () => {
    const p = parsePipeline({
      name: "t",
      steps: [{
        id: "g",
        gate: {
          prompt: "OK?",
          input: [{ name: "x" }],
        },
      }],
    });
    expect(p.steps[0].gate?.input?.[0].type).toBe("string");
  });
});

describe("validation error messages include path", () => {
  it("spawn errors include step path", () => {
    try {
      parsePipeline({
        name: "t",
        steps: [{ id: "s", spawn: { task: "x", thinking: "bad" } }],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("steps[0].spawn");
    }
  });

  it("gate input errors include field index", () => {
    try {
      parsePipeline({
        name: "t",
        steps: [{
          id: "g",
          gate: {
            prompt: "OK?",
            input: [
              { name: "ok", type: "string" },
              { name: "bad", type: "xml" },
            ],
          },
        }],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("input[1].type");
    }
  });
});
