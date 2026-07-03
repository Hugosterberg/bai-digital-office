/**
 * Auto-cycle — the company generates its own work.
 *
 * On a schedule (default weekly), for each project with autoCycle enabled:
 *   1. Run the growth specialist → agent:idea issues
 *   2. Run a prioritizer agent that ranks all open agent:idea issues
 *      (impact × effort × cost fit) and promotes the single best one
 *      to agent:ready — the pipeline then builds it automatically.
 *
 * The worker poller picks up the promoted issue like any other ready task.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjects, type Project } from "./projects.ts";
import { startSpecialistRun } from "./specialists.ts";
import { runClaude } from "./claude.ts";
import { getSpecialistSettings } from "./agentConfig.ts";
import { githubConfigured } from "./github.ts";
import { notify } from "./notify.ts";

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "auto-cycle.json");
const CYCLE_INTERVAL_MS = Number(process.env.AUTO_CYCLE_INTERVAL_MS) || 7 * 24 * 60 * 60_000;
/** Delay between growth run and prioritization so idea issues exist. */
const PRIORITIZE_DELAY_MS = 20 * 60_000;

interface CycleState {
  lastRunAt?: string;
  lastProjectId?: string;
  history: Array<{ projectId: string; ranAt: string; promoted?: string }>;
}

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

function readState(): CycleState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as CycleState;
  } catch {
    return { history: [] };
  }
}

function writeState(state: CycleState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, history: state.history.slice(-50) }, null, 2) + "\n");
}

export interface AutoCycleStatusView {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRunAt?: string;
  lastProjectId?: string;
  nextRunAt?: string;
  history: Array<{ projectId: string; ranAt: string; promoted?: string }>;
}

export function autoCycleStatus(): AutoCycleStatusView {
  const state = readState();
  const enabled = process.env.AUTO_CYCLE_ENABLED === "true";
  const nextRunAt =
    enabled && state.lastRunAt
      ? new Date(Date.parse(state.lastRunAt) + CYCLE_INTERVAL_MS).toISOString()
      : undefined;
  return {
    enabled,
    running: cycleRunning,
    intervalMs: CYCLE_INTERVAL_MS,
    lastRunAt: state.lastRunAt,
    lastProjectId: state.lastProjectId,
    nextRunAt,
    history: [...state.history].reverse().slice(0, 10),
  };
}

function prioritizePrompt(project: Project): string {
  return [
    `You are the portfolio prioritizer on the BAI Digital agent team. Pick the single best open idea to build next for ${project.repo}.`,
    ``,
    `1. List open ideas: gh issue list --repo ${project.repo} --label "agent:idea" --state open --json number,title,body --limit 30`,
    `2. If there are no open agent:idea issues, print "No ideas to prioritize" and stop.`,
    `3. Rank them by: business impact, user value, effort (smaller is better), and buildability as one vertical slice.`,
    `4. Promote exactly ONE winner:`,
    `   gh issue edit <number> --repo ${project.repo} --remove-label "agent:idea" --add-label "agent:ready"`,
    `   gh issue comment <number> --repo ${project.repo} --body "Auto-promoted by the prioritizer agent: <one-line reason>. The build pipeline will pick this up."`,
    `5. Do NOT promote more than one. Do NOT implement anything. Do NOT touch non-idea issues.`,
    ``,
    `Finish by printing "Promoted #<number>: <title>" or "No ideas to prioritize".`,
  ].join("\n");
}

/** Run one full cycle for a project: growth ideas → wait → prioritize → promote. */
export async function runCycleForProject(project: Project): Promise<{ ok: boolean; detail: string }> {
  if (!githubConfigured()) return { ok: false, detail: "GitHub not configured." };

  const growth = startSpecialistRun({
    id: "growth",
    repo: project.repo,
    projectName: project.name,
    focus: "",
    ideaCount: 4,
  });
  if (!growth.ok) return { ok: false, detail: `Growth agent could not start: ${growth.error}` };

  await new Promise((r) => setTimeout(r, PRIORITIZE_DELAY_MS));

  const settings = getSpecialistSettings("research");
  const workdir = mkdtempSync(join(tmpdir(), "bai-prioritize-"));
  const result = await runClaude(workdir, prioritizePrompt(project), settings.model);

  const promoted = /Promoted #(\d+)/.exec(result.resultSummary ?? "")?.[0];
  if (promoted) {
    void notify({
      kind: "idea-promoted",
      repo: project.repo,
      issueNumber: Number(/#(\d+)/.exec(promoted)?.[1]) || 0,
      title: result.resultSummary?.split(":").slice(1).join(":").trim() || "auto-cycle pick",
      by: "prioritizer agent",
    });
  }

  const state = readState();
  state.lastRunAt = new Date().toISOString();
  state.lastProjectId = project.id;
  state.history.push({ projectId: project.id, ranAt: state.lastRunAt, promoted });
  writeState(state);

  return { ok: result.ok, detail: result.resultSummary ?? "cycle finished" };
}

/** Round-robin: run the cycle for the project least recently cycled. */
export async function runNextCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const projects = listProjects().filter((p) => p.domain);
    if (projects.length === 0) return;
    const state = readState();
    const lastIdx = projects.findIndex((p) => p.id === state.lastProjectId);
    const next = projects[(lastIdx + 1) % projects.length];
    console.log(`[auto-cycle] running growth + prioritize cycle for ${next.repo}`);
    const result = await runCycleForProject(next);
    console.log(`[auto-cycle] ${next.repo}: ${result.detail}`);
  } catch (err) {
    console.error("[auto-cycle] failed:", err);
  } finally {
    cycleRunning = false;
  }
}

export function startAutoCycle(): void {
  if (cycleTimer) return;
  if (process.env.AUTO_CYCLE_ENABLED !== "true") {
    console.log("[auto-cycle] AUTO_CYCLE_ENABLED is not true — weekly idea cycle disabled.");
    return;
  }

  const state = readState();
  const sinceLast = state.lastRunAt ? Date.now() - Date.parse(state.lastRunAt) : Infinity;
  const firstDelay = Math.max(60_000, CYCLE_INTERVAL_MS - sinceLast);

  setTimeout(() => {
    void runNextCycle();
    cycleTimer = setInterval(() => void runNextCycle(), CYCLE_INTERVAL_MS);
  }, firstDelay);

  console.log(
    `[auto-cycle] enabled — next cycle in ${Math.round(firstDelay / 60_000)}m, then every ${Math.round(CYCLE_INTERVAL_MS / 3_600_000)}h`
  );
}
