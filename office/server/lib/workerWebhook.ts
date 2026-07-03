/**
 * Ping the hosted agent worker (Railway/Fly) to poll GitHub immediately
 * after a task is created on Vercel — no need to wait for the 90s interval.
 */

export async function notifyWorkerPoll(reason = "task"): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  const url = `${base}/poll`;
  return postWorker(url, { reason });
}

export async function notifyWorkerSpecialist(input: {
  id: "growth" | "research";
  project: string;
  focus?: string;
  ideaCount?: number;
}): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  const url = `${base}/specialist/${input.id}`;
  return postWorker(url, input);
}

export function workerConfigured(): boolean {
  return Boolean(String(process.env.WORKER_WEBHOOK_URL || "").trim());
}

export async function notifyWorkerConfig(config: unknown): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  return postWorker(`${base}/config`, config);
}

/** Forward a budget change so the worker (which enforces budgets) has the truth. */
export async function notifyWorkerBudget(input: {
  project: string;
  dailyUsd?: number | null;
  monthlyUsd?: number | null;
  totalUsd?: number | null;
}): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  return postWorker(`${base}/budgets`, input);
}

/** Forward the project registry so worker polling covers new projects. */
export async function notifyWorkerProjects(projects: unknown): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  return postWorker(`${base}/projects`, { projects });
}

/** Kick off a growth + prioritize cycle for one project on the worker. */
export async function notifyWorkerCycle(projectId: string): Promise<{ ok: boolean; skipped?: string }> {
  const base = workerBaseUrl();
  if (!base) return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  return postWorker(`${base}/cycle`, { project: projectId });
}

export interface WorkerState {
  dispatches?: unknown[];
  spend?: unknown;
  sites?: unknown[];
  autoCycle?: unknown;
  pendingApprovals?: unknown[];
}

/** Read live state (runs, spend, site checks) from the 24/7 worker — the
 * durable source of truth when the API host is serverless. */
export async function fetchWorkerState(): Promise<WorkerState | null> {
  const base = workerBaseUrl();
  if (!base) return null;
  const secret = String(process.env.WORKER_SECRET || "").trim();
  try {
    const res = await fetch(`${base}/state`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as WorkerState;
  } catch {
    return null;
  }
}

function workerBaseUrl(): string {
  const raw = String(process.env.WORKER_WEBHOOK_URL || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  return raw.endsWith("/poll") ? raw.slice(0, -"/poll".length) : raw;
}

async function postWorker(url: string, body: unknown): Promise<{ ok: boolean }> {
  const secret = String(process.env.WORKER_SECRET || "").trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn(`[worker-webhook] ${res.status} from ${url}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[worker-webhook] notify failed:", err);
    return { ok: false };
  }
}
