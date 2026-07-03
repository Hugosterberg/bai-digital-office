/**
 * Per-project spend limits — persisted locally in server/data/.
 * When any active limit is exceeded, auto-dispatch is blocked until spend drops or limits are raised.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProject, PROJECTS } from "./projects.ts";
import type { ProjectSpendRow } from "./runs.ts";

export interface ProjectBudgetLimits {
  dailyUsd?: number;
  monthlyUsd?: number;
  totalUsd?: number;
}

export interface ProjectBudgetConfig {
  projectId: string;
  limits: ProjectBudgetLimits;
  updatedAt: string;
}

export interface BudgetMeter {
  limit?: number;
  spent: number;
  remaining?: number;
  pct: number;
  exceeded: boolean;
  nearLimit: boolean;
}

export interface ProjectBudgetStatus {
  projectId: string;
  name: string;
  repo: string;
  domain?: string;
  limits: ProjectBudgetLimits;
  spent: { daily: number; monthly: number; total: number };
  meters: { daily: BudgetMeter; monthly: BudgetMeter; total: BudgetMeter };
  anyExceeded: boolean;
  anyNearLimit: boolean;
  hasLimits: boolean;
}

const BUDGETS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "project-budgets.json");

function readRaw(): Record<string, ProjectBudgetLimits & { updatedAt?: string }> {
  try {
    return JSON.parse(readFileSync(BUDGETS_FILE, "utf8")) as Record<
      string,
      ProjectBudgetLimits & { updatedAt?: string }
    >;
  } catch {
    return {};
  }
}

export function readAllBudgets(): ProjectBudgetConfig[] {
  const raw = readRaw();
  return Object.entries(raw).map(([projectId, entry]) => ({
    projectId,
    limits: {
      dailyUsd: positive(entry.dailyUsd),
      monthlyUsd: positive(entry.monthlyUsd),
      totalUsd: positive(entry.totalUsd),
    },
    updatedAt: entry.updatedAt ?? new Date(0).toISOString(),
  }));
}

function positive(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function getProjectBudget(projectId: string): ProjectBudgetLimits {
  const raw = readRaw()[projectId];
  if (!raw) return {};
  return {
    dailyUsd: positive(raw.dailyUsd),
    monthlyUsd: positive(raw.monthlyUsd),
    totalUsd: positive(raw.totalUsd),
  };
}

export function setProjectBudget(projectId: string, limits: ProjectBudgetLimits): ProjectBudgetConfig {
  const project = findProject(projectId);
  if (!project) throw new Error("Unknown project.");

  const raw = readRaw();
  raw[projectId] = {
    dailyUsd: positive(limits.dailyUsd),
    monthlyUsd: positive(limits.monthlyUsd),
    totalUsd: positive(limits.totalUsd),
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(BUDGETS_FILE), { recursive: true });
  writeFileSync(BUDGETS_FILE, JSON.stringify(raw, null, 2) + "\n");

  return {
    projectId,
    limits: getProjectBudget(projectId),
    updatedAt: raw[projectId].updatedAt!,
  };
}

function meter(spent: number, limit?: number): BudgetMeter {
  if (!limit) {
    return { limit, spent, pct: 0, exceeded: false, nearLimit: false };
  }
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  return {
    limit,
    spent,
    remaining: Math.max(0, limit - spent),
    pct,
    exceeded: spent >= limit,
    nearLimit: pct >= 80 && spent < limit,
  };
}

export function buildBudgetStatus(row: ProjectSpendRow, limits: ProjectBudgetLimits): ProjectBudgetStatus {
  const spent = {
    daily: row.todayUsd,
    monthly: row.monthlyUsd,
    total: row.totalUsd,
  };
  const meters = {
    daily: meter(spent.daily, limits.dailyUsd),
    monthly: meter(spent.monthly, limits.monthlyUsd),
    total: meter(spent.total, limits.totalUsd),
  };
  const hasLimits = Boolean(limits.dailyUsd || limits.monthlyUsd || limits.totalUsd);
  const anyExceeded = meters.daily.exceeded || meters.monthly.exceeded || meters.total.exceeded;
  const anyNearLimit = meters.daily.nearLimit || meters.monthly.nearLimit || meters.total.nearLimit;

  return {
    projectId: row.projectId,
    name: row.name,
    repo: row.repo,
    domain: row.domain,
    limits,
    spent,
    meters,
    anyExceeded,
    anyNearLimit,
    hasLimits,
  };
}

export function budgetStatusForProjects(byProject: ProjectSpendRow[]): ProjectBudgetStatus[] {
  const spendById = new Map(byProject.map((p) => [p.projectId, p]));
  return PROJECTS.map((project) => {
    const row = spendById.get(project.id) ?? {
      projectId: project.id,
      name: project.name,
      repo: project.repo,
      domain: project.domain,
      totalUsd: 0,
      todayUsd: 0,
      monthlyUsd: 0,
      runs: 0,
      avgCostUsd: 0,
    };
    return buildBudgetStatus(row, getProjectBudget(project.id));
  });
}

export function isProjectOverBudget(projectId: string, byProject: ProjectSpendRow[]): boolean {
  const row = byProject.find((p) => p.projectId === projectId);
  if (!row) return false;
  const status = buildBudgetStatus(row, getProjectBudget(projectId));
  return status.anyExceeded;
}

export function overBudgetMessage(projectId: string, byProject: ProjectSpendRow[]): string | null {
  const row = byProject.find((p) => p.projectId === projectId);
  if (!row) return null;
  const status = buildBudgetStatus(row, getProjectBudget(projectId));
  if (!status.anyExceeded) return null;

  const parts: string[] = [];
  if (status.meters.daily.exceeded) {
    parts.push(`daily ${usd(status.spent.daily)} / ${usd(status.limits.dailyUsd!)} limit`);
  }
  if (status.meters.monthly.exceeded) {
    parts.push(`monthly ${usd(status.spent.monthly)} / ${usd(status.limits.monthlyUsd!)} limit`);
  }
  if (status.meters.total.exceeded) {
    parts.push(`total ${usd(status.spent.total)} / ${usd(status.limits.totalUsd!)} limit`);
  }
  return `Budget exceeded for ${status.name} (${status.domain ?? status.repo}): ${parts.join("; ")}. Raise limits or wait for the period to reset.`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
