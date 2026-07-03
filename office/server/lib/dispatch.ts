/**
 * Agent dispatch — three-stage Claude Code pipeline from office.
 *
 * analyze (Sonnet) → implement (Opus) → validate (Sonnet)
 * Only `claude-code` provider is auto-dispatched here.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProviderId, type AgentProviderId } from "./agents.ts";
import { findProjectByRepo } from "./projects.ts";
import { overBudgetMessage } from "./budgets.ts";
import { commentOnIssue, setIssueStage } from "./github.ts";
import { getPipelineStages, type PipelineStageId } from "./pipeline.ts";
import { type AgentRun, persistRun, listRecentRuns, spendSummary, enrichRun } from "./runs.ts";

export type { AgentRun, SpendSummary, EnrichedAgentRun } from "./runs.ts";
export { spendSummary, listRecentRuns, logManualRun, enrichRun, issueKey } from "./runs.ts";

const dispatches = new Map<string, AgentRun>();
const MAX_TAIL = 4_000;
const MAX_CONCURRENT = 3;

for (const run of listRecentRuns(20)) {
  if (run.pipelineId) dispatches.set(run.pipelineId, run);
  else dispatches.set(run.id, run);
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

interface StageRunResult {
  ok: boolean;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  resultSummary?: string;
  outputTail?: string;
}

function pipelineId(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function stageRunId(repo: string, issueNumber: number, stage: PipelineStageId): string {
  return `${repo}#${issueNumber}:${stage}`;
}

export function listDispatches(): ReturnType<typeof enrichRun>[] {
  const live = [...dispatches.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const seen = new Set(live.map((d) => d.id));
  const persisted = listRecentRuns(40).filter((r) => !seen.has(r.id) && !seen.has(r.pipelineId || ""));
  return [...live, ...persisted].slice(0, 40).map(enrichRun);
}

export function runningDispatchCount(): number {
  return [...dispatches.values()].filter((d) => d.status === "running").length;
}

export function dispatchAvailable(): boolean {
  return process.env.DISPATCH_DISABLED !== "true";
}

export function registerDispatch(run: AgentRun): void {
  dispatches.set(run.id, run);
}

function runClaudeStage(
  workdir: string,
  prompt: string,
  model: string
): Promise<StageRunResult> {
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

async function runPipeline(
  workdir: string,
  input: { repo: string; issueNumber: number; title: string },
  pipeline: AgentRun
): Promise<void> {
  const id = pipelineId(input.repo, input.issueNumber);
  let totalCost = 0;

  for (const stage of getPipelineStages()) {
    pipeline.pipelineStage = stage.id;
    pipeline.outputTail = `[${stage.title}] ${stage.role} · ${stage.model}`;

    const stageUpdate = await setIssueStage(input.repo, input.issueNumber, stage.stageLabel);
    if (!stageUpdate.ok) {
      console.warn(`[dispatch] stage label ${stage.stageLabel}: ${stageUpdate.message}`);
    }

    const result = await runClaudeStage(workdir, stage.prompt(input.repo, input.issueNumber), stage.model);
    totalCost += result.costUsd || 0;

    const stageRun: AgentRun = {
      id: stageRunId(input.repo, input.issueNumber, stage.id),
      pipelineId: id,
      pipelineStage: stage.id,
      provider: "claude-code",
      repo: input.repo,
      issueNumber: input.issueNumber,
      title: `${input.title} — ${stage.title}`,
      status: result.ok ? "done" : "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      resultSummary: result.resultSummary,
      outputTail: result.outputTail,
      source: "dispatch",
    };
    persistRun(stageRun);

    if (!result.ok) {
      pipeline.status = "failed";
      pipeline.finishedAt = new Date().toISOString();
      pipeline.costUsd = totalCost || undefined;
      pipeline.outputTail = `[${stage.title} failed] ${result.outputTail || result.resultSummary || "unknown error"}`.slice(
        -MAX_TAIL
      );
      persistRun(pipeline);
      await setIssueStage(input.repo, input.issueNumber, "agent:ready");
      await commentOnIssue(
        input.repo,
        input.issueNumber,
        `**Agent team stopped at ${stage.title}** — stage failed. Issue restored to \`agent:ready\`.\n\n${result.resultSummary || result.outputTail || ""}`.slice(
          0,
          4000
        )
      );
      return;
    }
  }

  pipeline.status = "done";
  pipeline.pipelineStage = "validate";
  pipeline.finishedAt = new Date().toISOString();
  pipeline.costUsd = totalCost || undefined;
  pipeline.resultSummary = "Pipeline complete — awaiting human review on PR.";
  persistRun(pipeline);
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

  const id = pipelineId(input.repo, input.issueNumber);
  const existing = dispatches.get(id);
  if (existing?.status === "running") {
    return { ok: false, status: 409, error: "The agent team is already running on this task." };
  }
  if (runningDispatchCount() >= MAX_CONCURRENT) {
    return { ok: false, status: 429, error: `Max ${MAX_CONCURRENT} concurrent pipelines — wait for one to finish.` };
  }

  const workdir = mkdtempSync(join(tmpdir(), "bai-agent-"));
  const state: AgentRun = {
    id,
    pipelineId: id,
    provider: "claude-code" as AgentProviderId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    status: "running",
    pipelineStage: "analyze",
    startedAt: new Date().toISOString(),
    outputTail: "Agent team started — Analysis → Implementation → Validation",
    source: "dispatch",
  };
  dispatches.set(id, state);

  void runPipeline(workdir, input, state).catch(async (err) => {
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.outputTail = `pipeline error: ${err instanceof Error ? err.message : String(err)}`.slice(-MAX_TAIL);
    persistRun(state);
    await setIssueStage(input.repo, input.issueNumber, "agent:ready");
  });

  return { ok: true, dispatch: state };
}
