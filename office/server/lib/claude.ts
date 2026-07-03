/**
 * Shared one-shot Claude Code runner (`claude -p`) used by the pipeline,
 * specialists, and the auto-cycle prioritizer.
 */

import { spawn } from "node:child_process";

const MAX_TAIL = 4_000;

export const AGENT_ALLOWED_TOOLS = [
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(node:*)",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
].join(",");

export interface ClaudeRunResult {
  ok: boolean;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  resultSummary?: string;
  outputTail?: string;
}

export function runClaude(workdir: string, prompt: string, model: string): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const cmd = `claude -p --output-format json --permission-mode acceptEdits --model "${model}" --allowedTools "${AGENT_ALLOWED_TOOLS}"`;
    const child = spawn(cmd, { cwd: workdir, shell: true, windowsHide: true, env: process.env });
    child.stdin?.end(prompt);

    let stdoutBuf = "";
    let stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf = (stdoutBuf + chunk.toString()).slice(-200_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-MAX_TAIL);
    });
    child.on("error", (err) => {
      resolve({ ok: false, outputTail: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdoutBuf.slice(stdoutBuf.indexOf("{"))) as Record<string, unknown>;
        resolve({
          ok: !result.is_error && code === 0,
          costUsd: Number(result.total_cost_usd) || undefined,
          durationMs: Number(result.duration_ms) || undefined,
          numTurns: Number(result.num_turns) || undefined,
          resultSummary: String(result.result || "").slice(0, 400),
          outputTail: stderrTail || undefined,
        });
      } catch {
        resolve({
          ok: code === 0,
          outputTail: (stderrTail + stdoutBuf).slice(-MAX_TAIL),
        });
      }
    });
  });
}
