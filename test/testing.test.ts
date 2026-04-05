import { describe, it, expect } from "vitest";
import { createTestRunner } from "../src/testing/index.js";
import type { Pipeline } from "../src/core/types.js";

describe("TestRunner", () => {
  const pipeline: Pipeline = {
    name: "test-pipeline",
    steps: [
      { id: "research", type: "spawn", spawn: { task: "Research AI" } },
      { id: "review", type: "gate", gate: { prompt: "Approve research?" } },
      { id: "implement", type: "run", run: "echo implemented" },
    ],
  };

  it("runs pipeline with mocked spawn and auto-approved gate", async () => {
    const result = await createTestRunner()
      .mockSpawn("research", { output: { findings: ["fact1", "fact2"] } })
      .approveGate("review")
      .run(pipeline);

    expect(result.status).toBe("completed");
    result.assertStepCompleted("review");
    result.assertStepCompleted("implement");
  });

  it("rejects gate and skips subsequent conditional steps", async () => {
    const conditionalPipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "gate", type: "gate", gate: { prompt: "OK?" } },
        { id: "after", type: "run", run: "echo ran", when: "$gate.approved" },
      ],
    };

    const result = await createTestRunner()
      .rejectGate("gate")
      .run(conditionalPipeline);

    expect(result.status).toBe("completed");
    const afterResult = result.getStepResult("after");
    expect(afterResult?.status).toBe("skipped");
  });

  it("provides step results via getStepResult", async () => {
    const simplePipeline: Pipeline = {
      name: "test",
      steps: [{ id: "echo", type: "run", run: "echo hello" }],
    };

    const result = await createTestRunner().run(simplePipeline);
    const echoResult = result.getStepResult("echo");
    expect(echoResult?.stdout).toBe("hello");
  });

  it("assertStepCompleted throws for non-existent step", async () => {
    const simplePipeline: Pipeline = {
      name: "test",
      steps: [{ id: "s1", type: "run", run: "echo ok" }],
    };

    const result = await createTestRunner().run(simplePipeline);
    expect(() => result.assertStepCompleted("nonexistent")).toThrow("was not executed");
  });

  it("assertStepSkipped works", async () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: 'echo \'{"go":false}\'' },
        { id: "s2", type: "run", run: "echo skipped", when: "$s1.json.go" },
      ],
    };

    const result = await createTestRunner().run(pipeline);
    result.assertStepSkipped("s2");
  });

  it("withArgs passes arguments to pipeline", async () => {
    const argPipeline: Pipeline = {
      name: "test",
      args: { name: { required: true } },
      steps: [{ id: "greet", type: "run", run: "echo ${args.name}" }],
    };

    const result = await createTestRunner()
      .withArgs({ name: "Dominik" })
      .run(argPipeline);

    expect(result.getStepResult("greet")?.stdout).toBe("Dominik");
  });

  it("captures all steps executed", async () => {
    const multiPipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "a", type: "run", run: "echo a" },
        { id: "b", type: "run", run: "echo b" },
        { id: "c", type: "run", run: "echo c" },
      ],
    };

    const result = await createTestRunner().run(multiPipeline);
    expect(result.capturedSteps).toHaveLength(3);
    expect(result.capturedSteps.map((c) => c.step.id)).toEqual(["a", "b", "c"]);
  });
});
