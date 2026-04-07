import { describe, it, expect } from "vitest";
import { parseAgentOutput } from "../src/core/json-extract.js";

describe("parseAgentOutput", () => {
  // --- Raw JSON (fast path) ---
  it("parses raw JSON object", () => {
    expect(parseAgentOutput('{"score": 85, "approved": true}')).toEqual({
      score: 85,
      approved: true,
    });
  });

  it("parses raw JSON array", () => {
    expect(parseAgentOutput('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("parses raw JSON with whitespace", () => {
    expect(parseAgentOutput('  \n {"key": "value"} \n  ')).toEqual({
      key: "value",
    });
  });

  // --- Markdown fence extraction ---
  it("extracts JSON from ```json fence", () => {
    const input = `Here is the review:

\`\`\`json
{"score": 92, "feedback": "Looks great"}
\`\`\`

That's my assessment.`;
    expect(parseAgentOutput(input)).toEqual({
      score: 92,
      feedback: "Looks great",
    });
  });

  it("extracts JSON from untyped ``` fence", () => {
    const input = `Result:
\`\`\`
{"approved": false, "issues": ["missing tests"]}
\`\`\``;
    expect(parseAgentOutput(input)).toEqual({
      approved: false,
      issues: ["missing tests"],
    });
  });

  it("extracts JSON from ```JSON fence (uppercase)", () => {
    const input = `\`\`\`JSON
{"count": 3}
\`\`\``;
    expect(parseAgentOutput(input)).toEqual({ count: 3 });
  });

  it("handles fence with extra whitespace", () => {
    const input = `\`\`\`json
  { "score": 75 }
\`\`\``;
    expect(parseAgentOutput(input)).toEqual({ score: 75 });
  });

  // --- Embedded JSON extraction ---
  it("extracts JSON embedded in prose", () => {
    const input = `After reviewing the code, I'd rate it as follows: {"score": 88, "approved": true} based on the quality.`;
    expect(parseAgentOutput(input)).toEqual({
      score: 88,
      approved: true,
    });
  });

  it("handles nested braces in embedded JSON", () => {
    const input = `Result: {"data": {"inner": {"deep": true}}, "count": 1}`;
    expect(parseAgentOutput(input)).toEqual({
      data: { inner: { deep: true } },
      count: 1,
    });
  });

  // --- Edge cases ---
  it("returns empty string for empty input", () => {
    expect(parseAgentOutput("")).toBe("");
  });

  it("returns trimmed string when no JSON found", () => {
    expect(parseAgentOutput("  Just some text  ")).toBe("Just some text");
  });

  it("returns plain text when braces don't form valid JSON", () => {
    const input = "function test() { return true; }";
    expect(parseAgentOutput(input)).toBe(input);
  });

  it("prefers fence over embedded JSON when both present", () => {
    // When raw JSON.parse fails (multiline with mixed content), fence wins
    const input = `{"wrong": true}
\`\`\`json
{"correct": true}
\`\`\``;
    expect(parseAgentOutput(input)).toEqual({ correct: true });
  });

  it("handles multiline JSON in fence", () => {
    const input = `\`\`\`json
{
  "score": 95,
  "issues": [],
  "feedback": "Excellent implementation"
}
\`\`\``;
    expect(parseAgentOutput(input)).toEqual({
      score: 95,
      issues: [],
      feedback: "Excellent implementation",
    });
  });

  // --- Real-world OpenClaw output patterns ---
  it("handles OpenClaw reviewer output with prose + JSON", () => {
    const input = `I've reviewed the implementation carefully. The code is well-structured and follows best practices.

Here is my assessment:

\`\`\`json
{"score": 82, "approved": true, "feedback": "Clean implementation with good error handling"}
\`\`\`

Let me know if you need more details.`;
    const result = parseAgentOutput(input) as Record<string, unknown>;
    expect(result.score).toBe(82);
    expect(result.approved).toBe(true);
  });

  it("handles agent output with only embedded JSON (no fence)", () => {
    const input = `The review score is {"score": 65, "approved": false, "feedback": "Missing edge case handling"} and I recommend revisions.`;
    const result = parseAgentOutput(input) as Record<string, unknown>;
    expect(result.score).toBe(65);
    expect(result.approved).toBe(false);
  });
});
