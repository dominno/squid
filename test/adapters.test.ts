import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  resolveAdapter,
} from "../src/core/adapters/registry.js";
import type { AgentAdapter } from "../src/core/types.js";

function mockAdapter(name: string): AgentAdapter {
  return {
    name,
    async spawn() {
      return { status: "accepted", output: { adapter: name } };
    },
    async waitForCompletion() {
      return { stepId: "", status: "completed", output: {} };
    },
    async getSessionStatus() {
      return "completed" as const;
    },
  };
}

describe("adapter registry", () => {
  beforeEach(() => {
    // Register a known adapter for tests
    registerAdapter(mockAdapter("test-adapter"));
    registerAdapter(mockAdapter("another-adapter"));
  });

  describe("registerAdapter", () => {
    it("registers an adapter by name", () => {
      registerAdapter(mockAdapter("new-one"));
      expect(getAdapter("new-one")).toBeDefined();
      expect(getAdapter("new-one")?.name).toBe("new-one");
    });

    it("overwrites existing adapter with same name", () => {
      const first = mockAdapter("overwrite-me");
      const second = mockAdapter("overwrite-me");
      registerAdapter(first);
      registerAdapter(second);
      expect(getAdapter("overwrite-me")).toBe(second);
    });
  });

  describe("getAdapter", () => {
    it("returns adapter by name", () => {
      const adapter = getAdapter("test-adapter");
      expect(adapter).toBeDefined();
      expect(adapter?.name).toBe("test-adapter");
    });

    it("returns undefined for unknown name", () => {
      expect(getAdapter("nonexistent")).toBeUndefined();
    });
  });

  describe("listAdapters", () => {
    it("returns all registered adapter names", () => {
      const names = listAdapters();
      expect(names).toContain("test-adapter");
      expect(names).toContain("another-adapter");
    });
  });

  describe("resolveAdapter", () => {
    it("resolves step-level agent first", () => {
      const adapter = resolveAdapter("test-adapter", "another-adapter");
      expect(adapter.name).toBe("test-adapter");
    });

    it("falls back to pipeline-level agent", () => {
      const adapter = resolveAdapter(undefined, "another-adapter");
      expect(adapter.name).toBe("another-adapter");
    });

    it("falls back to SQUID_AGENT env var", () => {
      const orig = process.env.SQUID_AGENT;
      process.env.SQUID_AGENT = "test-adapter";
      try {
        const adapter = resolveAdapter(undefined, undefined);
        expect(adapter.name).toBe("test-adapter");
      } finally {
        process.env.SQUID_AGENT = orig;
      }
    });

    it("throws for unknown adapter name", () => {
      expect(() => resolveAdapter("ghost", undefined)).toThrow(
        "Agent adapter 'ghost' not found"
      );
    });

    it("error message lists available adapters", () => {
      expect(() => resolveAdapter("ghost", undefined)).toThrow(
        /Available:.*test-adapter/
      );
    });
  });
});
