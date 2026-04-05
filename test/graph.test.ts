import { describe, it, expect } from "vitest";
import { buildGraph, toMermaid } from "../src/core/graph.js";
import type { Pipeline, StepResult } from "../src/core/types.js";

describe("buildGraph", () => {
  it("builds graph for simple linear pipeline", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: "echo 1" },
        { id: "s2", type: "run", run: "echo 2" },
      ],
    };

    const graph = buildGraph(pipeline);

    expect(graph.nodes).toHaveLength(4); // __start, s1, s2, __end
    expect(graph.nodes[0].id).toBe("__start");
    expect(graph.nodes[1].id).toBe("s1");
    expect(graph.nodes[2].id).toBe("s2");
    expect(graph.nodes[3].id).toBe("__end");

    // Edges: start→s1, s1→s2, s2→end
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]).toEqual({ source: "__start", target: "s1", conditional: false, label: undefined });
    expect(graph.edges[1]).toEqual({ source: "s1", target: "s2", conditional: false, label: undefined });
    expect(graph.edges[2]).toEqual({ source: "s2", target: "__end" });
  });

  it("marks conditional edges for steps with 'when'", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "gate", type: "gate", gate: { prompt: "OK?" } },
        { id: "deploy", type: "run", run: "echo", when: "$gate.approved" },
      ],
    };

    const graph = buildGraph(pipeline);
    const deployEdge = graph.edges.find((e) => e.target === "deploy");
    expect(deployEdge?.conditional).toBe(true);
    expect(deployEdge?.label).toBe("when: $gate.approved");
  });

  it("includes step status from results", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: "echo" },
        { id: "s2", type: "run", run: "echo" },
      ],
    };

    const results = new Map<string, StepResult>([
      ["s1", { stepId: "s1", status: "completed" }],
      ["s2", { stepId: "s2", status: "failed" }],
    ]);

    const graph = buildGraph(pipeline, results);
    expect(graph.nodes.find((n) => n.id === "s1")?.status).toBe("completed");
    expect(graph.nodes.find((n) => n.id === "s2")?.status).toBe("failed");
  });

  it("adds sub-nodes for parallel branches", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "par",
          type: "parallel",
          parallel: {
            branches: {
              a: [{ id: "a1", type: "run", run: "echo a" }],
              b: [{ id: "b1", type: "run", run: "echo b" }],
            },
          },
        },
      ],
    };

    const graph = buildGraph(pipeline);
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("par");
    expect(nodeIds).toContain("a1");
    expect(nodeIds).toContain("b1");

    // par has edges to a1, b1 (branch sub-nodes) + 1 from main flow
    const parBranchEdges = graph.edges.filter((e) => e.source === "par" && e.label);
    expect(parBranchEdges).toHaveLength(2);
    expect(parBranchEdges.map((e) => e.label)).toContain("a");
    expect(parBranchEdges.map((e) => e.label)).toContain("b");
  });

  it("adds sub-nodes for loop steps", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "loop",
          type: "loop",
          loop: {
            over: "$data.json",
            steps: [{ id: "inner", type: "run", run: "echo" }],
          },
        },
      ],
    };

    const graph = buildGraph(pipeline);
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("loop");
    expect(nodeIds).toContain("inner");

    const loopEdge = graph.edges.find((e) => e.source === "loop" && e.target === "inner");
    expect(loopEdge?.label).toBe("loop");
  });

  it("adds sub-nodes for branch conditions and default", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "br",
          type: "branch",
          branch: {
            conditions: [
              {
                when: "$x.ready",
                steps: [{ id: "handle-yes", type: "run", run: "echo yes" }],
              },
            ],
            default: [{ id: "handle-no", type: "run", run: "echo no" }],
          },
        },
      ],
    };

    const graph = buildGraph(pipeline);
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("handle-yes");
    expect(nodeIds).toContain("handle-no");

    const condEdge = graph.edges.find((e) => e.target === "handle-yes");
    expect(condEdge?.conditional).toBe(true);
    expect(condEdge?.label).toBe("$x.ready");

    const defaultEdge = graph.edges.find((e) => e.target === "handle-no");
    expect(defaultEdge?.conditional).toBe(true);
    expect(defaultEdge?.label).toBe("default");
  });

  it("sets correct type metadata on nodes", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "r", type: "run", run: "echo" },
        { id: "s", type: "spawn", spawn: { task: "x" } },
        { id: "g", type: "gate", gate: { prompt: "?" } },
        { id: "t", type: "transform", transform: "$r.json" },
      ],
    };

    const graph = buildGraph(pipeline);
    expect(graph.nodes.find((n) => n.id === "r")?.type).toBe("run");
    expect(graph.nodes.find((n) => n.id === "s")?.type).toBe("spawn");
    expect(graph.nodes.find((n) => n.id === "g")?.type).toBe("gate");
    expect(graph.nodes.find((n) => n.id === "t")?.type).toBe("transform");
  });

  it("uses description as label when available", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: "echo", description: "Build project" },
        { id: "s2", type: "run", run: "echo" },
      ],
    };

    const graph = buildGraph(pipeline);
    expect(graph.nodes.find((n) => n.id === "s1")?.label).toBe("Build project");
    expect(graph.nodes.find((n) => n.id === "s2")?.label).toBe("s2");
  });
});

