/**
 * Agent dispatch — three-stage Claude Code pipeline from office.
 *
 * analyze (Sonnet) → implement (Opus) → validate (Sonnet)
 * Only `claude-code` provider is auto-dispatched here.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProviderId, type AgentProviderId } from "./agents.ts";
import { findProjectByRepo } from "./projects.ts";
import { overBudgetMessage } from "./budgets.ts";
import { commentOnIssue, setIssueStage, getIssueState, findOpenPrForIssue } from "./github.ts";
import { getPipelineStages, type PipelineStageId } from "./pipeline.ts";
import { type AgentRun, persistRun, listRecentRuns, spendSummary, enrichRun } from "./runs.ts";
import { notify } from "./notify.ts";
import { maybeAutoMerge } from "./autoMerge.ts";
import { runClaude } from "./claude.ts";

export type { AgentRun, SpendSummary, EnrichedAgentRun } from "./runs.ts";
export { spendSummary, listRecentRuns, logManualRun, enrichRun, issueKey } from "./runs.ts";

const dispatches = new Map<string, AgentRun>();
const MAX_TAIL = 4_000;
const MAX_CONCURRENT = 3;
/** Failed pipeline attempts before the issue is parked as agent:blocked. */
const MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS) || 2;

for (const run of listRecentRuns(20)) {
  if (run.pipelineId) dispatches.set(run.pipelineId, run);
  else dispatches.set(run.id, run);
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

/** Failure handling: retry (back to agent:ready) or park as agent:blocked after MAX_ATTEMPTS. */
async function handlePipelineFailure(
  input: { repo: string; issueNumber: number; title: string },
  stageTitle: string,
  detail: string
): Promise<void> {
  const state = await getIssueState(input.repo, input.issueNumber);
  const attempt = (state?.attempts ?? 0) + 1;

  if (attempt >= MAX_ATTEMPTS) {
    await setIssueStage(input.repo, input.issueNumber, "agent:blocked", { attempts: attempt });
    await commentOnIssue(
      input.repo,
      input.issueNumber,
      `**Agent team blocked after ${attempt} failed attempt${attempt === 1 ? "" : "s"}** (last failure: ${stageTitle}).\n\nThis task will not be retried automatically. Fix the task description or the underlying problem, then set the label back to \`agent:ready\`.\n\n${detail}`.slice(
        0,
        4000
      )
    );
    void notify({
      kind: "task-blocked",
      repo: input.repo,
      issueNumber: input.issueNumber,
      title: input.title,
      reason: `${attempt} failed attempts — last failure at ${stageTitle}.`,
    });
    return;
  }

  await setIssueStage(input.repo, input.issueNumber, "agent:ready", { attempts: attempt });
  await commentOnIssue(
    input.repo,
    input.issueNumber,
    `**Agent team stopped at ${stageTitle}** (attempt ${attempt}/${MAX_ATTEMPTS}) — issue restored to \`agent:ready\` for one retry.\n\n${detail}`.slice(
      0,
      4000
    )
  );
  void notify({
    kind: "pipeline-failed",
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    stage: stageTitle,
    attempt,
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

    const result = await runClaude(workdir, stage.prompt(input.repo, input.issueNumber), stage.model);
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
      await handlePipelineFailure(input, stage.title, result.resultSummary || result.outputTail || "");
      return;
    }
  }

  pipeline.status = "done";
  pipeline.pipelineStage = "validate";
  pipeline.finishedAt = new Date().toISOString();
  pipeline.costUsd = totalCost || undefined;
  pipeline.resultSummary = "Pipeline complete — awaiting human review on PR.";
  persistRun(pipeline);

  // Server-side guarantee: the issue lands on agent:review even if the validate
  // agent forgot the label switch, and clear the attempts counter.
  const issueState = await getIssueState(input.repo, input.issueNumber);
  if (issueState && (issueState.stage !== "agent:review" || issueState.attempts > 0)) {
    await setIssueStage(input.repo, input.issueNumber, "agent:review", { attempts: null });
  }

  const pr = await findOpenPrForIssue(input.repo, input.issueNumber);
  void notify({
    kind: "pr-ready",
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    prUrl: pr?.url,
  });

  void maybeAutoMerge(input.repo, input.issueNumber, input.title);
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
    await handlePipelineFailure(input, "pipeline", state.outputTail ?? "");
  });

  return { ok: true, dispatch: state };
}
