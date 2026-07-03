import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const queryClient = new QueryClient();

/* ── types mirrored from the server ─────────────────────────── */

interface Project {
  id: string;
  name: string;
  repo: string;
  domain?: string;
}

interface TaskIssue {
  number: number;
  title: string;
  url: string;
  stage: "agent:ready" | "agent:building" | "agent:review" | "done";
  priority: string | null;
  updatedAt: string;
  assignee: string | null;
}

interface ReviewPr {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  mergeable?: boolean | null;
  headSha?: string;
}

interface Board {
  project: Project;
  tasks: TaskIssue[];
  prs: ReviewPr[];
}

interface Dispatch {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  outputTail: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  resultSummary?: string;
}

interface SpendSummary {
  totalUsd: number;
  todayUsd: number;
  runs: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}

/* ── new task form ───────────────────────────────────────────── */

function NewTaskForm({
  projects,
  selectedProject,
  onProjectChange,
}: {
  projects: Project[];
  /** Controlled from the shell so "+ first task" on a quiet project preselects it. */
  selectedProject: string | null;
  onProjectChange: (id: string) => void;
}) {
  const qc = useQueryClient();
  const project = selectedProject ?? projects[0]?.id ?? "";
  const setProject = onProjectChange;
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [steps, setSteps] = useState("");
  const [criteria, setCriteria] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          title,
          context,
          steps: steps.split("\n").filter((s) => s.trim()),
          criteria: criteria.split("\n").filter((c) => c.trim()),
          priority,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not create the task");
      return data as { number: number; url: string };
    },
    onSuccess: () => {
      setTitle("");
      setContext("");
      setSteps("");
      setCriteria("");
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });

  const inputCls =
    "w-full rounded-md border border-bai-line bg-bai-surface px-3 py-2 text-sm text-bai-fg placeholder-bai-mute/70 focus:border-bai-orange focus:outline-none";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">New task</h2>
      <select value={project} onChange={(e) => setProject(e.target.value)} className={inputCls}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.repo}
          </option>
        ))}
      </select>
      <input
        className={inputCls}
        placeholder="Title — what the feature does, one line"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={inputCls}
        rows={3}
        placeholder="Context — where this lives in the product, patterns/files to reuse"
        value={context}
        onChange={(e) => setContext(e.target.value)}
      />
      <textarea
        className={inputCls}
        rows={3}
        placeholder={"Build steps (one per line)\n1 data · 2 API · 3 UI"}
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
      />
      <textarea
        className={inputCls}
        rows={3}
        placeholder={"Done when… (one criterion per line — agents are graded on these)"}
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
      />
      <div className="flex items-center gap-2">
        {(["low", "medium", "high"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPriority(p)}
            className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
              priority === p ? "bg-bai-orange text-bai-bg font-medium" : "bg-bai-surface text-bai-mute hover:text-bai-fg"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="submit"
          disabled={create.isPending || !title.trim()}
          className="ml-auto rounded-md bg-bai-orange px-4 py-2 text-sm font-semibold text-bai-bg hover:bg-bai-orange-deep disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Queue for agents"}
        </button>
      </div>
      {create.isError ? <p className="text-xs text-red-400">{(create.error as Error).message}</p> : null}
      {create.isSuccess ? (
        <p className="text-xs text-bai-orange">
          Created{" "}
          <a className="underline" href={create.data.url} target="_blank" rel="noreferrer">
            #{create.data.number}
          </a>{" "}
          — an agent picked it up and is building.
        </p>
      ) : null}
    </form>
  );
}

/* ── board ───────────────────────────────────────────────────── */

const STAGES = [
  { key: "agent:ready", label: "Ready", tone: "border-bai-orange" },
  { key: "agent:building", label: "Building", tone: "border-bai-metal" },
  { key: "agent:review", label: "In review", tone: "border-bai-orange-deep" },
  { key: "done", label: "Done", tone: "border-bai-line" },
] as const;

/**
 * The dispatch command for a ready task: paste into a terminal and a
 * headless Claude Code agent executes the issue end-to-end (clone →
 * feat/ branch → verify → PR → labels). The human starts every run —
 * see server/lib/dispatch.ts for the (dormant) one-click variant.
 */
function agentCommand(repo: string, issueNumber: number): string {
  return `claude -p "Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract in its body: read it with gh issue view ${issueNumber} --repo ${repo}, label agent:building, clone, build on a feat/ branch, run the repo's verify scripts until green, push, open a PR with Closes #${issueNumber}, then label agent:review. Never push to main or merge." --permission-mode acceptEdits --allowedTools "Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Edit,Write,Read,Glob,Grep"`;
}

