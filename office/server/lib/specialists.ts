/**
 * Specialist agents — on-demand runs outside the build pipeline.
 * growth: creative feature ideas · research: market & gap analysis
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSpecialistSettings, type SpecialistAgentId } from "./agentConfig.ts";
import { findProjectByRepo } from "./projects.ts";
import { overBudgetMessage } from "./budgets.ts";
import { persistRun, spendSummary, type AgentRun } from "./runs.ts";
import { dispatchAvailable, runningDispatchCount, registerDispatch } from "./dispatch.ts";

const MAX_TAIL = 4_000;
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

const IDEA_MARKER = "<!-- bai:idea -->";

function growthPrompt(repo: string, focus: string, count: number, settings: ReturnType<typeof getSpecialistSettings>): string {
  return [
    `You are a ${settings.role} on the BAI Digital agent team. Generate ${count} creative, high-leverage product/feature ideas for ${repo}.`,
    focus ? `Focus area: ${focus}` : `Focus: growth, retention, revenue, and differentiation for this product.`,
    ``,
    `1. Clone ./work if missing: gh repo clone ${repo} work`,
    `2. Read ./work/AGENTS.md, ./work/ai/ (VISION, ROADMAP if present), and skim the codebase for what already exists.`,
    `3. For each of ${count} ideas, create a GitHub issue:`,
    `   gh issue create --repo ${repo} --title "[Idea] <short name>" --label "agent" --label "agent:idea" --body "..."`,
    `   Body must start with ${IDEA_MARKER} and include:`,
    `   ## Why this grows the business`,
    `   ## User value`,
    `   ## Suggested build (vertical slice)`,
    `   ## Done when (draft criteria as checkboxes)`,
    `   ## Impact × effort (1–5 each)`,
    `4. Do NOT implement code. Do NOT open PRs. Do NOT label agent:ready.`,
    ``,
    `Rules: ideas must be buildable in this repo; no invented integrations; smallest shippable slice per idea.`,
    `Finish by printing "Created N idea issues" and list issue URLs.`,
  ].join("\n");
}

function researchPrompt(repo: string, focus: string, settings: ReturnType<typeof getSpecialistSettings>): string {
  return [
    `You are a ${settings.role} on the BAI Digital agent team. Produce a research brief for ${repo}.`,
    focus ? `Focus: ${focus}` : `Focus: competitors, user pain, codebase gaps, and quick wins.`,
    ``,
    `1. Clone ./work if missing: gh repo clone ${repo} work`,
    `2. Explore ./work — AGENTS.md, ai/, main features, README, package.json.`,
    `3. Create ONE summary issue:`,
    `   gh issue create --repo ${repo} --title "[Research] Opportunities scan" --label "agent" --label "agent:idea"`,
    `   Body starts with ${IDEA_MARKER}:`,
    `   ## Landscape & positioning`,
    `   ## Top 5 opportunities (ranked)`,
    `   ## Gaps in current product`,
    `   ## Recommended next 3 builds`,
    `   ## Assumptions & risks`,
    `4. Optionally create up to 2 follow-up [Idea] issues for the highest-impact items.`,
    ``,
    `Rules: separate facts from hypotheses; no code changes; no PRs.`,
    `Finish by printing the summary issue URL.`,
  ].join("\n");
}

function runClaude(workdir: string, prompt: string, model: string): Promise<{
  ok: boolean;
  costUsd?: number;
  durationMs?: number;
  resultSummary?: string;
  outputTail?: string;
}> {
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
    child.on("error", (err) => resolve({ ok: false, outputTail: err.message }));
    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdoutBuf.slice(stdoutBuf.indexOf("{"))) as Record<string, unknown>;
        resolve({
          ok: !result.is_error && code === 0,
          costUsd: Number(result.total_cost_usd) || undefined,
          durationMs: Number(result.duration_ms) || undefined,
          resultSummary: String(result.result || "").slice(0, 400),
          outputTail: stderrTail,
        });
      } catch {
        resolve({ ok: code === 0, outputTail: (stderrTail + stdoutBuf).slice(-MAX_TAIL) });
      }
    });
  });
}

export function startSpecialistRun(input: {
  id: SpecialistAgentId;
  repo: string;
  projectName: string;
  focus?: string;
  ideaCount?: number;
}):
  | { ok: true; run: AgentRun }
  | { ok: false; status: number; error: string } {
  if (!dispatchAvailable()) {
    return { ok: false, status: 503, error: "Specialist agents need the Railway worker or local dispatch enabled." };
  }

  const settings = getSpecialistSettings(input.id);
  if (!settings.enabled) {
    return { ok: false, status: 409, error: `${settings.title} is disabled in Settings.` };
  }

  const project = findProjectByRepo(input.repo);
  if (project) {
    const budgetError = overBudgetMessage(project.id, spendSummary().byProject);
    if (budgetError) return { ok: false, status: 402, error: budgetError };
  }

  if (runningDispatchCount() >= 3) {
    return { ok: false, status: 429, error: "Too many agents running — try again shortly." };
  }

  const runId = `specialist-${input.id}-${Date.now()}`;
  const state: AgentRun = {
    id: runId,
    provider: "claude-code",
    repo: input.repo,
    issueNumber: 0,
    title: `${settings.title} — ${input.projectName}`,
    status: "running",
    startedAt: new Date().toISOString(),
    outputTail: `${settings.title} started`,
    source: "dispatch",
    specialist: input.id,
  };

  const workdir = mkdtempSync(join(tmpdir(), "bai-specialist-"));
  const focus = String(input.focus || "").trim();
  const count = Math.min(8, Math.max(1, Number(input.ideaCount) || 5));
  const prompt =
    input.id === "growth"
      ? growthPrompt(input.repo, focus, count, settings)
      : researchPrompt(input.repo, focus, settings);

  void runClaude(workdir, prompt, settings.model).then((result) => {
    state.status = result.ok ? "done" : "failed";
    state.finishedAt = new Date().toISOString();
    state.costUsd = result.costUsd;
    state.durationMs = result.durationMs;
    state.resultSummary = result.resultSummary;
    state.outputTail = result.outputTail?.slice(-MAX_TAIL);
    persistRun(state);
    registerDispatch(state);
  });

  registerDispatch(state);
  return { ok: true, run: state };
}
