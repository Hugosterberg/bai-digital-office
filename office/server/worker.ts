/**
 * Hosted agent worker — polls GitHub for agent:ready tasks and dispatches
 * headless Claude Code (`claude -p`).
 *
 * Deploy on Railway/Fly (always-on). Vercel hosts the UI only and pings
 * POST /poll when a new task is created (WORKER_WEBHOOK_URL).
 */
import http from "node:http";
import dotenv from "dotenv";
import { pollReadyTasks } from "./lib/agentPoller.ts";

dotenv.config({ path: [".env.local", ".env"] });

const intervalMs = Number(process.env.AGENT_POLL_INTERVAL_MS) || 90_000;
const workerSecret = String(process.env.WORKER_SECRET || "").trim();
const port = Number(process.env.PORT) || 3000;

console.log("[worker] BAI agent worker — hosted mode");
console.log(
  `[worker] poll every ${Math.round(intervalMs / 1000)}s · DISPATCH_DISABLED=${process.env.DISPATCH_DISABLED ?? "false"}`
);

async function tick(source = "interval"): Promise<void> {
  try {
    const { dispatched, skipped } = await pollReadyTasks();
    if (dispatched > 0 || skipped > 0) {
      console.log(`[worker] ${source}: dispatched=${dispatched} skipped=${skipped}`);
    }
  } catch (err) {
    console.error(`[worker] ${source} poll failed:`, err);
  }
}

function authOk(req: http.IncomingMessage): boolean {
  if (!workerSecret) return true;
  return String(req.headers.authorization || "").trim() === `Bearer ${workerSecret}`;
}

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "";

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "bai-agent-worker" }));
    return;
  }

  if (req.method === "POST" && url === "/poll") {
    if (!authOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    void tick("webhook");
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Poll triggered" }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`[worker] listening on :${port} (GET /health · POST /poll)`);
  void tick("startup");
  setInterval(() => void tick("interval"), intervalMs);
});
