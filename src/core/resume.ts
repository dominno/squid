/**
 * Resume Token Encoding/Decoding
 *
 * Encodes pipeline execution state into opaque tokens for halted pipelines
 * (e.g., waiting for gate approval). Tokens are base64-encoded JSON.
 */

import type { ResumeToken } from "./types.js";

export function encodeResumeToken(token: ResumeToken): string {
  const json = JSON.stringify(token);
  return Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeResumeToken(encoded: string): ResumeToken {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const token = JSON.parse(json) as ResumeToken;

    if (token.version !== 1) {
      throw new Error(`Unsupported resume token version: ${token.version}`);
    }
    if (!token.pipelineId || !token.runId || !token.resumeAtStep) {
      throw new Error("Invalid resume token: missing required fields");
    }

    return token;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unsupported")) throw err;
    if (err instanceof Error && err.message.startsWith("Invalid")) throw err;
    throw new Error("Malformed resume token");
  }
}
