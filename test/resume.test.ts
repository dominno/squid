import { describe, it, expect } from "vitest";
import { encodeResumeToken, decodeResumeToken } from "../src/core/resume.js";
import type { ResumeToken } from "../src/core/types.js";

describe("resume tokens", () => {
  const token: ResumeToken = {
    version: 1,
    pipelineId: "deploy",
    runId: "run-abc-123",
    resumeAtStep: "approve",
    completedResults: {
      build: {
        stepId: "build",
        status: "completed",
        output: { image: "myapp:v2" },
      },
      test: {
        stepId: "test",
        status: "completed",
        output: { passed: true },
      },
    },
    args: { env: "staging", image: "myapp:v2" },
    createdAt: 1700000000000,
  };

  it("roundtrips encode → decode", () => {
    const encoded = encodeResumeToken(token);
    const decoded = decodeResumeToken(encoded);

    expect(decoded.version).toBe(1);
    expect(decoded.pipelineId).toBe("deploy");
    expect(decoded.runId).toBe("run-abc-123");
    expect(decoded.resumeAtStep).toBe("approve");
    expect(decoded.args).toEqual({ env: "staging", image: "myapp:v2" });
    expect(decoded.completedResults.build.output).toEqual({ image: "myapp:v2" });
    expect(decoded.createdAt).toBe(1700000000000);
  });

  it("produces URL-safe base64", () => {
    const encoded = encodeResumeToken(token);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("throws on malformed token", () => {
    expect(() => decodeResumeToken("not-valid-base64!!!")).toThrow("Malformed");
  });

  it("throws on unsupported version", () => {
    const bad = { ...token, version: 99 };
    const encoded = Buffer.from(JSON.stringify(bad)).toString("base64url");
    expect(() => decodeResumeToken(encoded)).toThrow("Unsupported resume token version");
  });

  it("throws on missing required fields", () => {
    const bad = { version: 1, pipelineId: "x" }; // missing runId, resumeAtStep
    const encoded = Buffer.from(JSON.stringify(bad)).toString("base64url");
    expect(() => decodeResumeToken(encoded)).toThrow("missing required fields");
  });

  it("preserves gateDecision", () => {
    const withGate: ResumeToken = { ...token, gateDecision: true };
    const encoded = encodeResumeToken(withGate);
    const decoded = decodeResumeToken(encoded);
    expect(decoded.gateDecision).toBe(true);
  });
});
