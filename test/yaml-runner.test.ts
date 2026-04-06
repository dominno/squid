import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { runTestFile } from "../src/testing/yaml-runner.js";

const fixtureDir = resolve(import.meta.dirname ?? ".", "fixtures");

function writeFixture(name: string, content: string): string {
  mkdirSync(fixtureDir, { recursive: true });
  const path = resolve(fixtureDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function cleanup(...files: string[]) {
  for (const f of files) {
    try { unlinkSync(f); } catch {}
  }
}

describe("YAML test runner", () => {
  it("runs sandbox test with mocked run steps", async () => {
    const pipelinePath = writeFixture("test-pipe.yaml", `
name: test-pipe
steps:
  - id: greet
    type: run
    run: echo hello
`);
    const testPath = writeFixture("test-pipe.test.yaml", `
pipeline: ./test-pipe.yaml
tests:
  - name: "greet completes"
    mode: sandbox
    mocks:
      run:
        greet:
          output: "hello"
    assert:
      status: completed
      steps:
        greet: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.total).toBe(1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0].name).toBe("greet completes");
      expect(result.results[0].passed).toBe(true);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("runs integration test with real commands", async () => {
    const pipelinePath = writeFixture("echo-pipe.yaml", `
name: echo-pipe
args:
  msg: { default: world }
steps:
  - id: say
    type: run
    run: echo \${args.msg}
`);
    const testPath = writeFixture("echo-pipe.test.yaml", `
pipeline: ./echo-pipe.yaml
tests:
  - name: "echo runs for real"
    mode: integration
    args:
      msg: squid
    assert:
      status: completed
      steps:
        say: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.passed).toBe(1);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("detects assertion failures", async () => {
    const pipelinePath = writeFixture("fail-pipe.yaml", `
name: fail-pipe
steps:
  - id: ok
    type: run
    run: echo done
`);
    const testPath = writeFixture("fail-pipe.test.yaml", `
pipeline: ./fail-pipe.yaml
tests:
  - name: "expects wrong status"
    mode: sandbox
    mocks:
      run:
        ok:
          output: done
    assert:
      status: failed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.failed).toBe(1);
      expect(result.results[0].passed).toBe(false);
      expect(result.results[0].errors[0]).toContain("Expected pipeline status 'failed'");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("detects step status assertion failures", async () => {
    const pipelinePath = writeFixture("step-assert.yaml", `
name: step-assert
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("step-assert.test.yaml", `
pipeline: ./step-assert.yaml
tests:
  - name: "expects step skipped but its completed"
    mode: sandbox
    mocks:
      run:
        s1:
          output: ok
    assert:
      steps:
        s1: skipped
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.failed).toBe(1);
      expect(result.results[0].errors[0]).toContain("expected status 'skipped'");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("tests spawn mocks", async () => {
    const pipelinePath = writeFixture("spawn-pipe.yaml", `
name: spawn-pipe
steps:
  - id: agent
    type: spawn
    spawn:
      task: "do something"
`);
    const testPath = writeFixture("spawn-pipe.test.yaml", `
pipeline: ./spawn-pipe.yaml
tests:
  - name: "spawn returns mock"
    mode: sandbox
    mocks:
      spawn:
        agent:
          output: { result: analyzed }
    assert:
      status: completed
      steps:
        agent: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.passed).toBe(1);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("tests gate mocks", async () => {
    const pipelinePath = writeFixture("gate-pipe.yaml", `
name: gate-pipe
steps:
  - id: approve
    type: gate
    gate: "OK?"
  - id: after
    type: run
    run: echo done
    when: \$approve.approved
`);
    const testPath = writeFixture("gate-pipe.test.yaml", `
pipeline: ./gate-pipe.yaml
tests:
  - name: "gate approved"
    mode: sandbox
    gates:
      approve: true
    mocks:
      run:
        after:
          output: done
    assert:
      status: completed
      steps:
        approve: completed
        after: completed

  - name: "gate rejected"
    mode: sandbox
    gates:
      approve: false
    assert:
      status: completed
      steps:
        approve: skipped
        after: skipped
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.total).toBe(2);
      expect(result.passed).toBe(2);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("asserts on output value", async () => {
    const pipelinePath = writeFixture("output-pipe.yaml", `
name: output-pipe
steps:
  - id: data
    type: run
    run: "echo '{\\\"count\\\": 42}'"
`);
    const testPath = writeFixture("output-pipe.test.yaml", `
pipeline: ./output-pipe.yaml
tests:
  - name: "checks output"
    mode: sandbox
    mocks:
      run:
        data:
          output:
            count: 42
    assert:
      status: completed
      output:
        count: 42
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.passed).toBe(1);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("asserts on step output with outputContains", async () => {
    const pipelinePath = writeFixture("contains-pipe.yaml", `
name: contains-pipe
steps:
  - id: msg
    type: run
    run: echo hello
`);
    const testPath = writeFixture("contains-pipe.test.yaml", `
pipeline: ./contains-pipe.yaml
tests:
  - name: "output contains hello"
    mode: integration
    assert:
      steps:
        msg:
          outputContains: hello

  - name: "output does not contain goodbye"
    mode: integration
    assert:
      steps:
        msg:
          outputContains: goodbye
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.results[0].passed).toBe(true);
      expect(result.results[1].passed).toBe(false);
      expect(result.results[1].errors[0]).toContain("does not contain 'goodbye'");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("reports missing steps in assertions", async () => {
    const pipelinePath = writeFixture("missing-pipe.yaml", `
name: missing-pipe
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("missing-pipe.test.yaml", `
pipeline: ./missing-pipe.yaml
tests:
  - name: "asserts on non-existent step"
    mode: sandbox
    mocks:
      run:
        s1:
          output: ok
    assert:
      steps:
        nonexistent: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.failed).toBe(1);
      expect(result.results[0].errors[0]).toContain("was not executed");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("throws on missing pipeline field", async () => {
    const testPath = writeFixture("no-pipe.test.yaml", `
tests:
  - name: "no pipeline"
    assert:
      status: completed
`);

    try {
      await expect(runTestFile(testPath)).rejects.toThrow("pipeline");
    } finally {
      cleanup(testPath);
    }
  });

  it("asserts on step output with outputPath", async () => {
    const pipelinePath = writeFixture("path-pipe.yaml", `
name: path-pipe
steps:
  - id: data
    type: run
    run: echo ok
`);
    const testPath = writeFixture("path-pipe.test.yaml", `
pipeline: ./path-pipe.yaml
tests:
  - name: "outputPath matches"
    mode: sandbox
    mocks:
      run:
        data:
          output:
            nested:
              value: 42
    assert:
      steps:
        data:
          outputPath: nested.value
          equals: 42

  - name: "outputPath mismatch"
    mode: sandbox
    mocks:
      run:
        data:
          output:
            nested:
              value: 99
    assert:
      steps:
        data:
          outputPath: nested.value
          equals: 42
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.results[0].passed).toBe(true);
      expect(result.results[1].passed).toBe(false);
      expect(result.results[1].errors[0]).toContain("nested.value");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("asserts step status with object form", async () => {
    const pipelinePath = writeFixture("status-obj.yaml", `
name: status-obj
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("status-obj.test.yaml", `
pipeline: ./status-obj.yaml
tests:
  - name: "status object form"
    mode: sandbox
    mocks:
      run:
        s1:
          output: ok
    assert:
      steps:
        s1:
          status: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.passed).toBe(1);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("asserts step output with object form", async () => {
    const pipelinePath = writeFixture("output-obj.yaml", `
name: output-obj
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("output-obj.test.yaml", `
pipeline: ./output-obj.yaml
tests:
  - name: "output match"
    mode: sandbox
    mocks:
      run:
        s1:
          output: hello
    assert:
      steps:
        s1:
          output: hello

  - name: "output mismatch"
    mode: sandbox
    mocks:
      run:
        s1:
          output: hello
    assert:
      steps:
        s1:
          output: goodbye
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.results[0].passed).toBe(true);
      expect(result.results[1].passed).toBe(false);
      expect(result.results[1].errors[0]).toContain("expected output");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("asserts pipeline output mismatch", async () => {
    const pipelinePath = writeFixture("out-mismatch.yaml", `
name: out-mismatch
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("out-mismatch.test.yaml", `
pipeline: ./out-mismatch.yaml
tests:
  - name: "output mismatch"
    mode: sandbox
    mocks:
      run:
        s1:
          output: actual
    assert:
      output: expected
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.failed).toBe(1);
      expect(result.results[0].errors[0]).toContain("Expected pipeline output");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("handles pipeline error gracefully", async () => {
    const pipelinePath = writeFixture("error-pipe.yaml", `
name: error-pipe
args:
  required_arg:
    required: true
steps:
  - id: s1
    type: run
    run: echo ok
`);
    const testPath = writeFixture("error-pipe.test.yaml", `
pipeline: ./error-pipe.yaml
tests:
  - name: "missing required arg throws"
    mode: sandbox
    assert:
      status: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.failed).toBe(1);
      expect(result.results[0].errors[0]).toContain("Pipeline threw");
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });

  it("throws on empty tests array", async () => {
    const testPath = writeFixture("empty.test.yaml", `
pipeline: ./some.yaml
tests: []
`);

    try {
      await expect(runTestFile(testPath)).rejects.toThrow("tests");
    } finally {
      cleanup(testPath);
    }
  });

  it("sandbox mode does not execute run steps", async () => {
    // This command would fail if actually executed
    const pipelinePath = writeFixture("dangerous.yaml", `
name: dangerous
steps:
  - id: danger
    type: run
    run: exit 1
`);
    const testPath = writeFixture("dangerous.test.yaml", `
pipeline: ./dangerous.yaml
tests:
  - name: "sandbox does not execute"
    mode: sandbox
    assert:
      status: completed
      steps:
        danger: completed
`);

    try {
      const result = await runTestFile(testPath);
      expect(result.passed).toBe(1);
    } finally {
      cleanup(pipelinePath, testPath);
    }
  });
});
