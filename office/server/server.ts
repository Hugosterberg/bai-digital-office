/**
 * bai digital office API — GitHub Issues = task queue, PRs = review queue.
 *
 *   GET  /api/projects   — project registry
 *   GET  /api/board      — kanban + open PRs
 *   POST /api/tasks      — create task + auto-dispatch agent
 *   POST /api/dispatch   — dispatch agent on existing agent:ready task
 *   POST /api/prs/merge  — squash-merge PR → Vercel deploys main
 *   GET  /api/prs/detail — PR + CI status
 *   GET  /api/agents     — provider catalog + agent team settings
 *   PUT  /api/agent-team — save pipeline agent settings
 *   GET  /api/dispatches — agent run history + spend by provider
 *   POST /api/runs       — log a manual run (Cursor, interactive Claude, API)
 *   GET  /api/budgets    — per-project limits + spend status
 *   PUT  /api/budgets    — set limits for a project
 */
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjects, findProject, upsertProject, removeProject, setProjectAutonomy } from "./lib/projects.ts";
import {
  githubConfigured,
  listTasks,
  listOpenPrs,
  createTask,
  getPullRequestDetail,
  mergePullRequest,
  promoteIdeaToReady,
  dismissIdea,
  setIssueStage,
} from "./lib/github.ts";
import { agentCatalog } from "./lib/agents.ts";
import {
  listPipelineAgentViews,
  listSpecialistAgentViews,
  readAgentTeamConfig,
  resetAgentTeamStage,
  resetSpecialistAgent,
  setAgentTeamConfig,
  isSpecialistAgentId,
  exportAgentTeamConfigForWorker,
  SUGGESTED_MODELS,
  type PipelineStageId,
  type StageSettings,
} from "./lib/agentConfig.ts";
import { startSpecialistRun } from "./lib/specialists.ts";
import { readAllBudgets, setProjectBudget, budgetStatusForProjects } from "./lib/budgets.ts";
import {
  listDispatches,
  spendSummary,
  startDispatch,
  dispatchAvailable,
  runningDispatchCount,
  logManualRun,
} from "./lib/dispatch.ts";
import { startAgentPoller } from "./lib/agentPoller.ts";
import { requireWriteAuth } from "./lib/auth.ts";
import {
  notifyWorkerPoll,
  notifyWorkerSpecialist,
  notifyWorkerConfig,
  notifyWorkerBudget,
  notifyWorkerProjects,
  fetchWorkerState,
  workerConfigured,
} from "./lib/workerWebhook.ts";
import { notify, notificationsConfigured } from "./lib/notify.ts";
import { startSiteMonitor, listSiteStatuses, checkAllSites, verifyDomainAfterDeploy } from "./lib/siteMonitor.ts";
import { autoCycleStatus } from "./lib/autoCycle.ts";
import { startSlackApprovalPolling, slackApprovalsConfigured } from "./lib/slackApprovals.ts";

dotenv.config({ path: [".env.local", ".env"] });

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    github: githubConfigured(),
    dispatch: dispatchAvailable(),
    worker: workerConfigured(),
    notifications: notificationsConfigured(),
    slackApprovals: slackApprovalsConfigured(),
    runningAgents: runningDispatchCount(),
    autoPoll: process.env.AGENT_POLL_ENABLED === "true",
    writeAuthRequired: Boolean(String(process.env.OFFICE_SECRET || "").trim()),
  });
});

app.get("/api/projects", (_req, res) => {
  res.json({
    projects: listProjects(),
    github: githubConfigured(),
    dispatch: dispatchAvailable(),
    worker: workerConfigured(),
  });
});

/** Add or update a project in the portfolio (runtime registry). */
app.put("/api/projects", requireWriteAuth, (req, res) => {
  try {
    const project = upsertProject(req.body as Record<string, unknown>);
    void notifyWorkerProjects(listProjects());
    res.json({ ok: true, project, projects: listProjects() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save project." });
  }
});

/** Set autonomy level: manual | auto-safe | full. */
app.put("/api/projects/:id/autonomy", requireWriteAuth, (req, res) => {
  const level = String(req.body?.autonomy || "");
  if (level !== "manual" && level !== "auto-safe" && level !== "full") {
    return res.status(400).json({ error: "autonomy must be manual, auto-safe, or full." });
  }
  try {
    const project = setProjectAutonomy(String(req.params.id || ""), level);
    void notifyWorkerProjects(listProjects());
    res.json({ ok: true, project });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not set autonomy." });
  }
});

app.delete("/api/projects/:id", requireWriteAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!findProject(id)) return res.status(404).json({ error: "Unknown project." });
  removeProject(id);
  void notifyWorkerProjects(listProjects());
  res.json({ ok: true, projects: listProjects() });
});

