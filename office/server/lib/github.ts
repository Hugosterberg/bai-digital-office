/**
 * Thin GitHub REST client for the agent task queue.
 *
 * The queue IS GitHub Issues: a task is an issue labeled `agent`, its stage
 * is a state label, and completion is the issue being closed by a merged PR
 * ("Closes #N"). No database — GitHub is the store agents already read.
 *
 * Stage labels:
 *   agent:ready          — described, waiting for the agent team
 *   agent:analyzing      — analysis agent exploring the task
 *   agent:implementing   — implementation agent building the slice
 *   agent:validating     — validation agent running verify + PR
 *   agent:review         — PR open, waiting for human review
 *   agent:idea           — growth/research backlog (not auto-built)
 *   agent:building       — legacy label (mapped to agent:implementing in UI)
 */

const API = "https://api.github.com";

export const AGENT_LABEL = "agent";
export const STAGE_LABELS = [
  "agent:ready",
  "agent:analyzing",
  "agent:implementing",
  "agent:validating",
  "agent:review",
  "agent:idea",
  "agent:building",
] as const;
export type StageLabel = (typeof STAGE_LABELS)[number];

export const PIPELINE_STAGE_LABELS = [
  "agent:analyzing",
  "agent:implementing",
  "agent:validating",
] as const;

const LABEL_DEFINITIONS: Array<{ name: string; color: string; description: string }> = [
  { name: AGENT_LABEL, color: "6f42c1", description: "Task for the AI agent workforce" },
  { name: "agent:ready", color: "0e8a16", description: "Described and ready for the agent team" },
  { name: "agent:analyzing", color: "c5def5", description: "Analysis agent exploring the task" },
  { name: "agent:implementing", color: "fbca04", description: "Implementation agent building the feature" },
  { name: "agent:validating", color: "d4c5f9", description: "Validation agent verifying and opening PR" },
  { name: "agent:building", color: "fbca04", description: "Legacy — agent working (use agent:implementing)" },
  { name: "agent:review", color: "1d76db", description: "PR open — waiting for human review" },
  { name: "agent:idea", color: "e4e669", description: "Growth/research idea — promote to agent:ready when approved" },
];

function token(): string {
  return String(process.env.GITHUB_TOKEN || "").trim();
}

export function githubConfigured(): boolean {
  return Boolean(token());
}

