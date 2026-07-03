/**
 * Unified agent run log — auto-dispatched Claude runs + manual entries
 * (Cursor, interactive Claude, API scripts). Persisted as JSONL per machine.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROVIDERS, normalizeProviderId, type AgentProviderId } from "./agents.ts";
import { findProjectByRepo, PROJECTS, type Project } from "./projects.ts";
import { budgetStatusForProjects, type ProjectBudgetStatus } from "./budgets.ts";
import type { PipelineStageId } from "./pipeline.ts";

export interface AgentRun {
  id: string;
  provider: AgentProviderId;
  repo: string;
  issueNumber: number;
  title: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  outputTail?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  resultSummary?: string;
  notes?: string;
  source: "dispatch" | "manual";
  pipelineStage?: PipelineStageId;
  pipelineId?: string;
  specialist?: "growth" | "research";
}

export interface EnrichedAgentRun extends AgentRun {
  projectId?: string;
  projectName?: string;
  domain?: string;
}

export interface SpendBucket {
  totalUsd: number;
  todayUsd: number;
  monthlyUsd: number;
  runs: number;
}

export interface ProjectSpendRow extends SpendBucket {
  projectId: string;
  name: string;
  repo: string;
  domain?: string;
  avgCostUsd: number;
}

export interface SpendSummary {
  totalUsd: number;
  todayUsd: number;
  runs: number;
  byProvider: Record<AgentProviderId, SpendBucket>;
  byProject: ProjectSpendRow[];
  byIssue: Record<string, SpendBucket>;
  insights: {
    topProjectToday: ProjectSpendRow | null;
    topProjectAllTime: ProjectSpendRow | null;
    mostExpensiveIssue: { key: string; repo: string; issueNumber: number; domain?: string; totalUsd: number } | null;
  };
  budgets: ProjectBudgetStatus[];
}

const RUNS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "agent-runs.jsonl");

export function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function emptyBucket(): SpendBucket {
  return { totalUsd: 0, todayUsd: 0, monthlyUsd: 0, runs: 0 };
}

function emptyByProvider(): Record<AgentProviderId, SpendBucket> {
  return Object.fromEntries(AGENT_PROVIDERS.map((p) => [p.id, emptyBucket()])) as Record<
    AgentProviderId,
    SpendBucket
  >;
}

function projectRow(project: Project, bucket: SpendBucket): ProjectSpendRow {
  return {
    projectId: project.id,
    name: project.name,
    repo: project.repo,
    domain: project.domain,
    totalUsd: bucket.totalUsd,
    todayUsd: bucket.todayUsd,
    monthlyUsd: bucket.monthlyUsd,
    runs: bucket.runs,
    avgCostUsd: bucket.runs > 0 ? bucket.totalUsd / bucket.runs : 0,
  };
}

function normalizeRun(raw: Record<string, unknown>): AgentRun {
  return {
    id: String(raw.id),
    provider: normalizeProviderId(String(raw.provider || "claude-code")),
    repo: String(raw.repo),
    issueNumber: Number(raw.issueNumber),
    title: String(raw.title),
    status: raw.status === "running" || raw.status === "failed" ? raw.status : "done",
    startedAt: String(raw.startedAt),
    finishedAt: raw.finishedAt ? String(raw.finishedAt) : undefined,
    outputTail: raw.outputTail ? String(raw.outputTail) : undefined,
    costUsd: raw.costUsd != null ? Number(raw.costUsd) : undefined,
    durationMs: raw.durationMs != null ? Number(raw.durationMs) : undefined,
    numTurns: raw.numTurns != null ? Number(raw.numTurns) : undefined,
    resultSummary: raw.resultSummary ? String(raw.resultSummary) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    source: raw.source === "manual" ? "manual" : "dispatch",
    pipelineStage:
      raw.pipelineStage === "analyze" || raw.pipelineStage === "implement" || raw.pipelineStage === "validate"
        ? raw.pipelineStage
        : undefined,
    pipelineId: raw.pipelineId ? String(raw.pipelineId) : undefined,
    specialist: raw.specialist === "growth" || raw.specialist === "research" ? raw.specialist : undefined,
  };
}

export function enrichRun(run: AgentRun): EnrichedAgentRun {
  const project = findProjectByRepo(run.repo);
  return {
    ...run,
    projectId: project?.id,
    projectName: project?.name,
    domain: project?.domain,
  };
}

export function readAllRuns(): AgentRun[] {
  try {
    return readFileSync(RUNS_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => normalizeRun(JSON.parse(line) as Record<string, unknown>));
  } catch {
    return [];
  }
}

export function persistRun(run: AgentRun): void {
  try {
    mkdirSync(dirname(RUNS_FILE), { recursive: true });
    appendFileSync(RUNS_FILE, JSON.stringify(run) + "\n");
  } catch (err) {
    console.warn("[runs] could not persist:", err);
  }
}

export function spendSummary(): SpendSummary {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const byProvider = emptyByProvider();
  const projectBuckets = new Map<string, SpendBucket>();
  const byIssue: Record<string, SpendBucket> = {};
  let totalUsd = 0;
  let todayUsd = 0;
  let runs = 0;

  for (const project of PROJECTS) {
    projectBuckets.set(project.id, emptyBucket());
  }

  for (const run of readAllRuns()) {
    const cost = Number(run.costUsd) || 0;
    const runDay = String(run.startedAt).slice(0, 10);
    const isToday = runDay === today;
    const isMonth = runDay.startsWith(month);

    byProvider[run.provider].totalUsd += cost;
    byProvider[run.provider].runs += 1;
    if (isToday) byProvider[run.provider].todayUsd += cost;
    if (isMonth) byProvider[run.provider].monthlyUsd += cost;

    const project = findProjectByRepo(run.repo);
    if (project) {
      const bucket = projectBuckets.get(project.id)!;
      bucket.totalUsd += cost;
      bucket.runs += 1;
      if (isToday) bucket.todayUsd += cost;
      if (isMonth) bucket.monthlyUsd += cost;
    }

    const iKey = issueKey(run.repo, run.issueNumber);
    if (!byIssue[iKey]) byIssue[iKey] = emptyBucket();
    byIssue[iKey].totalUsd += cost;
    byIssue[iKey].runs += 1;
    if (isToday) byIssue[iKey].todayUsd += cost;
    if (isMonth) byIssue[iKey].monthlyUsd += cost;

    totalUsd += cost;
    runs += 1;
    if (isToday) todayUsd += cost;
  }

  const byProject = PROJECTS.map((p) => projectRow(p, projectBuckets.get(p.id)!)).sort(
    (a, b) => b.totalUsd - a.totalUsd
  );
  const budgets = budgetStatusForProjects(byProject);

  const topProjectToday = [...byProject].sort((a, b) => b.todayUsd - a.todayUsd).find((p) => p.todayUsd > 0) ?? null;
  const topProjectAllTime = byProject[0]?.totalUsd > 0 ? byProject[0] : null;

  let mostExpensiveIssue: SpendSummary["insights"]["mostExpensiveIssue"] = null;
  for (const [key, bucket] of Object.entries(byIssue)) {
    if (bucket.totalUsd <= 0) continue;
    if (!mostExpensiveIssue || bucket.totalUsd > mostExpensiveIssue.totalUsd) {
      const [repo, num] = key.split("#");
      const project = findProjectByRepo(repo);
      mostExpensiveIssue = {
        key,
        repo,
        issueNumber: Number(num),
        domain: project?.domain,
        totalUsd: bucket.totalUsd,
      };
    }
  }

  return {
    totalUsd,
    todayUsd,
    runs,
    byProvider,
    byProject,
    byIssue,
    budgets,
    insights: { topProjectToday, topProjectAllTime, mostExpensiveIssue },
  };
}

export function listRecentRuns(limit = 30): AgentRun[] {
  return readAllRuns()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function logManualRun(input: {
  provider: string;
  repo: string;
  issueNumber: number;
  title: string;
  costUsd?: number;
  durationMs?: number;
  notes?: string;
}): AgentRun {
  const provider = normalizeProviderId(input.provider);
  const run: AgentRun = {
    id: `manual-${Date.now()}-${input.repo}#${input.issueNumber}`,
    provider,
    repo: input.repo,
    issueNumber: input.issueNumber,
    title: input.title,
    status: "done",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    costUsd: input.costUsd != null && !Number.isNaN(Number(input.costUsd)) ? Number(input.costUsd) : undefined,
    durationMs:
      input.durationMs != null && !Number.isNaN(Number(input.durationMs)) ? Number(input.durationMs) : undefined,
    notes: input.notes?.trim() || undefined,
    source: "manual",
  };
  persistRun(run);
  return run;
}
