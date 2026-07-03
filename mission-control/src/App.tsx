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

function NewTaskForm({ projects }: { projects: Project[] }) {
  const qc = useQueryClient();
  const [project, setProject] = useState(projects[0]?.id ?? "");
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

function TaskCard({ task }: { task: TaskIssue }) {
  return (
    <a
      href={task.url}
      target="_blank"
      rel="noreferrer"
      className="block rounded-md border border-zinc-800 bg-zinc-900 p-2.5 hover:border-zinc-600 transition-colors"
    >
      <p className="text-sm text-zinc-100 leading-snug">{task.title}</p>
      <p className="mt-1 text-[11px] text-zinc-500">
        #{task.number}
        {task.priority ? ` · ${task.priority}` : ""}
        {task.assignee ? ` · ${task.assignee}` : ""}
      </p>
    </a>
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
                <TaskCard key={task.number} task={task} />
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-bold">
          BAI <span className="text-emerald-500">Mission Control</span>
        </h1>
        <p className="text-xs text-zinc-500">
          Write a well-described task → it becomes an <code>agent:ready</code> issue → an agent builds it →
          you review the PR.
        </p>
      </header>
      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-8 p-6 lg:grid-cols-[340px_1fr]">
        <aside>
          {projectsQuery.data ? (
            projectsQuery.data.github ? (
              <NewTaskForm projects={projectsQuery.data.projects} />
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
          {boardQuery.data?.boards.map((board) => (
            <ProjectBoard key={board.project.id} board={board} />
          ))}
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