async function gh(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

export interface TaskIssue {
  number: number;
  title: string;
  url: string;
  stage: StageLabel | "done";
  priority: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: string | null;
  bodyPreview: string;
}

function issueToTask(raw: Record<string, unknown>): TaskIssue {
  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .map((l) => String((l as Record<string, unknown>).name || ""))
    .filter(Boolean);
  const rawStage = STAGE_LABELS.find((s) => labels.includes(s));
  const stage =
    raw.state === "closed"
      ? ("done" as const)
      : rawStage === "agent:building"
        ? ("agent:implementing" as const)
        : (rawStage ?? "agent:ready");
  const priority = labels.find((l) => l.startsWith("prio:")) ?? null;
  const assigneeRaw = raw.assignee as Record<string, unknown> | null;
  return {
    number: Number(raw.number),
    title: String(raw.title || ""),
    url: String(raw.html_url || ""),
    stage,
    priority: priority ? priority.slice(5) : null,
    createdAt: String(raw.created_at || ""),
    updatedAt: String(raw.updated_at || ""),
    assignee: assigneeRaw ? String(assigneeRaw.login || "") : null,
    bodyPreview: String(raw.body || "").slice(0, 240),
  };
}

/** Open agent tasks + the most recently closed ones, for the board. */
export async function listTasks(repo: string): Promise<TaskIssue[]> {
  const [open, closed] = await Promise.all([
    gh(`/repos/${repo}/issues?labels=${AGENT_LABEL}&state=open&per_page=50`),
    gh(`/repos/${repo}/issues?labels=${AGENT_LABEL}&state=closed&per_page=10&sort=updated&direction=desc`),
  ]);
  const rows = [
    ...(Array.isArray(open.data) ? open.data : []),
    ...(Array.isArray(closed.data) ? closed.data : []),
  ] as Array<Record<string, unknown>>;
  // The issues API also returns PRs; tasks are plain issues.
  return rows.filter((r) => !r.pull_request).map(issueToTask);
}

export interface ReviewPr {
  number: number;
  title: string;
  url: string;
  branch: string;
  updatedAt: string;
  draft: boolean;
  /** Head commit SHA — for check status. */
  headSha?: string;
  mergeable: boolean | null;
  merged: boolean;
}

/** Open PRs — the human review queue. */
export async function listOpenPrs(repo: string): Promise<ReviewPr[]> {
  const res = await gh(`/repos/${repo}/pulls?state=open&per_page=30`);
  const rows = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  return rows.map((raw) => ({
    number: Number(raw.number),
    title: String(raw.title || ""),
    url: String(raw.html_url || ""),
    branch: String((raw.head as Record<string, unknown> | null)?.ref || ""),
    updatedAt: String(raw.updated_at || ""),
    draft: Boolean(raw.draft),
    headSha: String((raw.head as Record<string, unknown> | null)?.sha || "") || undefined,
    mergeable: raw.mergeable == null ? null : Boolean(raw.mergeable),
    merged: Boolean(raw.merged),
  }));
}

const labelsEnsured = new Set<string>();

/** Create the agent label set in a repo (idempotent, cached per process). */
async function ensureLabels(repo: string): Promise<void> {
  if (labelsEnsured.has(repo)) return;
  for (const def of LABEL_DEFINITIONS) {
    const res = await gh(`/repos/${repo}/labels`, {
      method: "POST",
      body: JSON.stringify(def),
    });
    // 422 = already exists — fine. Anything else non-ok is surfaced by create.
    if (!res.ok && res.status !== 422) {
      console.warn(`[github] could not ensure label ${def.name} in ${repo} (${res.status})`);
    }
  }
  labelsEnsured.add(repo);
}

export interface CreateTaskInput {
  repo: string;
  title: string;
  context: string;
  steps: string[];
  criteria: string[];
  priority: "low" | "medium" | "high";
}

/**
 * Create a task issue using the company task template
 * (bai-digital-office/ai/agents/repo-engineer.md) so any agent can build from it.
 */
export async function createTask(
  input: CreateTaskInput
): Promise<{ ok: true; number: number; url: string } | { ok: false; status: number; message: string }> {
  await ensureLabels(input.repo);

  const body = [
    `## Context`,
    input.context.trim() || "_(none provided)_",
    ``,
    `## Build (as a vertical slice)`,
    ...input.steps.filter((s) => s.trim()).map((s, i) => `${i + 1}. ${s.trim()}`),
    ``,
    `## Done when`,
    ...input.criteria.filter((c) => c.trim()).map((c) => `- [ ] ${c.trim()}`),
    ``,
    `---`,
    `**Agent contract:** follow the repo's AGENTS.md + ai/ folder and the company`,
    `PLAYBOOK. Work on a \`feat/<slug>\` branch, keep the verify suite green, open a`,
    `PR that references this issue (\`Closes #N\`). The office agent team runs three stages:`,
    `\`agent:analyzing\` → \`agent:implementing\` → \`agent:validating\` → \`agent:review\`.`,
  ].join("\n");

  const res = await gh(`/repos/${input.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title.trim(),
      body,
      labels: [AGENT_LABEL, "agent:ready", `prio:${input.priority}`],
    }),
  });
  if (!res.ok) {
    const message = String((res.data as Record<string, unknown> | null)?.message || "GitHub rejected the issue.");
    return { ok: false, status: res.status, message };
  }
  const created = res.data as Record<string, unknown>;
  return { ok: true, number: Number(created.number), url: String(created.html_url || "") };
}

export interface PrCheckStatus {
  state: "pending" | "success" | "failure" | "unknown";
  total: number;
  passed: number;
}

export async function getPullRequestCheckStatus(
  repo: string,
  headSha: string
): Promise<PrCheckStatus> {
  if (!headSha) return { state: "unknown", total: 0, passed: 0 };
  const res = await gh(`/repos/${repo}/commits/${headSha}/check-runs?per_page=30`);
  const runs = (res.data as Record<string, unknown> | null)?.check_runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: "unknown", total: 0, passed: 0 };
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of runs) {
    const status = String((run as Record<string, unknown>).status || "");
    const conclusion = String((run as Record<string, unknown>).conclusion || "");
    if (status !== "completed") pending += 1;
    else if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") passed += 1;
    else failed += 1;
  }
  const total = runs.length;
  if (pending > 0) return { state: "pending", total, passed };
  if (failed > 0) return { state: "failure", total, passed };
  return { state: "success", total, passed };
}

export interface PullRequestDetail extends ReviewPr {
  body: string;
  checks: PrCheckStatus;
}

export async function getPullRequestDetail(
  repo: string,
  number: number
): Promise<PullRequestDetail | null> {
  const res = await gh(`/repos/${repo}/pulls/${number}`);
  if (!res.ok) return null;
  const raw = res.data as Record<string, unknown>;
  const headSha = String((raw.head as Record<string, unknown> | null)?.sha || "");
  const checks = await getPullRequestCheckStatus(repo, headSha);
  return {
    number: Number(raw.number),
    title: String(raw.title || ""),
    url: String(raw.html_url || ""),
    branch: String((raw.head as Record<string, unknown> | null)?.ref || ""),
    updatedAt: String(raw.updated_at || ""),
    draft: Boolean(raw.draft),
    headSha: headSha || undefined,
    mergeable: raw.mergeable == null ? null : Boolean(raw.mergeable),
    merged: Boolean(raw.merged),
    body: String(raw.body || ""),
    checks,
  };
}

export async function mergePullRequest(
  repo: string,
  number: number
): Promise<{ ok: true; sha: string } | { ok: false; status: number; message: string }> {
  const detail = await getPullRequestDetail(repo, number);
  if (!detail) return { ok: false, status: 404, message: "Pull request not found." };
  if (detail.merged) return { ok: false, status: 409, message: "Pull request is already merged." };
  if (detail.draft) return { ok: false, status: 400, message: "Draft PR — mark ready for review first." };
  if (detail.mergeable === false) {
    return { ok: false, status: 409, message: "GitHub reports merge conflicts." };
  }
  if (detail.checks.state === "pending") {
    return { ok: false, status: 409, message: "CI checks still running — wait for green before merge." };
  }
  if (detail.checks.state === "failure") {
    return { ok: false, status: 409, message: "CI checks failed — fix before merging to main." };
  }

  const res = await gh(`/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({
      merge_method: "squash",
      commit_title: detail.title,
    }),
  });
  if (!res.ok) {
    const message = String((res.data as Record<string, unknown> | null)?.message || "Merge failed.");
    return { ok: false, status: res.status, message };
  }
  const merged = res.data as Record<string, unknown>;
  return { ok: true, sha: String(merged.sha || "") };
}

/** Move an issue to a pipeline stage label (preserves agent + prio labels). */
export async function setIssueStage(
  repo: string,
  issueNumber: number,
  stage: StageLabel
): Promise<{ ok: true } | { ok: false; message: string }> {
  const view = await gh(`/repos/${repo}/issues/${issueNumber}`);
  if (!view.ok) {
    return { ok: false, message: "Could not load issue for stage update." };
  }
  const labels = (Array.isArray((view.data as Record<string, unknown>).labels)
    ? (view.data as Record<string, unknown>).labels
    : []) as Array<Record<string, unknown>>;
  const names = labels.map((l) => String(l.name || "")).filter(Boolean);
  const keep = names.filter((n) => n === AGENT_LABEL || n.startsWith("prio:"));
  const next = [...new Set([...keep, stage])];
  const res = await gh(`/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ labels: next }),
  });
  if (!res.ok) {
    const message = String((res.data as Record<string, unknown> | null)?.message || "Stage update failed.");
    return { ok: false, message };
  }
  return { ok: true };
}

export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await gh(`/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
