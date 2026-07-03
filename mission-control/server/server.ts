/**
 * Mission Control API — a thin layer over GitHub. Issues labeled `agent` are
 * the task queue; PRs are the review queue. No database.
 *
 *   GET  /api/projects  — the project registry (mirrors PORTFOLIO.md)
 *   GET  /api/board     — tasks by stage + open PRs, per project
 *   POST /api/tasks     — create a task issue from the company template
 */
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PROJECTS, findProject } from "./lib/projects.ts";
import { githubConfigured, listTasks, listOpenPrs, createTask } from "./lib/github.ts";

dotenv.config({ path: [".env.local", ".env"] });

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, github: githubConfigured() });
});

app.get("/api/projects", (_req, res) => {
  res.json({ projects: PROJECTS, github: githubConfigured() });
});

app.get("/api/board", async (req, res) => {
  if (!githubConfigured()) {
    return res.status(503).json({ error: "GITHUB_TOKEN is not set — add it to .env.local." });
  }
  const projectId = String(req.query.project || "").trim();
  const projects = projectId ? [findProject(projectId)].filter(Boolean) : PROJECTS;
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

app.post("/api/tasks", async (req, res) => {
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
    return res.status(400).json({ error: "At least one done-criterion is required — agents are graded against them." });
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
  res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`mission-control api on :${PORT}`));
