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
}

interface Board {
  project: Project;
  tasks: TaskIssue[];
  prs: ReviewPr[];
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
    "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">New task</h2>
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
              priority === p ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="submit"
          disabled={create.isPending || !title.trim()}
          className="ml-auto rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Queue for agents"}
        </button>
      </div>
      {create.isError ? <p className="text-xs text-red-400">{(create.error as Error).message}</p> : null}
      {create.isSuccess ? (
        <p className="text-xs text-emerald-400">
          Created{" "}
          <a className="underline" href={create.data.url} target="_blank" rel="noreferrer">
            #{create.data.number}
          </a>{" "}
          — labeled <code>agent:ready</code>.
        </p>
      ) : null}
    </form>
  );
}

/* ── board ───────────────────────────────────────────────────── */

const STAGES = [
  { key: "agent:ready", label: "Ready", tone: "border-emerald-700" },
  { key: "agent:building", label: "Building", tone: "border-amber-600" },
  { key: "agent:review", label: "In review", tone: "border-blue-600" },
  { key: "done", label: "Done", tone: "border-zinc-700" },
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

function TaskCard({ task, repo }: { task: TaskIssue; repo: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 p-2.5 hover:border-zinc-600 transition-colors">
      <a href={task.url} target="_blank" rel="noreferrer" className="block">
        <p className="text-sm text-zinc-100 leading-snug">{task.title}</p>
        <p className="mt-1 text-[11px] text-zinc-500">
          #{task.number}
          {task.priority ? ` · ${task.priority}` : ""}
          {task.assignee ? ` · ${task.assignee}` : ""}
        </p>
      </a>
      {task.stage === "agent:ready" ? (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(agentCommand(repo, task.number));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="mt-2 w-full rounded border border-emerald-800 px-2 py-1 text-[11px] text-emerald-400 hover:bg-emerald-950/40 transition-colors"
        >
          {copied ? "Copied — paste in a terminal" : "▶ Copy agent command"}
        </button>
      ) : null}
    </div>
  );
}

function isQuiet(board: Board): boolean {
  return board.tasks.length === 0 && board.prs.length === 0;
}

/** One slim row for a project with no agent activity — no empty-column noise. */
function QuietProjectRow({ board, onNewTask }: { board: Board; onNewTask: (id: string) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-zinc-800/70 bg-zinc-900/40 px-3 py-2">
      <span className="text-sm font-medium text-zinc-300">{board.project.name}</span>
      <a
        className="text-[11px] text-zinc-600 hover:text-zinc-400"
        href={`https://github.com/${board.project.repo}`}
        target="_blank"
        rel="noreferrer"
      >
        {board.project.repo}
      </a>
      <button
        type="button"
        onClick={() => onNewTask(board.project.id)}
        className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-emerald-600 hover:text-emerald-400 transition-colors"
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
        <h2 className="text-lg font-semibold text-zinc-100">{board.project.name}</h2>
        <a
          className="text-xs text-zinc-500 hover:text-zinc-300"
          href={`https://github.com/${board.project.repo}`}
          target="_blank"
          rel="noreferrer"
        >
          {board.project.repo}
        </a>
      </div>

      {board.prs.length > 0 ? (
        <div className="rounded-lg border border-blue-900/60 bg-blue-950/30 p-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-300">
            Awaiting your review
          </p>
          {board.prs.map((pr) => (
            <a
              key={pr.number}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-baseline gap-2 text-sm text-zinc-100 hover:text-blue-300"
            >
              <span className="text-zinc-500">#{pr.number}</span>
              <span className="flex-1">{pr.title}</span>
              <code className="text-[11px] text-zinc-500">{pr.branch}</code>
              {pr.draft ? <span className="text-[11px] text-zinc-500">draft</span> : null}
            </a>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stage) => {
          const tasks = board.tasks.filter((t) => t.stage === stage.key);
          return (
            <div key={stage.key} className={`rounded-lg border-t-2 ${stage.tone} bg-zinc-950 p-2 space-y-2`}>
              <p className="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {stage.label} <span className="text-zinc-600">{tasks.length}</span>
              </p>
              {tasks.map((task) => (
                <TaskCard key={task.number} task={task} repo={board.project.repo} />
              ))}
              {tasks.length === 0 ? <p className="px-1 pb-1 text-[11px] text-zinc-600">—</p> : null}
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
    refetchInterval: 60_000,
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-zinc-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">
            BAI <span className="text-emerald-500">Mission Control</span>
          </h1>
          <p className="text-xs text-zinc-500">
            Write a well-described task → it becomes an <code>agent:ready</code> issue → an agent builds it →
            you review the PR.
          </p>
        </div>
        {boards.length > 0 ? (
          <div className="ml-auto flex items-center gap-4 text-xs tabular-nums">
            <span className="text-emerald-400">{totals.ready} ready</span>
            <span className="text-amber-400">{totals.building} building</span>
            <span className={totals.prs > 0 ? "rounded-full bg-blue-600 px-2.5 py-1 font-semibold text-white" : "text-zinc-500"}>
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
              <p className="text-sm text-amber-400">
                Set <code>GITHUB_TOKEN</code> in <code>.env.local</code> (repo scope) and restart the server.
              </p>
            )
          ) : (
            <p className="text-sm text-zinc-500">Loading projects…</p>
          )}
        </aside>
        <div className="space-y-10">
          {boardQuery.isLoading ? <p className="text-sm text-zinc-500">Loading board…</p> : null}
          {boardQuery.isError ? (
            <p className="text-sm text-red-400">{(boardQuery.error as Error).message}</p>
          ) : null}
          {activeBoards.map((board) => (
            <ProjectBoard key={board.project.id} board={board} />
          ))}
          {quietBoards.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
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
