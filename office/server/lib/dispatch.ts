/**
 * Agent dispatch — headless Claude Code runs from office.
 *
 * Only `claude-code` provider is auto-dispatched here. Cursor, interactive
 * Claude, and direct API agents are started manually — log them via POST /api/runs.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProviderId, type AgentProviderId } from "./agents.ts";
import { findProjectByRepo } from "./projects.ts";
import { overBudgetMessage } from "./budgets.ts";
import { type AgentRun, persistRun, listRecentRuns, spendSummary, enrichRun } from "./runs.ts";

export type { AgentRun, SpendSummary, EnrichedAgentRun } from "./runs.ts";
export { spendSummary, listRecentRuns, logManualRun, enrichRun, issueKey } from "./runs.ts";

const dispatches = new Map<string, AgentRun>();
const MAX_TAIL = 4_000;
const MAX_CONCURRENT = 3;

for (const run of listRecentRuns(20)) dispatches.set(run.id, run);

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

export function listDispatches(): ReturnType<typeof enrichRun>[] {
  const live = [...dispatches.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const seen = new Set(live.map((d) => d.id));
  const persisted = listRecentRuns(30).filter((r) => !seen.has(r.id));
  return [...live, ...persisted].slice(0, 30).map(enrichRun);
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
  provider?: string;
}): { ok: true; dispatch: AgentRun } | { ok: false; status: number; error: string } {
  const provider = normalizeProviderId(input.provider || "claude-code");
  if (provider !== "claude-code") {
    return {
      ok: false,
      status: 400,
      error: `${provider} cannot be auto-dispatched — use the IDE/CLI flow and log the run manually.`,
    };
  }

  const project = findProjectByRepo(input.repo);
  if (project) {
    const budgetError = overBudgetMessage(project.id, spendSummary().byProject);
    if (budgetError) {
      return { ok: false, status: 402, error: budgetError };
    }
  }

  const id = `${input.repo}#${input.issueNumber}`;
  const existing = dispatches.get(id);
  if (existing?.status === "running") {
    return { ok: false, status: 409, error: "An agent is already running on this task." };
  }
  if (runningDispatchCount() >= MAX_CONCURRENT) {
    return { ok: false, status: 429, error: `Max ${MAX_CONCURRENT} concurrent agents — wait for one to finish.` };
  }

  const workdir = mkdtempSync(join(tmpdir(), "bai-agent-"));
  const state: AgentRun = {
    id,
    provider: "claude-code" as AgentProviderId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    status: "running",
    startedAt: new Date().toISOString(),
    outputTail: "",
    source: "dispatch",
  };
  dispatches.set(id, state);

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
    state.outputTail = ((state.outputTail || "") + chunk.toString()).slice(-MAX_TAIL);
  });
  child.on("error", (err) => {
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.outputTail = ((state.outputTail || "") + `\nspawn error: ${err.message}`).slice(-MAX_TAIL);
    persistRun(state);
  });
  child.on("close", (code) => {
    if (state.status !== "running") return;
    try {
      const result = JSON.parse(stdoutBuf.slice(stdoutBuf.indexOf("{"))) as Record<string, unknown>;
      state.costUsd = Number(result.total_cost_usd) || undefined;
      state.durationMs = Number(result.duration_ms) || undefined;
      state.numTurns = Number(result.num_turns) || undefined;
      state.resultSummary = String(result.result || "").slice(0, 400);
      state.status = result.is_error || code !== 0 ? "failed" : "done";
    } catch {
      state.outputTail = ((state.outputTail || "") + stdoutBuf).slice(-MAX_TAIL);
      state.status = code === 0 ? "done" : "failed";
    }
    state.finishedAt = new Date().toISOString();
    persistRun(state);
  });

  return { ok: true, dispatch: state };
}