/** Site monitor status — local checks, or the worker's when this host is serverless. */
app.get("/api/sites", async (_req, res) => {
  if (!dispatchAvailable() && workerConfigured()) {
    const state = await fetchWorkerState();
    if (state?.sites) {
      return res.json({ sites: state.sites, autoCycle: state.autoCycle ?? null, source: "worker" });
    }
  }
  res.json({ sites: listSiteStatuses(), autoCycle: autoCycleStatus(), source: "local" });
});

/** Run a site check across all domains right now. */
app.post("/api/sites/check", requireWriteAuth, async (_req, res) => {
  const sites = await checkAllSites();
  res.json({ ok: true, sites });
});

app.get("/api/agents", (_req, res) => {
  const config = readAgentTeamConfig();
  res.json({
    providers: agentCatalog({ dispatchEnabled: dispatchAvailable(), workerConfigured: workerConfigured() }),
    team: listPipelineAgentViews(),
    specialists: listSpecialistAgentViews(),
    suggestedModels: SUGGESTED_MODELS,
    teamUpdatedAt: config.updatedAt,
    defaultProvider: "claude-code",
  });
});

app.put("/api/agent-team", requireWriteAuth, (req, res) => {
  const stages = req.body?.stages as Partial<Record<PipelineStageId, Partial<StageSettings>>> | undefined;
  const specialists = req.body?.specialists as
    | Partial<Record<"growth" | "research", Partial<StageSettings>>>
    | undefined;
  if (!stages && !specialists) {
    return res.status(400).json({ error: "stages or specialists object is required." });
  }
  try {
    const config = setAgentTeamConfig({ stages, specialists });
    void notifyWorkerConfig(exportAgentTeamConfigForWorker());
    res.json({
      ok: true,
      team: listPipelineAgentViews(),
      specialists: listSpecialistAgentViews(),
      updatedAt: config.updatedAt,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save agent settings." });
  }
});

app.post("/api/agent-team/:stage/reset", requireWriteAuth, (req, res) => {
  const stage = String(req.params.stage || "").trim();
  try {
    if (isSpecialistAgentId(stage)) {
      const config = resetSpecialistAgent(stage);
      return res.json({
        ok: true,
        team: listPipelineAgentViews(),
        specialists: listSpecialistAgentViews(),
        updatedAt: config.updatedAt,
      });
    }
    if (stage !== "analyze" && stage !== "implement" && stage !== "validate") {
      return res.status(400).json({ error: "Unknown agent." });
    }
    const config = resetAgentTeamStage(stage);
    res.json({
      ok: true,
      team: listPipelineAgentViews(),
      specialists: listSpecialistAgentViews(),
      updatedAt: config.updatedAt,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not reset agent." });
  }
});

app.post("/api/specialists/:id/run", requireWriteAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!isSpecialistAgentId(id)) {
    return res.status(400).json({ error: "Unknown specialist agent." });
  }
  const project = findProject(String(req.body?.project || ""));
  if (!project) return res.status(400).json({ error: "Unknown project." });

  if (!dispatchAvailable()) {
    const ping = await notifyWorkerSpecialist({
      id,
      project: project.id,
      focus: String(req.body?.focus || ""),
      ideaCount: req.body?.ideaCount != null ? Number(req.body.ideaCount) : undefined,
    });
    if (ping.ok) {
      return res.json({
        ok: true,
        message: `${id} agent started on worker — check GitHub for new agent:idea issues shortly.`,
      });
    }
    return res.status(503).json({
      error: "Specialist agents need the Railway worker or local dispatch enabled.",
    });
  }

  const result = startSpecialistRun({
    id,
    repo: project.repo,
    projectName: project.name,
    focus: String(req.body?.focus || ""),
    ideaCount: req.body?.ideaCount != null ? Number(req.body.ideaCount) : undefined,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ ok: true, run: result.run });
});

app.get("/api/board", async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set — add it to .env.local." });
  }
  const projectId = String(req.query.project || "").trim();
  const projects = projectId ? [findProject(projectId)].filter(Boolean) : listProjects();
  try {
    const boards = await Promise.all(
      projects.map(async (project) => {
        const [tasks, prs] = await Promise.all([
          listTasks(project!.repo),
          listOpenPrs(project!.repo),
        ]);
        return { project: project!, tasks, prs };
      })
    );
    res.json({ boards, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[board] failed:", err);
    res.status(502).json({ error: "Could not load the board from GitHub." });
  }
});

app.post("/api/tasks", requireWriteAuth, async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set — add it to .env.local." });
  }
  const project = findProject(String(req.body?.project || ""));
  const title = String(req.body?.title || "").trim();
  const criteria = Array.isArray(req.body?.criteria)
    ? req.body.criteria.map(String).filter((c: string) => c.trim())
    : [];
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!title) return res.status(400).json({ error: "Title is required." });
  if (criteria.length === 0) {
    return res.status(400).json({ error: "At least one done-criterion is required." });
  }

  const priorityRaw = String(req.body?.priority || "medium");
  const result = await createTask({
    repo: project.repo,
    title,
    context: String(req.body?.context || ""),
    steps: Array.isArray(req.body?.steps) ? req.body.steps.map(String) : [],
    criteria,
    priority: priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium",
  });
  if (result.ok === false) {
    return res.status(result.status === 404 ? 404 : 502).json({ error: result.message });
  }

  const autoDispatch = req.body?.autoDispatch !== false && dispatchAvailable();
  let agent: unknown = { skipped: "dispatch disabled on this host" };
  if (autoDispatch) {
    const dispatch = startDispatch({ repo: project.repo, issueNumber: result.number, title });
    agent = dispatch.ok ? dispatch.dispatch : { error: dispatch.error };
  } else {
    void notifyWorkerPoll("task-created");
  }
  res.json({ ...result, agent });
});

