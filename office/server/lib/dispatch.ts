/**
 * Agent dispatch — the "self-driving" part of bai digital office.
 *
 * Dispatching a ready task spawns a headless Claude Code run (`claude -p`)
 * on this machine with the full BAI agent contract: read the issue, clone
 * the repo, build the slice on a feat/ branch, verify green, open a PR that
 * closes the issue, and move the stage labels. The GUI polls dispatch state
 * so a running agent is visible on the board.
 *
 * Permissions: the agent runs with an explicit tool allowlist (git/gh/npm/
 * node/npx + file tools) in acceptEdits mode — anything outside the list is
 * refused in headless mode. Local tool only; never expose beyond localhost.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DispatchState {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Last chunk of agent output — enough to see where it landed. */
  outputTail: string;
  /** From the run's result JSON (claude -p --output-format json). */
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  resultSummary?: string;
}

const dispatches = new Map<string, DispatchState>();
const MAX_TAIL = 4_000;
const MAX_CONCURRENT = 3;

/** Finished runs persist as JSONL so agent history and spend survive restarts. */
const RUNS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "agent-runs.jsonl");

function readRuns(): DispatchState[] {
  try {
    return readFileSync(RUNS_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as DispatchState);
  } catch {
    return []; // no history yet
  }
}

for (const run of readRuns().slice(-20)) dispatches.set(run.id, run);

function persistRun(state: DispatchState): void {
  try {
    mkdirSync(dirname(RUNS_FILE), { recursive: true });
    appendFileSync(RUNS_FILE, JSON.stringify(state) + "\n");
  } catch (err) {
    console.warn("[dispatch] could not persist run:", err);
  }
}

export interface SpendSummary {
  totalUsd: number;
  todayUsd: number;
  runs: number;
}

/** Claude spend across all persisted runs (+ nothing for still-running ones). */
export function spendSummary(): SpendSummary {
  const today = new Date().toISOString().slice(0, 10);
  let totalUsd = 0;
  let todayUsd = 0;
  let runs = 0;
  for (const run of readRuns()) {
    const cost = Number(run.costUsd) || 0;
    totalUsd += cost;
    runs += 1;
    if (String(run.startedAt).slice(0, 10) === today) todayUsd += cost;
  }
  return { totalUsd, todayUsd, runs };
}

/** Tools the dispatched agent may use without per-call approval. */
const AGENT_ALLOWED_TOOLS = [
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

export function listDispatches(): DispatchState[] {
  return [...dispatches.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20);
}

export function runningDispatchCount(): number {
  return [...dispatches.values()].filter((d) => d.status === "running").length;
}

export function dispatchAvailable(): boolean {
  return process.env.DISPATCH_DISABLED !== "true";
}

function agentPrompt(repo: string, issueNumber: number): string {
  return [
    `You are a BAI Digital repo-engineer. Execute GitHub issue #${issueNumber} in the repo ${repo} end-to-end.`,
    ``,
    `1. Read the task: gh issue view ${issueNumber} --repo ${repo} --json title,body — the body contains Context, Build steps, and the Done-when criteria you are graded on.`,
    `2. Claim it: gh issue edit ${issueNumber} --repo ${repo} --remove-label "agent:ready" --add-label "agent:building".`,
    `3. Clone the repo into the current directory (gh repo clone ${repo} work, then work inside ./work), create a branch feat/<short-slug-from-the-title>.`,
    `4. Read AGENTS.md and the ai/ folder if present — they govern how you work. Reuse existing patterns; never invent APIs, env vars, or DB fields; smallest safe diff.`,
    `5. Build the feature as a vertical slice. Run the repo's verify/lint/build scripts (read package.json for the real ones) until green.`,
    `6. Commit (end the message with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"), push the branch, then open a PR: gh pr create --base main with a body containing Summary / Files touched / Verification / Assumptions, and "Closes #${issueNumber}".`,
    `7. Flip the stage: gh issue edit ${issueNumber} --repo ${repo} --remove-label "agent:building" --add-label "agent:review".`,
    ``,
    `Hard rules: never push to main; never merge the PR; never print secrets. If the task is impossible or already done, comment on the issue explaining why, restore the agent:ready label, and stop.`,
    `Finish by printing the PR URL on its own line.`,
  ].join("\n");
}

export function startDispatch(input: {
  repo: string;
  issueNumber: number;
  title: string;
}): { ok: true; dispatch: DispatchState } | { ok: false; status: number; error: string } {
  const id = `${input.repo}#${input.issueNumber}`;
  const existing = dispatches.get(id);
  if (existing?.status === "running") {
    return { ok: false, status: 409, error: "An agent is already running on this task." };
  }
  const running = runningDispatchCount();
  if (running >= MAX_CONCURRENT) {
    return { ok: false, status: 429, error: `Max ${MAX_CONCURRENT} concurrent agents — wait for one to finish.` };
  }

  const workdir = mkdtempSync(join(tmpdir(), "bai-agent-"));
  const state: DispatchState = {
    id,
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    status: "running",
    startedAt: new Date().toISOString(),
    outputTail: "",
  };
  dispatches.set(id, state);

  // shell:true so `claude` resolves through PATH on Windows (claude.cmd).
  // The prompt goes through stdin, never argv: cmd.exe would split a
  // multi-line prompt into separate arguments. --output-format json makes
  // stdout a single result object with total_cost_usd for spend tracking.
  const child = spawn(
    `claude -p --output-format json --permission-mode acceptEdits --allowedTools "${AGENT_ALLOWED_TOOLS}"`,
    { cwd: workdir, shell: true, windowsHide: true, env: process.env }
  );
  child.stdin?.end(agentPrompt(input.repo, input.issueNumber));

  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf = (stdoutBuf + chunk.toString()).slice(-200_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    state.outputTail = (state.outputTail + chunk.toString()).slice(-MAX_TAIL);
  });
  child.on("error", (err) => {
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.outputTail = (state.outputTail + `\nspawn error: ${err.message}`).slice(-MAX_TAIL);
    persistRun(state);
  });
  child.on("close", (code) => {
    if (state.status !== "running") return; // already failed via 'error'
    try {
      const result = JSON.parse(stdoutBuf.slice(stdoutBuf.indexOf("{"))) as Record<string, unknown>;
      state.costUsd = Number(result.total_cost_usd) || undefined;
      state.durationMs = Number(result.duration_ms) || undefined;
      state.numTurns = Number(result.num_turns) || undefined;
      state.resultSummary = String(result.result || "").slice(0, 400);
      state.status = result.is_error || code !== 0 ? "failed" : "done";
    } catch {
      state.outputTail = (state.outputTail + stdoutBuf).slice(-MAX_TAIL);
      state.status = code === 0 ? "done" : "failed";
    }
    state.finishedAt = new Date().toISOString();
    persistRun(state);
  });

  return { ok: true, dispatch: state };
}
