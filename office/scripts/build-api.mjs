/**
 * Bundle the Express API for Vercel serverless (Node cannot import .ts at runtime).
 * Uses esbuild from the local node_modules (via npx).
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "api", "server.bundle.mjs");
mkdirSync(dirname(outfile), { recursive: true });

const entry = join(root, "server", "server.ts");
const cmd = [
  "npx",
  "esbuild",
  entry,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=esm",
  `--outfile=${outfile}`,
  "--packages=external",
].join(" ");

execSync(cmd, { cwd: root, stdio: "inherit", shell: true });
console.log("[build-api] wrote", outfile);