/** Dispatch a Claude Code agent on an existing agent:ready issue. */
app.post("/api/dispatch", requireWriteAuth, async (req, res) => {
  if (!dispatchAvailable()) {
    const ping = await notifyWorkerPoll("dispatch-request");
    if (ping.ok) {
      return res.json({
        ok: true,
        message: "Hosted agent worker notified — the agent will start within a few seconds.",
      });
    }
    return res.status(503).json({
      error:
        "Agent dispatch is disabled on this host and no WORKER_WEBHOOK_URL is configured. Deploy the Railway worker or run `npm run worker` locally.",
    });
  }
  const project = findProject(String(req.body?.project || ""));
  const issueNumber = Number(req.body?.issueNumber);
  const title = String(req.body?.title || "").trim();
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: "issueNumber is required." });
  }

  const tasks = await listTasks(project.repo);
  const task = tasks.find((t) => t.number === issueNumber);
  if (!task) return res.status(404).json({ error: "Issue not found." });
  if (task.stage !== "agent:ready") {
    return res.status(409).json({ error: `Task is ${task.stage}, not agent:ready.` });
  }

  const dispatch = startDispatch({
    repo: project.repo,
    issueNumber,
    title: title || task.title,
    provider: String(req.body?.provider || "claude-code"),
  });
  if (!dispatch.ok) {
    return res.status(dispatch.status).json({ error: dispatch.error });
  }
  res.json({ ok: true, dispatch: dispatch.dispatch });
});

/** Promote agent:idea → agent:ready (build queue). */
app.post("/api/tasks/promote", requireWriteAuth, async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set." });
  }
  const project = findProject(String(req.body?.project || ""));
  const issueNumber = Number(req.body?.issueNumber);
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: "issueNumber is required." });
  }
  const result = await promoteIdeaToReady(project.repo, issueNumber);
  if (!result.ok) return res.status(result.status).json({ error: result.message });
  void notifyWorkerPoll("idea-promoted");
  void notify({
    kind: "idea-promoted",
    repo: project.repo,
    issueNumber,
    title: String(req.body?.title || `#${issueNumber}`),
    by: "human (office)",
  });
  res.json({ ok: true, message: "Idea promoted to agent:ready." });
});

/** Unblock a failed task: agent:blocked → agent:ready with attempts cleared. */
app.post("/api/tasks/unblock", requireWriteAuth, async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set." });
  }
  const project = findProject(String(req.body?.project || ""));
  const issueNumber = Number(req.body?.issueNumber);
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: "issueNumber is required." });
  }
  const result = await setIssueStage(project.repo, issueNumber, "agent:ready", { attempts: null });
  if (!result.ok) return res.status(502).json({ error: result.message });
  void notifyWorkerPoll("task-unblocked");
  res.json({ ok: true, message: "Task unblocked — back in the agent queue." });
});

/** Dismiss an agent:idea (close issue). */
app.post("/api/tasks/dismiss", requireWriteAuth, async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set." });
  }
  const project = findProject(String(req.body?.project || ""));
  const issueNumber = Number(req.body?.issueNumber);
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: "issueNumber is required." });
  }
  const result = await dismissIdea(project.repo, issueNumber);
  if (!result.ok) return res.status(result.status).json({ error: result.message });
  res.json({ ok: true, message: "Idea dismissed." });
});

