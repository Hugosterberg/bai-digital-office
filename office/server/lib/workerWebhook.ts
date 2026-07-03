/**
 * Ping the hosted agent worker (Railway/Fly) to poll GitHub immediately
 * after a task is created on Vercel — no need to wait for the 90s interval.
 */

export async function notifyWorkerPoll(reason = "task"): Promise<{ ok: boolean; skipped?: string }> {
  const base = String(process.env.WORKER_WEBHOOK_URL || "").trim().replace(/\/$/, "");
  if (!base) {
    return { ok: false, skipped: "WORKER_WEBHOOK_URL not set" };
  }
  const url = base.endsWith("/poll") ? base : `${base}/poll`;
  const secret = String(process.env.WORKER_SECRET || "").trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason }),
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
