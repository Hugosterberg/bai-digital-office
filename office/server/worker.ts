/**
 * Hosted agent worker — the always-on half of the company.
 *
 * - Polls GitHub for agent:ready tasks and runs the three-agent pipeline
 * - Monitors production domains and opens incident issues
 * - Runs the weekly auto-cycle (growth ideas → prioritizer → auto-promote)
 * - Serves durable state (runs/spend/sites) to the Vercel API via GET /state
 */
import http from "node:http";
import dotenv from "dotenv";
import { pollReadyTasks } from "./lib/agentPoller.ts";
import { findProject, upsertProject, listProjects } from "./lib/projects.ts";
import { isSpecialistAgentId, applyAgentTeamConfig } from "./lib/agentConfig.ts";
import { startSpecialistRun } from "./lib/specialists.ts";
import { listDispatches, spendSummary } from "./lib/dispatch.ts";
import { setProjectBudget } from "./lib/budgets.ts";
import { startSiteMonitor, listSiteStatuses } from "./lib/siteMonitor.ts";
import { startAutoCycle, autoCycleStatus, runCycleForProject } from "./lib/autoCycle.ts";

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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "";

  if (req.method === "GET" && url === "/health") {
    return json(res, 200, { ok: true, service: "bai-agent-worker" });
  }

  // Everything below requires the shared secret.
  if (!authOk(req)) {
    return json(res, 401, { error: "Unauthorized" });
  }

  if (req.method === "GET" && url === "/state") {
    return json(res, 200, {
      dispatches: listDispatches(),
      spend: spendSummary(),
      sites: listSiteStatuses(),
      autoCycle: autoCycleStatus(),
    });
  }

  if (req.method === "POST" && url === "/poll") {
    void tick("webhook");
    return json(res, 202, { ok: true, message: "Poll triggered" });
  }

  if (req.method === "POST" && url === "/config") {
    void readJsonBody(req)
      .then((body) => {
        if (!body.stages || !body.specialists) {
          return json(res, 400, { error: "Invalid config payload." });
        }
        applyAgentTeamConfig(body as Parameters<typeof applyAgentTeamConfig>[0]);
        json(res, 200, { ok: true });
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "Bad request" }));
    return;
  }

  if (req.method === "POST" && url === "/budgets") {
    void readJsonBody(req)
      .then((body) => {
        const config = setProjectBudget(String(body.project || ""), {
          dailyUsd: body.dailyUsd != null ? Number(body.dailyUsd) : undefined,
          monthlyUsd: body.monthlyUsd != null ? Number(body.monthlyUsd) : undefined,
          totalUsd: body.totalUsd != null ? Number(body.totalUsd) : undefined,
        });
        json(res, 200, { ok: true, config });
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "Bad request" }));
    return;
  }

  if (req.method === "POST" && url === "/projects") {
    void readJsonBody(req)
      .then((body) => {
        const rows = Array.isArray(body.projects) ? body.projects : [];
        for (const row of rows) upsertProject(row as Record<string, unknown>);
        json(res, 200, { ok: true, projects: listProjects() });
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "Bad request" }));
    return;
  }

  if (req.method === "POST" && url === "/cycle") {
    void readJsonBody(req)
      .then((body) => {
        const project = findProject(String(body.project || ""));
        if (!project) return json(res, 400, { error: "Unknown project." });
        void runCycleForProject(project);
        json(res, 202, { ok: true, message: `Auto-cycle started for ${project.name}.` });
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "Bad request" }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/specialist/")) {
    const id = url.slice("/specialist/".length);
    if (!isSpecialistAgentId(id)) {
      return json(res, 400, { error: "Unknown specialist agent." });
    }
    void readJsonBody(req)
      .then((body) => {
        const project = findProject(String(body.project || ""));
        if (!project) {
          return json(res, 400, { error: "Unknown project." });
        }
        const result = startSpecialistRun({
          id,
          repo: project.repo,
          projectName: project.name,
          focus: String(body.focus || ""),
          ideaCount: body.ideaCount != null ? Number(body.ideaCount) : undefined,
        });
        if (!result.ok) {
          return json(res, result.status, { error: result.error });
        }
        json(res, 202, { ok: true, run: result.run });
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "Bad request" }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(
    `[worker] listening on :${port} (GET /health /state · POST /poll /config /budgets /projects /cycle /specialist/:id)`
  );
  void tick("startup");
  setInterval(() => void tick("interval"), intervalMs);
  startSiteMonitor();
  startAutoCycle();
});