/**
 * Dispatch a headless Claude Code agent (uses platform.claude.com credits via CLI).
 */
function TaskCard({
  task,
  repo,
  projectId,
}: {
  task: TaskIssue;
  repo: string;
  projectId: string;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const dispatch = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          issueNumber: task.number,
          title: task.title,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Dispatch failed");
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["board"] });
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
    },
  });

  return (
    <div className="rounded-md border border-bai-line bg-bai-surface p-2.5 hover:border-bai-mute/60 transition-colors">
      <a href={task.url} target="_blank" rel="noreferrer" className="block">
        <p className="text-sm text-bai-fg leading-snug">{task.title}</p>
        <p className="mt-1 text-[11px] text-bai-mute/80">
          #{task.number}
          {task.priority ? ` · ${task.priority}` : ""}
          {task.assignee ? ` · ${task.assignee}` : ""}
        </p>
      </a>
      {task.stage === "agent:ready" ? (
        <div className="mt-2 space-y-1.5">
          <button
            type="button"
            disabled={dispatch.isPending}
            onClick={() => dispatch.mutate()}
            className="w-full rounded border border-bai-orange bg-bai-orange/10 px-2 py-1.5 text-[11px] font-medium text-bai-orange hover:bg-bai-orange/20 transition-colors disabled:opacity-50"
          >
            {dispatch.isPending ? "Starting agent…" : "▶ Dispatch agent"}
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(agentCommand(repo, task.number));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="w-full rounded border border-bai-line px-2 py-1 text-[10px] text-bai-mute hover:text-bai-fg transition-colors"
          >
            {copied ? "Copied CLI command" : "Copy manual command"}
          </button>
          {dispatch.isError ? (
            <p className="text-[10px] text-red-400">{(dispatch.error as Error).message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PrReviewRow({ repo, pr, domain }: { repo: string; pr: ReviewPr; domain?: string }) {
  const qc = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["pr", repo, pr.number],
    queryFn: () =>
      getJson<{ pr: { checks: { state: string; passed: number; total: number }; mergeable: boolean | null } }>(
        `/api/prs/detail?repo=${encodeURIComponent(repo)}&number=${pr.number}`
      ),
    refetchInterval: 30_000,
  });
  const checks = detailQuery.data?.pr.checks;
  const merge = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/prs/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number: pr.number }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Merge failed");
      return data as { domain?: string | null; message?: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });

  const checkLabel =
    checks?.state === "success"
      ? `CI green (${checks.passed}/${checks.total})`
      : checks?.state === "pending"
        ? "CI running…"
        : checks?.state === "failure"
          ? "CI failed"
          : "CI unknown";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-bai-line/80 bg-bai-bg/50 px-2.5 py-2">
      <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 text-sm text-bai-fg hover:text-bai-orange">
        <span className="text-bai-mute">#{pr.number}</span> {pr.title}
        <code className="ml-2 text-[10px] text-bai-mute">{pr.branch}</code>
      </a>
      <span
        className={`text-[10px] ${
          checks?.state === "success" ? "text-emerald-400" : checks?.state === "failure" ? "text-red-400" : "text-bai-mute"
        }`}
      >
        {checkLabel}
      </span>
      <button
        type="button"
        disabled={merge.isPending || pr.draft || checks?.state === "pending" || checks?.state === "failure"}
        onClick={() => {
          if (!window.confirm(`Merge PR #${pr.number} to main and deploy${domain ? ` ${domain}` : ""}?`)) return;
          merge.mutate();
        }}
        className="rounded-md bg-bai-orange px-3 py-1 text-[11px] font-semibold text-bai-bg hover:bg-bai-orange-deep disabled:opacity-40"
      >
        {merge.isPending ? "Merging…" : "Approve → prod"}
      </button>
      {merge.isSuccess ? (
        <span className="text-[10px] text-emerald-400">Merged — deploying</span>
      ) : null}
      {merge.isError ? <span className="text-[10px] text-red-400">{(merge.error as Error).message}</span> : null}
    </div>
  );
}

function isQuiet(board: Board): boolean {
  return board.tasks.length === 0 && board.prs.length === 0;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/** Live agent runs + Claude spend — every dispatched agent and what it cost. */
function AgentActivity() {
  const query = useQuery({
    queryKey: ["dispatches"],
    queryFn: () => getJson<{ dispatches: Dispatch[]; spend: SpendSummary }>("/api/dispatches"),
    refetchInterval: 10_000,
  });
  const dispatches = query.data?.dispatches ?? [];
  const spend = query.data?.spend;
  if (dispatches.length === 0 && !spend?.runs) return null;

  const dot: Record<Dispatch["status"], string> = {
    running: "bg-bai-orange animate-pulse",
    done: "bg-bai-metal",
    failed: "bg-red-500",
  };
  return (
    <section className="rounded-lg border border-bai-line bg-bai-surface/40 p-3 space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-bai-mute">Agents</p>
        {spend ? (
          <p className="text-[11px] tabular-nums text-bai-mute">
            Claude spend: <span className="text-bai-orange">{usd(spend.todayUsd)}</span> today ·{" "}
            <span className="text-bai-fg">{usd(spend.totalUsd)}</span> total · {spend.runs} runs
          </p>
        ) : null}
      </div>
      {dispatches.map((d) => (
        <div key={d.id} className="flex items-baseline gap-2 text-sm" title={d.resultSummary || undefined}>
          <span className={`h-2 w-2 shrink-0 self-center rounded-full ${dot[d.status]}`} />
          <span className="text-bai-mute">#{d.issueNumber}</span>
          <span className="flex-1 truncate text-bai-fg">{d.title}</span>
          <code className="text-[11px] text-bai-mute">{d.repo.split("/")[1]}</code>
          {d.durationMs ? <span className="text-[11px] tabular-nums text-bai-mute">{mins(d.durationMs)}</span> : null}
          {typeof d.costUsd === "number" ? (
            <span className="text-[11px] tabular-nums text-bai-orange">{usd(d.costUsd)}</span>
          ) : null}
          <span className={`text-[11px] ${d.status === "failed" ? "text-red-400" : "text-bai-mute"}`}>
            {d.status}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * Portfolio overview — every project at a glance, one compact card each.
 * Clicking a card scrolls to that project's board (or its quiet row).
 */
function PortfolioOverview({ boards }: { boards: Board[] }) {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {boards.map((board) => {
        const count = (stage: TaskIssue["stage"]) => board.tasks.filter((t) => t.stage === stage).length;
        const quiet = isQuiet(board);
        return (
          <button
            key={board.project.id}
            type="button"
            onClick={() =>
              document
                .getElementById(`project-${board.project.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className={`rounded-lg border p-3 text-left transition-colors ${
              board.prs.length > 0
                ? "border-bai-orange/50 bg-bai-orange/5 hover:border-bai-orange"
                : quiet
                  ? "border-bai-line/60 bg-bai-surface/30 hover:border-bai-line"
                  : "border-bai-line bg-bai-surface hover:border-bai-mute/60"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-semibold text-bai-fg">{board.project.name}</p>
              {board.prs.length > 0 ? (
                <span className="shrink-0 rounded-full bg-bai-orange px-1.5 text-[10px] font-bold text-bai-bg">
                  {board.prs.length} PR
                </span>
              ) : null}
            </div>
            {quiet ? (
              <p className="mt-1.5 text-[11px] text-bai-mute/60">quiet</p>
            ) : (
              <p className="mt-1.5 flex gap-2.5 text-[11px] tabular-nums">
                <span className="text-bai-orange">{count("agent:ready")} ready</span>
                <span className="text-bai-metal">{count("agent:building")} building</span>
                <span className="text-bai-orange-deep">{count("agent:review")} review</span>
              </p>
            )}
          </button>
        );
      })}
    </section>
  );
}

/** One slim row for a project with no agent activity — no empty-column noise. */
function QuietProjectRow({ board, onNewTask }: { board: Board; onNewTask: (id: string) => void }) {
  return (
    <div id={`project-${board.project.id}`} className="scroll-mt-4 flex items-center gap-3 rounded-md border border-bai-line/70 bg-bai-surface/40 px-3 py-2">
      <span className="text-sm font-medium text-bai-fg/90">{board.project.name}</span>
      <a
        className="text-[11px] text-bai-mute/60 hover:text-bai-mute"
        href={`https://github.com/${board.project.repo}`}
        target="_blank"
        rel="noreferrer"
      >
        {board.project.repo}
      </a>
      <button
        type="button"
        onClick={() => onNewTask(board.project.id)}
        className="ml-auto rounded-md border border-bai-line px-2.5 py-1 text-xs text-bai-mute hover:border-bai-orange hover:text-bai-orange transition-colors"
      >
        + first task
      </button>
    </div>
  );
}

function ProjectBoard({ board }: { board: Board }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-bai-fg">{board.project.name}</h2>
        <a
          className="text-xs text-bai-mute hover:text-bai-metal"
          href={`https://github.com/${board.project.repo}`}
          target="_blank"
          rel="noreferrer"
        >
          {board.project.repo}
        </a>
      </div>

      {board.prs.length > 0 ? (
        <div className="rounded-lg border border-bai-orange/40 bg-bai-orange/5 p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-bai-orange">
            Awaiting your review — approve here to ship to prod
          </p>
          {board.prs.map((pr) => (
            <PrReviewRow key={pr.number} repo={board.project.repo} pr={pr} domain={board.project.domain} />
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage) => {
          const tasks = board.tasks.filter((t) => t.stage === stage.key);
          return (
            <div key={stage.key} className={`rounded-lg border-t-2 ${stage.tone} bg-bai-bg p-2 space-y-2`}>
              <p className="px-1 text-xs font-semibold uppercase tracking-wider text-bai-mute">
                {stage.label} <span className="text-bai-mute/60">{tasks.length}</span>
              </p>
              {tasks.map((task) => (
                <TaskCard
                  key={task.number}
                  task={task}
                  repo={board.project.repo}
                  projectId={board.project.id}
                />
              ))}
              {tasks.length === 0 ? <p className="px-1 pb-1 text-[11px] text-bai-mute/60">—</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── shell ───────────────────────────────────────────────────── */

function MissionControl() {
  const [formProject, setFormProject] = useState<string | null>(null);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => getJson<{ projects: Project[]; github: boolean }>("/api/projects"),
  });
  const boardQuery = useQuery({
    queryKey: ["board"],
    queryFn: () => getJson<{ boards: Board[] }>("/api/board"),
    refetchInterval: 30_000,
    enabled: Boolean(projectsQuery.data?.github),
  });

  const boards = boardQuery.data?.boards ?? [];
  const activeBoards = boards.filter((b) => !isQuiet(b));
  const quietBoards = boards.filter(isQuiet);
  const totals = boards.reduce(
    (acc, b) => {
      for (const t of b.tasks) {
        if (t.stage === "agent:ready") acc.ready += 1;
        else if (t.stage === "agent:building") acc.building += 1;
        else if (t.stage === "agent:review") acc.review += 1;
      }
      acc.prs += b.prs.length;
      return acc;
    },
    { ready: 0, building: 0, review: 0, prs: 0 }
  );

  return (
    <div className="min-h-screen bg-bai-bg text-bai-fg">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-bai-line px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            bai digital <span className="text-bai-orange">office</span>
          </h1>
          <p className="text-xs text-bai-mute">
            Write a task → agent builds a PR → you approve here → Vercel ships to prod.
          </p>
        </div>
        {boards.length > 0 ? (
          <div className="ml-auto flex items-center gap-4 text-xs tabular-nums">
            <span className="text-bai-orange">{totals.ready} ready</span>
            <span className="text-bai-metal">{totals.building} building</span>
            <span className={totals.prs > 0 ? "rounded-full bg-bai-orange px-2.5 py-1 font-semibold text-bai-bg" : "text-bai-mute"}>
              {totals.prs} awaiting review
            </span>
          </div>
        ) : null}
      </header>
      <main className="mx-auto grid max-w-7xl grid-cols-1 items-start gap-8 p-6 lg:grid-cols-[340px_1fr]">
        <aside className="lg:sticky lg:top-6">
          {projectsQuery.data ? (
            projectsQuery.data.github ? (
              <NewTaskForm
                projects={projectsQuery.data.projects}
                selectedProject={formProject}
                onProjectChange={setFormProject}
              />
            ) : (
              <p className="text-sm text-bai-orange">
                Set <code>GITHUB_TOKEN</code> in <code>.env.local</code> (repo scope) and restart the server.
              </p>
            )
          ) : (
            <p className="text-sm text-bai-mute">Loading projects…</p>
          )}
        </aside>
        <div className="space-y-10">
          {boardQuery.isLoading ? <p className="text-sm text-bai-mute">Loading board…</p> : null}
          {boardQuery.isError ? (
            <p className="text-sm text-red-400">{(boardQuery.error as Error).message}</p>
          ) : null}
          <AgentActivity />
          {boards.length > 0 ? <PortfolioOverview boards={boards} /> : null}
          {activeBoards.map((board) => (
            <ProjectBoard key={board.project.id} board={board} />
          ))}
          {quietBoards.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-bai-mute">
                Quiet projects — no agent activity yet
              </h2>
              {quietBoards.map((board) => (
                <QuietProjectRow key={board.project.id} board={board} onNewTask={setFormProject} />
              ))}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MissionControl />
    </QueryClientProvider>
  );
}
