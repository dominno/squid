/**
 * Pipeline Graph Visualization
 *
 * Converts a Pipeline definition into a graph for Mermaid rendering.
 * Supports nested structures (parallel branches, loops, branch conditions).
 */

import type {
  Pipeline,
  Step,
  PipelineGraph,
  GraphNode,
  GraphEdge,
  StepResult,
} from "./types.js";

export function buildGraph(
  pipeline: Pipeline,
  results?: Map<string, StepResult>
): PipelineGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Start node
  nodes.push({ id: "__start", type: "run", label: "Start" });

  let prevId = "__start";

  for (const step of pipeline.steps) {
    addStepNodes(step, nodes, edges, results);

    edges.push({
      source: prevId,
      target: step.id,
      conditional: !!step.when,
      label: step.when ? `when: ${step.when}` : undefined,
    });

    prevId = step.id;
  }

  // End node
  nodes.push({ id: "__end", type: "run", label: "End" });
  edges.push({ source: prevId, target: "__end" });

  return { nodes, edges };
}

function addStepNodes(
  step: Step,
  nodes: GraphNode[],
  edges: GraphEdge[],
  results?: Map<string, StepResult>
): void {
  const status = results?.get(step.id)?.status;

  nodes.push({
    id: step.id,
    type: step.type,
    label: step.description ?? step.id,
    status,
    meta: { type: step.type },
  });

  // Add sub-nodes for complex types
  if (step.parallel?.branches) {
    for (const [branchName, branchSteps] of Object.entries(step.parallel.branches)) {
      for (const bs of branchSteps) {
        addStepNodes(bs, nodes, edges, results);
        edges.push({
          source: step.id,
          target: bs.id,
          label: branchName,
        });
      }
    }
  }

  if (step.loop?.steps) {
    for (const ls of step.loop.steps) {
      addStepNodes(ls, nodes, edges, results);
      edges.push({
        source: step.id,
        target: ls.id,
        label: "loop",
      });
    }
  }

  if (step.branch?.conditions) {
    for (const cond of step.branch.conditions) {
      for (const cs of cond.steps) {
        addStepNodes(cs, nodes, edges, results);
        edges.push({
          source: step.id,
          target: cs.id,
          label: cond.when,
          conditional: true,
        });
      }
    }
    if (step.branch.default) {
      for (const ds of step.branch.default) {
        addStepNodes(ds, nodes, edges, results);
        edges.push({
          source: step.id,
          target: ds.id,
          label: "default",
          conditional: true,
        });
      }
    }
  }
}

// ─── Mermaid Export ───────────────────────────────────────────────────

export function toMermaid(graph: PipelineGraph): string {
  const lines: string[] = ["graph TD"];

  for (const node of graph.nodes) {
    const shape = getNodeShape(node);
    const statusSuffix = node.status ? ` [${node.status}]` : "";
    lines.push(`  ${node.id}${shape.open}"${node.label}${statusSuffix}"${shape.close}`);
  }

  for (const edge of graph.edges) {
    const arrow = edge.conditional ? "-.->" : "-->";
    const label = edge.label ? `|${edge.label}|` : "";
    lines.push(`  ${edge.source} ${arrow}${label} ${edge.target}`);
  }

  // Add styling
  lines.push("");
  for (const node of graph.nodes) {
    if (node.status) {
      const color = getStatusColor(node.status);
      lines.push(`  style ${node.id} fill:${color}`);
    }
    if (node.type === "gate") {
      lines.push(`  style ${node.id} stroke:#f39c12,stroke-width:2px`);
    }
    if (node.type === "spawn") {
      lines.push(`  style ${node.id} stroke:#3498db,stroke-width:2px`);
    }
  }

  return lines.join("\n");
}

function getNodeShape(node: GraphNode): { open: string; close: string } {
  switch (node.type) {
    case "gate":
      return { open: "{", close: "}" };     // Diamond
    case "spawn":
      return { open: "[[", close: "]]" };   // Subroutine
    case "parallel":
      return { open: "[/", close: "/]" };   // Parallelogram
    case "branch":
      return { open: "{", close: "}" };     // Diamond
    case "loop":
      return { open: "((", close: "))" };   // Circle
    default:
      return { open: "[", close: "]" };     // Rectangle
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case "completed": return "#2ecc71";
    case "failed": return "#e74c3c";
    case "running": return "#3498db";
    case "skipped": return "#95a5a6";
    case "waiting_approval": return "#f39c12";
    case "retrying": return "#e67e22";
    default: return "#ecf0f1";
  }
}
