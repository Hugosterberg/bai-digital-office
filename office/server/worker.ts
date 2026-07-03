/**
 * Hosted agent worker — polls GitHub for agent:ready tasks and runs
 * headless Claude Code (`claude -p`) + on-demand specialist agents.
 */
import http from "node:http";
import dotenv from "dotenv";
import { pollReadyTasks } from "./lib/agentPoller.ts";
import { findProject } from "./lib/projects.ts";
import { isSpecialistAgentId } from "./lib/agentConfig.ts";
import { startSpecialistRun } from "./lib/specialists.ts";

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

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
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

  if (req.method === "POST" && url.startsWith("/specialist/")) {
    if (!authOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const id = url.slice("/specialist/".length);
    if (!isSpecialistAgentId(id)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown specialist agent." }));
      return;
    }
    void readJsonBody(req)
      .then((body) => {
        const project = findProject(String(body.project || ""));
        if (!project) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown project." }));
          return;
        }
        const result = startSpecialistRun({
          id,
          repo: project.repo,
          projectName: project.name,
          focus: String(body.focus || ""),
          ideaCount: body.ideaCount != null ? Number(body.ideaCount) : undefined,
        });
        if (!result.ok) {
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, run: result.run }));
      })
      .catch((err) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }));
      });
    return;
  }

  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`[worker] listening on :${port} (GET /health · POST /poll · POST /specialist/:id)`);
  void tick("startup");
  setInterval(() => void tick("interval"), intervalMs);
});
