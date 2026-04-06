#!/usr/bin/env node

// Detect compiled vs source and run accordingly
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "../dist/cli/main.js");
const srcEntry = resolve(__dirname, "../src/cli/main.ts");

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  // Dev mode: use tsx
  const { execSync } = await import("node:child_process");
  execSync(`npx tsx ${srcEntry} ${process.argv.slice(2).join(" ")}`, {
    stdio: "inherit",
    cwd: resolve(__dirname, ".."),
  });
}
