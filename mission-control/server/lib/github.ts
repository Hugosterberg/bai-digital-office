/**
 * Thin GitHub REST client for the agent task queue.
 *
 * The queue IS GitHub Issues: a task is an issue labeled `agent`, its stage
 * is a state label, and completion is the issue being closed by a merged PR
 * ("Closes #N"). No database — GitHub is the store agents already read.
 *
 * Stage labels:
 *   agent:ready     — described, waiting for an agent to pick it up
 *   agent:building  — an agent has claimed it and is working
 *   agent:review    — a PR is open and waits for human review
 */

const API = "https://api.github.com";

export const AGENT_LABEL = "agent";
export const STAGE_LABELS = ["agent:ready", "agent:building", "agent:review"] as const;
export type StageLabel = (typeof STAGE_LABELS)[number];

const LABEL_DEFINITIONS: Array<{ name: string; color: string; description: string }> = [
  { name: AGENT_LABEL, color: "6f42c1", description: "Task for the AI agent workforce" },
  { name: "agent:ready", color: "0e8a16", description: "Described and ready for an agent to pick up" },
  { name: "agent:building", color: "fbca04", description: "An agent is working on this" },
  { name: "agent:review", color: "1d76db", description: "PR open — waiting for human review" },
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
  const stage =
    raw.state === "closed"
      ? ("done" as const)
      : (STAGE_LABELS.find((s) => labels.includes(s)) ?? "agent:ready");
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
    `PR that references this issue (\`Closes #N\`), and move this issue's stage label`,
    `to \`agent:building\` when you start and \`agent:review\` when the PR is open.`,
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