app.get("/api/prs/detail", async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set." });
  }
  const repo = String(req.query.repo || "").trim();
  const number = Number(req.query.number);
  if (!repo || !Number.isInteger(number)) {
    return res.status(400).json({ error: "repo and number query params required." });
  }
  const detail = await getPullRequestDetail(repo, number);
  if (!detail) return res.status(404).json({ error: "Pull request not found." });
  res.json({ pr: detail });
});

/** Approve + ship: squash-merge to main. Vercel deploys prod on push to main. */
app.post("/api/prs/merge", requireWriteAuth, async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set." });
  }
  const repo = String(req.body?.repo || "").trim();
  const number = Number(req.body?.number);
  if (!repo || !Number.isInteger(number)) {
    return res.status(400).json({ error: "repo and number are required." });
  }
  const project = listProjects().find((p) => p.repo === repo);
  if (!project) {
    return res.status(400).json({ error: "Unknown repo — not in portfolio." });
  }

  const result = await mergePullRequest(repo, number);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.message });
  }
  void notify({ kind: "merged", repo, prNumber: number, by: "godkänd i office", domain: project.domain });
  if (project.domain) {
    void verifyDomainAfterDeploy(project);
  }
  res.json({
    ok: true,
    sha: result.sha,
    message: "Merged to main — Vercel will deploy production when the repo is linked.",
    domain: project.domain ?? null,
  });
});

app.get("/api/dispatches", async (_req, res) => {
  // Serverless host: the Railway worker holds the durable run log — prefer it.
  if (!dispatchAvailable() && workerConfigured()) {
    const state = await fetchWorkerState();
    if (state?.dispatches && state?.spend) {
      return res.json({ dispatches: state.dispatches, spend: state.spend, source: "worker" });
    }
  }
  res.json({ dispatches: listDispatches(), spend: spendSummary(), source: "local" });
});

/** Log a run done outside office auto-dispatch (Cursor, interactive Claude, API). */
app.post("/api/runs", requireWriteAuth, (req, res) => {
  const project = findProject(String(req.body?.project || ""));
  const issueNumber = Number(req.body?.issueNumber);
  const title = String(req.body?.title || "").trim();
  if (!project) return res.status(400).json({ error: "Unknown project." });
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return res.status(400).json({ error: "issueNumber is required." });
  }
  if (!title) return res.status(400).json({ error: "title is required." });

  const run = logManualRun({
    provider: String(req.body?.provider || ""),
    repo: project.repo,
    issueNumber,
    title,
    costUsd: req.body?.costUsd != null ? Number(req.body.costUsd) : undefined,
    durationMs: req.body?.durationMs != null ? Number(req.body.durationMs) : undefined,
    notes: String(req.body?.notes || ""),
  });
  res.json({ ok: true, run });
});

app.get("/api/budgets", (_req, res) => {
  const spend = spendSummary();
  res.json({ budgets: spend.budgets, configs: readAllBudgets() });
});

app.put("/api/budgets", requireWriteAuth, (req, res) => {
  const projectId = String(req.body?.project || "").trim();
  if (!findProject(projectId)) {
    return res.status(400).json({ error: "Unknown project." });
  }
  try {
    const config = setProjectBudget(projectId, {
      dailyUsd: req.body?.dailyUsd != null ? Number(req.body.dailyUsd) : undefined,
      monthlyUsd: req.body?.monthlyUsd != null ? Number(req.body.monthlyUsd) : undefined,
      totalUsd: req.body?.totalUsd != null ? Number(req.body.totalUsd) : undefined,
    });
    void notifyWorkerBudget({
      project: projectId,
      dailyUsd: req.body?.dailyUsd != null ? Number(req.body.dailyUsd) : undefined,
      monthlyUsd: req.body?.monthlyUsd != null ? Number(req.body.monthlyUsd) : undefined,
      totalUsd: req.body?.totalUsd != null ? Number(req.body.totalUsd) : undefined,
    });
    const status = budgetStatusForProjects(spendSummary().byProject).find((b) => b.projectId === projectId);
    res.json({ ok: true, config, status });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save budget." });
  }
});

/** Production: serve the Vite build. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(join(distDir, "index.html"), (err) => {
    if (err) res.status(404).send("Run npm run build first.");
  });
});

export default app;

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("server/server.ts");
if (isDirectRun) {
  startAgentPoller(Number(process.env.AGENT_POLL_INTERVAL_MS) || 90_000);
  startSiteMonitor();
  startSlackApprovalPolling();
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`bai digital office api on :${PORT}`));
}
