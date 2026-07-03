/**
 * Agent dispatch — the "self-driving" part of Mission Control.
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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}

const dispatches = new Map<string, DispatchState>();
const MAX_TAIL = 4_000;
const MAX_CONCURRENT = 3;

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
  const running = [...dispatches.values()].filter((d) => d.status === "running").length;
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
  const child = spawn(
    "claude",
    [
      "-p",
      agentPrompt(input.repo, input.issueNumber),
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      AGENT_ALLOWED_TOOLS,
    ],
    { cwd: workdir, shell: true, windowsHide: true, env: process.env }
  );

  const append = (chunk: Buffer) => {
    state.outputTail = (state.outputTail + chunk.toString()).slice(-MAX_TAIL);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => {
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.outputTail = (state.outputTail + `\nspawn error: ${err.message}`).slice(-MAX_TAIL);
  });
  child.on("close", (code) => {
    if (state.status === "running") {
      state.status = code === 0 ? "done" : "failed";
      state.finishedAt = new Date().toISOString();
    }
  });

  return { ok: true, dispatch: state };
}
