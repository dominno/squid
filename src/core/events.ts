/**
 * Pipeline Event Emitter
 *
 * Lightweight event system for pipeline observability.
 * Supports typed events, wildcard listeners, and OTel-compatible span data.
 */

import { randomUUID } from "node:crypto";
import type {
  PipelineEvent,
  PipelineEventType,
  PipelineEventEmitter,
  StepType,
} from "./types.js";

type Handler = (event: PipelineEvent) => void;

export function createEventEmitter(): PipelineEventEmitter {
  const handlers = new Map<string, Set<Handler>>();

  return {
    emit(event: PipelineEvent) {
      // Assign span ID if not set
      if (!event.spanId) event.spanId = randomUUID().slice(0, 16);
      if (!event.traceId) event.traceId = event.runId;

      // Fire typed handlers
      const typed = handlers.get(event.type);
      if (typed) typed.forEach((h) => h(event));

      // Fire wildcard handlers
      const wild = handlers.get("*");
      if (wild) wild.forEach((h) => h(event));
    },

    on(type: PipelineEventType | "*", handler: Handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },

    off(type: PipelineEventType | "*", handler: Handler) {
      handlers.get(type)?.delete(handler);
    },
  };
}

/** Helper to create events with consistent shape */
export function createEvent(
  type: PipelineEventType,
  pipelineId: string,
  runId: string,
  stepId?: string,
  stepType?: StepType,
  data?: Record<string, unknown>
): PipelineEvent {
  return {
    type,
    timestamp: Date.now(),
    pipelineId,
    runId,
    stepId,
    stepType,
    data,
    traceId: runId,
    spanId: randomUUID().slice(0, 16),
  };
}

/** No-op emitter for when events are not needed */
export function createNoopEmitter(): PipelineEventEmitter {
  return {
    emit() {},
    on() {},
    off() {},
  };
}
