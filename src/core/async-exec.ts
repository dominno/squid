/**
 * Async subprocess execution for CLI-based agent adapters.
 *
 * Uses child_process.spawn (non-blocking) instead of execSync.
 * Supports timeout, cwd, env, and streaming stdout/stderr.
 */

import { spawn as nodeSpawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalSize = 0;
    let killed = false;

    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        // Force kill after 5s if still alive
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize <= maxBuffer) {
        chunks.push(chunk);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);

      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      const exitCode = code ?? 1;

      if (killed) {
        reject(new Error(`Process timed out after ${options.timeoutMs}ms`));
        return;
      }

      if (exitCode !== 0) {
        const err = new Error(
          `Command failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`
        ) as Error & { exitCode: number; stderr: string; stdout: string };
        err.exitCode = exitCode;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