describe("toMermaid", () => {
  it("generates valid Mermaid syntax", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "build", type: "run", run: "echo", description: "Build" },
        { id: "approve", type: "gate", gate: { prompt: "OK?" }, description: "Approve" },
        { id: "deploy", type: "run", run: "echo", when: "$approve.approved", description: "Deploy" },
      ],
    };

    const graph = buildGraph(pipeline);
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain("graph TD");
    expect(mermaid).toContain("__start");
    expect(mermaid).toContain("__end");
    // Gate should be diamond shape
    expect(mermaid).toContain('approve{"Approve"}');
    // Run should be rectangle
    expect(mermaid).toContain('build["Build"]');
    // Conditional edge should use dotted arrow
    expect(mermaid).toContain("-.->|when: $approve.approved|");
    // Gate styling
    expect(mermaid).toContain("style approve stroke:#f39c12");
  });

  it("applies status colors", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "s1", type: "run", run: "echo" },
        { id: "s2", type: "run", run: "echo" },
        { id: "s3", type: "run", run: "echo" },
      ],
    };

    const results = new Map<string, StepResult>([
      ["s1", { stepId: "s1", status: "completed" }],
      ["s2", { stepId: "s2", status: "failed" }],
      ["s3", { stepId: "s3", status: "waiting_approval" }],
    ]);

    const graph = buildGraph(pipeline, results);
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain("style s1 fill:#2ecc71"); // green
    expect(mermaid).toContain("style s2 fill:#e74c3c"); // red
    expect(mermaid).toContain("style s3 fill:#f39c12"); // orange
  });

  it("renders spawn nodes with subroutine shape", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "agent", type: "spawn", spawn: { task: "analyze" }, description: "AI Agent" },
      ],
    };

    const graph = buildGraph(pipeline);
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain('agent[["AI Agent"]]');
    expect(mermaid).toContain("style agent stroke:#3498db");
  });

  it("renders loop nodes with circle shape", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "loop",
          type: "loop",
          description: "Process items",
          loop: { over: "$data.json", steps: [{ id: "inner", type: "run", run: "echo" }] },
        },
      ],
    };

    const graph = buildGraph(pipeline);
    const mermaid = toMermaid(graph);
    expect(mermaid).toContain('loop(("Process items"))');
  });

  it("renders parallel nodes with parallelogram shape", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        {
          id: "par",
          type: "parallel",
          description: "Fan out",
          parallel: { branches: { a: [{ id: "a1", type: "run", run: "echo" }] } },
        },
      ],
    };

    const graph = buildGraph(pipeline);
    const mermaid = toMermaid(graph);
    expect(mermaid).toContain('par[/"Fan out"/]');
  });

  it("handles all status colors", () => {
    const pipeline: Pipeline = {
      name: "test",
      steps: [
        { id: "a", type: "run", run: "echo" },
        { id: "b", type: "run", run: "echo" },
        { id: "c", type: "run", run: "echo" },
        { id: "d", type: "run", run: "echo" },
        { id: "e", type: "run", run: "echo" },
        { id: "f", type: "run", run: "echo" },
      ],
    };

    const results = new Map<string, StepResult>([
      ["a", { stepId: "a", status: "completed" }],
      ["b", { stepId: "b", status: "failed" }],
      ["c", { stepId: "c", status: "running" }],
      ["d", { stepId: "d", status: "skipped" }],
      ["e", { stepId: "e", status: "waiting_approval" }],
      ["f", { stepId: "f", status: "retrying" }],
    ]);

    const graph = buildGraph(pipeline, results);
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain("fill:#2ecc71"); // completed
    expect(mermaid).toContain("fill:#e74c3c"); // failed
    expect(mermaid).toContain("fill:#3498db"); // running
    expect(mermaid).toContain("fill:#95a5a6"); // skipped
    expect(mermaid).toContain("fill:#f39c12"); // waiting_approval
    expect(mermaid).toContain("fill:#e67e22"); // retrying
  });
});
