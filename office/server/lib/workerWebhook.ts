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
