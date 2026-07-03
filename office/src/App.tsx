import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { apiWrite, getJson, hasWriteSecret, setWriteSecret } from "./lib/api";

const queryClient = new QueryClient();
const PROVIDER_KEY = "bai-office-agent-provider";
const TAB_KEY = "bai-office-tab";

type OfficeTab = "dashboard" | "projects" | "new-task" | "automation" | "spend" | "settings";

const TAB_META: Record<OfficeTab, { label: string; hint: string }> = {
  dashboard: { label: "Dashboard", hint: "What needs you right now — PRs to approve and tasks ready for agents." },
  projects: { label: "Projects", hint: "Pick a product, review its kanban, and merge PRs to production." },
  "new-task": { label: "Create", hint: "Describe the work — it becomes a GitHub issue for agents to pick up." },
  automation: { label: "Automation", hint: "The self-driving layer — idea cycle, Slack approvals, site monitor, and autonomy." },
  spend: { label: "Spend", hint: "Track agent cost by project, provider, and issue." },
  settings: { label: "Settings", hint: "Configure the agent team, default provider, budgets, and manual run logs." },
};

/* ── types ──────────────────────────────────────────────────── */

interface Project {
  id: string;
  name: string;
  repo: string;
  domain?: string;
  autonomy?: "manual" | "auto-safe" | "full";
}

type TaskStage =
  | "agent:idea"
  | "agent:ready"
  | "agent:analyzing"
  | "agent:implementing"
  | "agent:validating"
  | "agent:review"
  | "agent:blocked"
  | "done";

interface TaskIssue {
  number: number;
  title: string;
  url: string;
  stage: TaskStage;
  priority: string | null;
  updatedAt: string;
  assignee: string | null;
  bodyPreview?: string;
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

type AgentProviderId = "claude-code" | "claude-interactive" | "cursor" | "anthropic-api";

interface AgentProvider {
  id: AgentProviderId;
  name: string;
  shortLabel: string;
  tagline: string;
  tone: string;
  billing: "auto" | "manual" | "subscription";
  billingLabel: string;
  dispatchMode: "office" | "cli" | "ide" | "api";
  dispatchLabel: string;
  costTracking: "auto" | "manual" | "dashboard";
  costNote: string;
  requirements: string[];
  docsUrl?: string;
  available: boolean;
  unavailableReason?: string;
}

interface PipelineAgent {
  id: "analyze" | "implement" | "validate";
  title: string;
  role: string;
  model: string;
  enabled: boolean;
  stageLabel: string;
  docsPath: string;
  order: number;
  defaults: { enabled: boolean; model: string; role: string; title: string };
}

interface SpecialistAgent {
  id: "growth" | "research";
  title: string;
  role: string;
  model: string;
  enabled: boolean;
  docsPath: string;
  description: string;
  order: number;
  defaults: { enabled: boolean; model: string; role: string; title: string };
}

interface AgentsResponse {
  providers: AgentProvider[];
  team: PipelineAgent[];
  specialists: SpecialistAgent[];
  suggestedModels: string[];
  teamUpdatedAt?: string;
  defaultProvider: AgentProviderId;
}

interface SiteStatus {
  projectId: string;
  domain: string;
  ok: boolean;
  httpStatus?: number;
  responseMs?: number;
  error?: string;
  checkedAt: string;
}

interface PendingApproval {
  ts: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
  title: string;
  createdAt: string;
}

interface AutomationResponse {
  autoCycle: {
    enabled: boolean;
    running: boolean;
    intervalMs: number;
    lastRunAt?: string;
    lastProjectId?: string;
    nextRunAt?: string;
    history: Array<{ projectId: string; ranAt: string; promoted?: string }>;
  };
  pendingApprovals: PendingApproval[];
  sites: SiteStatus[];
  projects: Array<{ id: string; name: string; repo: string; domain?: string; autonomy: string }>;
  config: {
    notifications: boolean;
    slackApprovals: boolean;
    siteMonitor: boolean;
    autoPoll: boolean;
    worker: boolean;
  };
  source: "worker" | "local";
}

interface AgentRun {
  id: string;
  provider: AgentProviderId;
  repo: string;
  issueNumber: number;
  title: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  costUsd?: number;
  durationMs?: number;
  source: "dispatch" | "manual";
  pipelineStage?: "analyze" | "implement" | "validate";
  pipelineId?: string;
  specialist?: "growth" | "research";
  notes?: string;
  projectId?: string;
  projectName?: string;
  domain?: string;
}

interface SpendBucket {
  totalUsd: number;
  todayUsd: number;
  monthlyUsd: number;
  runs: number;
}

interface BudgetMeter {
  limit?: number;
  spent: number;
  remaining?: number;
  pct: number;
  exceeded: boolean;
  nearLimit: boolean;
}

interface ProjectBudgetStatus {
  projectId: string;
  name: string;
  repo: string;
  domain?: string;
  limits: { dailyUsd?: number; monthlyUsd?: number; totalUsd?: number };
  spent: { daily: number; monthly: number; total: number };
  meters: { daily: BudgetMeter; monthly: BudgetMeter; total: BudgetMeter };
  anyExceeded: boolean;
  anyNearLimit: boolean;
  hasLimits: boolean;
}

interface ProjectSpendRow extends SpendBucket {
  projectId: string;
  name: string;
  repo: string;
  domain?: string;
  avgCostUsd: number;
}

interface SpendSummary {
  totalUsd: number;
  todayUsd: number;
  runs: number;
  byProvider: Record<AgentProviderId, SpendBucket>;
  byProject: ProjectSpendRow[];
  byIssue: Record<string, SpendBucket>;
  budgets: ProjectBudgetStatus[];
  insights: {
    topProjectToday: ProjectSpendRow | null;
    topProjectAllTime: ProjectSpendRow | null;
    mostExpensiveIssue: { key: string; repo: string; issueNumber: number; domain?: string; totalUsd: number } | null;
  };
}

const INPUT_CLS =
  "w-full rounded-md border border-bai-line bg-bai-surface px-3 py-2 text-sm text-bai-fg placeholder-bai-mute/70 focus:border-bai-orange focus:outline-none";

const usd = (n: number | undefined | null) => `$${(Number(n) || 0).toFixed(2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h2 className="text-lg font-semibold tracking-tight text-bai-fg">{title}</h2>
      {description ? <p className="mt-1 max-w-2xl text-sm text-bai-mute">{description}</p> : null}
    </header>
  );
}

function WorkflowStrip() {
  const steps = [
    { label: "Create task", sub: "GitHub issue" },
    { label: "Analyze", sub: "Sonnet" },
    { label: "Implement", sub: "Opus" },
    { label: "Validate", sub: "Sonnet + PR" },
    { label: "You review", sub: "CI + diff" },
    { label: "Approve", sub: "Ships to prod" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-bai-line/70 bg-bai-surface/25 px-3 py-2.5 text-[11px] text-bai-mute">
      {steps.map((step, i) => (
        <Fragment key={step.label}>
          {i > 0 ? <span className="hidden text-bai-line sm:inline">→</span> : null}
          <span>
            <span className="font-medium text-bai-metal">{step.label}</span>
            <span className="text-bai-mute/80"> · {step.sub}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "warn";
}) {
  const styles =
    tone === "accent"
      ? "border-bai-orange/40 bg-bai-orange/10 text-bai-orange"
      : tone === "warn"
        ? "border-amber-400/30 bg-amber-400/5 text-amber-300"
        : "border-bai-line bg-bai-surface/30 text-bai-fg";
  return (
    <div className={`rounded-md border px-2.5 py-2 ${styles}`}>
      <p className="text-[9px] font-medium uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-bai-line/70 bg-bai-surface/20 px-4 py-8 text-sm text-bai-mute">
      <span className="h-4 w-4 animate-pulse rounded-full bg-bai-orange/40" />
      {label}
    </div>
  );
}


function SystemHealthBar() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () =>
      getJson<{
        github: boolean;
        dispatch: boolean;
        worker: boolean;
        runningAgents: number;
        writeAuthRequired: boolean;
      }>("/api/health"),
    refetchInterval: 30_000,
  });
  const h = health.data;
  if (!h) return null;

  const issues: string[] = [];
  if (!h.github) issues.push("GitHub token missing");
  if (!h.dispatch && !h.worker) issues.push("No agent worker");
  if (h.writeAuthRequired && !hasWriteSecret()) issues.push("Write secret not set (Settings)");

  if (issues.length === 0 && h.runningAgents === 0) return null;

  return (
    <div className="border-b border-bai-line/60 bg-bai-surface/30 px-4 py-1.5 text-[11px] text-bai-mute sm:px-6">
      {issues.length > 0 ? (
        <span className="text-amber-300">{issues.join(" · ")}</span>
      ) : (
        <span>
          <span className="text-bai-orange">{h.runningAgents} agent{h.runningAgents === 1 ? "" : "s"} running</span>
          {h.worker && !h.dispatch ? <span className="text-bai-mute"> · via worker</span> : null}
        </span>
      )}
    </div>
  );
}

function SitesPanel() {
  const query = useQuery({
    queryKey: ["sites"],
    queryFn: () =>
      getJson<{ sites: SiteStatus[]; autoCycle: { enabled: boolean; lastRunAt?: string } | null }>("/api/sites"),
    refetchInterval: 60_000,
  });
  const sites = query.data?.sites ?? [];
  const cycle = query.data?.autoCycle;
  if (sites.length === 0 && !cycle?.enabled) return null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-bai-fg">Production health</h3>
        {cycle?.enabled ? (
          <span className="text-[10px] text-bai-mute">
            Auto-cycle on{cycle.lastRunAt ? ` · last run ${new Date(cycle.lastRunAt).toLocaleDateString()}` : ""}
          </span>
        ) : null}
      </div>
      {sites.length === 0 ? (
        <p className="rounded-md border border-bai-line/60 bg-bai-surface/20 px-3 py-2 text-xs text-bai-mute">
          No site checks yet — the worker probes all project domains every 30 minutes.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
          {sites.map((site) => (
            <a
              key={site.projectId}
              href={`https://${site.domain}`}
              target="_blank"
              rel="noreferrer"
              className={`rounded-md border px-2.5 py-2 text-xs transition-colors ${
                site.ok
                  ? "border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-500/50"
                  : "border-red-500/40 bg-red-500/10 hover:border-red-500/60"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${site.ok ? "bg-emerald-400" : "bg-red-500 animate-pulse"}`} />
                <span className="truncate font-medium text-bai-fg">{site.domain}</span>
              </div>
              <p className="mt-1 text-[10px] tabular-nums text-bai-mute">
                {site.ok ? `${site.httpStatus} · ${site.responseMs}ms` : (site.error ?? `HTTP ${site.httpStatus}`)}
              </p>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function AutonomySettings({ projects }: { projects: Project[] }) {
  const qc = useQueryClient();
  const setAutonomy = useMutation({
    mutationFn: async ({ id, autonomy }: { id: string; autonomy: string }) =>
      apiWrite(`/api/projects/${id}/autonomy`, {
        method: "PUT",
        body: JSON.stringify({ autonomy }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  if (projects.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <p className="text-[11px] leading-relaxed text-bai-mute">
          <span className="text-bai-fg">manual</span> — you approve every PR ·{" "}
          <span className="text-amber-300">auto-safe</span> — green CI + small diff + no sensitive files merges itself ·{" "}
          <span className="text-red-300">full</span> — green CI merges itself. Auto-merged deploys are probed and
          incidents are filed automatically.
        </p>
      </div>
      <div className="space-y-1.5">
        {projects.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-bai-line/70 bg-bai-bg/30 px-2.5 py-2">
            <DomainBadge domain={p.domain} repo={p.repo} size="xs" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-bai-fg">{p.name}</span>
            <div className="flex gap-1">
              {(["manual", "auto-safe", "full"] as const).map((level) => {
                const active = (p.autonomy ?? "manual") === level;
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={setAutonomy.isPending}
                    onClick={() => setAutonomy.mutate({ id: p.id, autonomy: level })}
                    className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                      active
                        ? level === "manual"
                          ? "bg-bai-surface text-bai-fg border border-bai-mute/50"
                          : level === "auto-safe"
                            ? "bg-amber-400/20 text-amber-300 border border-amber-400/40"
                            : "bg-red-400/20 text-red-300 border border-red-400/40"
                        : "border border-bai-line text-bai-mute hover:text-bai-fg"
                    }`}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {setAutonomy.isError ? <p className="text-xs text-red-400">{(setAutonomy.error as Error).message}</p> : null}
    </section>
  );
}

/* ── automation view ─────────────────────────────────────────── */

function timeAgo(iso?: string): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function AutomationStatusPill({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${
        on ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-bai-line bg-bai-surface/40 text-bai-mute"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-bai-mute/60"}`} />
      {on ? onLabel : offLabel}
    </span>
  );
}

function PendingApprovalsPanel({ approvals }: { approvals: PendingApproval[] }) {
  const qc = useQueryClient();
  const merge = useMutation({
    mutationFn: async (a: PendingApproval) =>
      apiWrite("/api/prs/merge", { method: "POST", body: JSON.stringify({ repo: a.repo, number: a.prNumber }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automation"] });
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });

  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold text-bai-fg">Waiting for your ✅</h3>
      {approvals.length === 0 ? (
        <p className="rounded-md border border-bai-line/60 bg-bai-surface/20 px-3 py-2 text-xs text-bai-mute">
          Nothing pending. Finished pipelines on manual projects show up here and in Slack — react ✅ there, or approve
          here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {approvals.map((a) => (
            <div
              key={`${a.repo}-${a.prNumber}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-bai-orange/40 bg-bai-orange/5 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-bai-fg">{a.title}</p>
                <p className="text-[10px] text-bai-mute">
                  {a.repo} · PR #{a.prNumber} · asked {timeAgo(a.createdAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={merge.isPending}
                onClick={() => {
                  if (!window.confirm(`Merge PR #${a.prNumber} in ${a.repo} to main?`)) return;
                  merge.mutate(a);
                }}
                className="rounded-md bg-bai-orange px-3 py-1 text-[11px] font-semibold text-bai-bg hover:bg-bai-orange-deep disabled:opacity-40"
              >
                {merge.isPending ? "Merging…" : "✓ Approve → prod"}
              </button>
            </div>
          ))}
          {merge.isError ? <p className="text-xs text-red-400">{(merge.error as Error).message}</p> : null}
        </div>
      )}
    </section>
  );
}

function AutoCyclePanel({ data }: { data: AutomationResponse }) {
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const cycle = data.autoCycle;
  const projectName = (id?: string) => data.projects.find((p) => p.id === id)?.name ?? id ?? "—";

  const run = useMutation({
    mutationFn: async (project: string) =>
      apiWrite<{ message: string }>("/api/cycle/run", { method: "POST", body: JSON.stringify({ project }) }),
    onSuccess: (res) => setMessage(res.message),
  });

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-bai-fg">Idea cycle</h3>
        <AutomationStatusPill
          on={cycle.enabled}
          onLabel={cycle.running ? "running now" : "scheduled"}
          offLabel="off — set AUTO_CYCLE_ENABLED=true on the worker"
        />
      </div>
      <p className="text-[11px] leading-relaxed text-bai-mute">
        Growth agent generates ideas → prioritizer promotes the best one to the build queue → pipeline builds it. Last
        run {timeAgo(cycle.lastRunAt)}
        {cycle.lastProjectId ? ` (${projectName(cycle.lastProjectId)})` : ""}
        {cycle.nextRunAt ? ` · next ${new Date(cycle.nextRunAt).toLocaleString()}` : ""}.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-md border border-bai-line bg-bai-bg px-2 py-1.5 text-xs text-bai-fg"
        >
          <option value="">Pick a project…</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selected || run.isPending}
          onClick={() => run.mutate(selected)}
          className="rounded-md border border-bai-orange/50 px-3 py-1.5 text-[11px] font-semibold text-bai-orange hover:bg-bai-orange/10 disabled:opacity-40"
        >
          {run.isPending ? "Starting…" : "Run cycle now"}
        </button>
        {message ? <span className="text-[11px] text-emerald-400">{message}</span> : null}
        {run.isError ? <span className="text-[11px] text-red-400">{(run.error as Error).message}</span> : null}
      </div>

      {cycle.history.length > 0 ? (
        <div className="space-y-1 pt-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Recent cycles</p>
          {cycle.history.slice(0, 6).map((h) => (
            <div
              key={`${h.projectId}-${h.ranAt}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-bai-line/60 bg-bai-surface/20 px-2.5 py-1.5 text-[11px]"
            >
              <span className="font-medium text-bai-fg">{projectName(h.projectId)}</span>
              <span className="text-bai-mute">{timeAgo(h.ranAt)}</span>
              <span className={h.promoted ? "text-emerald-400" : "text-bai-mute/70"}>
                {h.promoted ?? "no idea promoted"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AutomationView({ projects }: { projects: Project[] }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["automation"],
    queryFn: () => getJson<AutomationResponse>("/api/automation"),
    refetchInterval: 30_000,
  });
  const checkSites = useMutation({
    mutationFn: async () => apiWrite("/api/sites/check", { method: "POST", body: "{}" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automation"] });
      void qc.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  if (query.isLoading) return <LoadingBlock label="Loading automation state…" />;
  if (query.isError) {
    return (
      <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        {(query.error as Error).message}
      </p>
    );
  }
  const data = query.data!;
  const cfg = data.config;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        <AutomationStatusPill on={cfg.autoPoll || cfg.worker} onLabel="Agent pipeline on" offLabel="Agent pipeline off" />
        <AutomationStatusPill on={cfg.notifications} onLabel="Slack notiser on" offLabel="Slack notiser off" />
        <AutomationStatusPill
          on={cfg.slackApprovals}
          onLabel="✅-to-merge on"
          offLabel="✅-to-merge off — set SLACK_BOT_TOKEN + SLACK_CHANNEL_ID"
        />
        <AutomationStatusPill on={cfg.siteMonitor} onLabel="Site monitor on" offLabel="Site monitor off" />
        {data.source === "worker" ? (
          <span className="inline-flex items-center rounded-full border border-bai-line bg-bai-surface/40 px-2 py-0.5 text-[10px] text-bai-mute">
            live from worker
          </span>
        ) : null}
      </div>

      <PendingApprovalsPanel approvals={data.pendingApprovals} />

      <AutoCyclePanel data={data} />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-bai-fg">Production health</h3>
          <button
            type="button"
            disabled={checkSites.isPending}
            onClick={() => checkSites.mutate()}
            className="rounded-md border border-bai-line px-2.5 py-1 text-[11px] text-bai-mute hover:text-bai-fg disabled:opacity-40"
          >
            {checkSites.isPending ? "Checking…" : "Check all now"}
          </button>
        </div>
        {data.sites.length === 0 ? (
          <p className="rounded-md border border-bai-line/60 bg-bai-surface/20 px-3 py-2 text-xs text-bai-mute">
            No site checks yet — the worker probes all project domains every 30 minutes.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
            {data.sites.map((site) => (
              <a
                key={site.projectId}
                href={`https://${site.domain}`}
                target="_blank"
                rel="noreferrer"
                className={`rounded-md border px-2.5 py-2 text-xs transition-colors ${
                  site.ok
                    ? "border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-500/50"
                    : "border-red-500/40 bg-red-500/10 hover:border-red-500/60"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${site.ok ? "bg-emerald-400" : "bg-red-500 animate-pulse"}`} />
                  <span className="truncate font-medium text-bai-fg">{site.domain}</span>
                </div>
                <p className="mt-1 text-[10px] tabular-nums text-bai-mute">
                  {site.ok ? `${site.httpStatus} · ${site.responseMs}ms` : (site.error ?? `HTTP ${site.httpStatus}`)}
                </p>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold text-bai-fg">Autonomy per project</h3>
        <AutonomySettings projects={projects} />
      </section>
    </div>
  );
}

function WriteSecretSettings() {
  const [secret, setSecret] = useState(() => localStorage.getItem("bai-office-write-secret") ?? "");
  const [saved, setSaved] = useState(false);

  return (
    <section className="rounded-lg border border-bai-line bg-bai-surface/30 p-4 space-y-2">
      <h4 className="text-xs font-semibold text-bai-fg">Write access</h4>
      <p className="text-[11px] text-bai-mute">
        Production requires <code className="text-bai-metal">OFFICE_SECRET</code> as Bearer token on writes. Paste it here once per browser.
      </p>
      <input
        className={INPUT_CLS}
        type="password"
        value={secret}
        onChange={(e) => {
          setSecret(e.target.value);
          setSaved(false);
        }}
        placeholder="Same as OFFICE_SECRET on Vercel"
      />
      <button
        type="button"
        onClick={() => {
          setWriteSecret(secret);
          setSaved(true);
        }}
        className="rounded-md border border-bai-line px-3 py-1.5 text-xs text-bai-fg hover:border-bai-orange"
      >
        Save secret
      </button>
      {saved ? <p className="text-xs text-emerald-400">Saved — writes will include Authorization header.</p> : null}
    </section>
  );
}

function providerDot(tone: string): string {
  if (tone.includes("orange")) return "bg-bai-orange";
  if (tone.includes("sky")) return "bg-sky-400";
  if (tone.includes("amber")) return "bg-amber-400";
  if (tone.includes("rose")) return "bg-rose-400";
  return "bg-bai-mute";
}

function issueSpendKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/** Domain badge — the product this task/agent spend belongs to. */
function DomainBadge({ domain, repo, size = "sm" }: { domain?: string; repo?: string; size?: "sm" | "xs" }) {
  const cls = size === "xs" ? "text-[10px] px-1.5 py-0" : "text-[11px] px-2 py-0.5";
  if (domain) {
    return (
      <a
        href={`https://${domain}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={`inline-flex items-center gap-1 rounded-full border border-bai-orange/30 bg-bai-orange/10 font-medium text-bai-orange hover:bg-bai-orange/20 ${cls}`}
        title={`Deploy target: ${domain}`}
      >
        <span className="opacity-70">→</span> {domain}
      </a>
    );
  }
  return (
    <span
      className={`inline-flex rounded-full border border-bai-line bg-bai-surface/60 text-bai-mute ${cls}`}
      title={repo ? `No prod domain — ${repo}` : "Internal — no public domain"}
    >
      internal{repo ? ` · ${repo.split("/")[1]}` : ""}
    </span>
  );
}

function SpendPill({
  amount,
  label,
  tone = "orange",
}: {
  amount: number;
  label?: string;
  tone?: "orange" | "mute" | "warn";
}) {
  if (amount <= 0 && !label) return null;
  const colors =
    tone === "warn"
      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
      : tone === "mute"
        ? "border-bai-line bg-bai-surface/50 text-bai-mute"
        : "border-bai-orange/30 bg-bai-orange/10 text-bai-orange";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] tabular-nums font-medium ${colors}`}>
      {amount > 0 ? usd(amount) : "$0"}
      {label ? <span className="font-normal opacity-80">{label}</span> : null}
    </span>
  );
}

function projectSpend(spend: SpendSummary | undefined, projectId: string): ProjectSpendRow | undefined {
  return spend?.byProject.find((p) => p.projectId === projectId);
}

function projectBudget(spend: SpendSummary | undefined, projectId: string): ProjectBudgetStatus | undefined {
  return spend?.budgets.find((b) => b.projectId === projectId);
}

/** Progress bar toward a spend limit (daily / monthly / total). */
function BudgetMeterBar({
  label,
  meter,
  compact,
}: {
  label: string;
  meter: BudgetMeter;
  compact?: boolean;
}) {
  if (!meter.limit) {
    if (compact) return null;
    return (
      <div className="text-[10px] text-bai-mute/50">
        {label}: no limit · {usd(meter.spent)} spent
      </div>
    );
  }
  const barColor = meter.exceeded ? "bg-red-500" : meter.nearLimit ? "bg-amber-400" : "bg-bai-orange";
  const width = Math.min(100, Math.max(meter.spent > 0 ? 4 : 0, meter.pct));
  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="text-bai-mute">{label}</span>
        <span className={`tabular-nums ${meter.exceeded ? "text-red-400 font-medium" : meter.nearLimit ? "text-amber-300" : "text-bai-fg"}`}>
          {usd(meter.spent)} / {usd(meter.limit)}
          {meter.exceeded ? " · over" : meter.remaining != null ? ` · ${usd(meter.remaining)} left` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bai-line">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function ProjectBudgetCard({ budget, compact }: { budget: ProjectBudgetStatus; compact?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        budget.anyExceeded
          ? "border-red-500/50 bg-red-500/5"
          : budget.anyNearLimit
            ? "border-amber-400/40 bg-amber-400/5"
            : "border-bai-line/80 bg-bai-bg/40"
      }`}
    >
      {!compact ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {budget.anyExceeded ? (
            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-400">Budget exceeded</span>
          ) : budget.anyNearLimit ? (
            <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">Near limit</span>
          ) : budget.hasLimits ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">Within budget</span>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        <BudgetMeterBar label="Today" meter={budget.meters.daily} compact={compact} />
        <BudgetMeterBar label="This month" meter={budget.meters.monthly} compact={compact} />
        <BudgetMeterBar label="All time" meter={budget.meters.total} compact={compact} />
      </div>
    </div>
  );
}

function ProjectBudgetsEditor({
  budgets,
  defaultOpen = false,
  embedded = false,
}: {
  budgets: ProjectBudgetStatus[];
  defaultOpen?: boolean;
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(embedded || defaultOpen);
  const [drafts, setDrafts] = useState<Record<string, { daily: string; monthly: string; total: string }>>({});

  const getDraft = (b: ProjectBudgetStatus) =>
    drafts[b.projectId] ?? {
      daily: b.limits.dailyUsd != null ? String(b.limits.dailyUsd) : "",
      monthly: b.limits.monthlyUsd != null ? String(b.limits.monthlyUsd) : "",
      total: b.limits.totalUsd != null ? String(b.limits.totalUsd) : "",
    };

  const save = useMutation({
    mutationFn: async (projectId: string) => {
      const d = drafts[projectId] ?? getDraft(budgets.find((b) => b.projectId === projectId)!);
      return apiWrite("/api/budgets", {
        method: "PUT",
        body: JSON.stringify({
          project: projectId,
          dailyUsd: d.daily.trim() ? Number(d.daily) : null,
          monthlyUsd: d.monthly.trim() ? Number(d.monthly) : null,
          totalUsd: d.total.trim() ? Number(d.total) : null,
        }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
    },
  });

  if (budgets.length === 0) return null;

  const editor = (
    <div className={`space-y-2 ${embedded ? "" : "mt-2 max-h-72 overflow-y-auto scroll-hidden rounded-lg border border-bai-line bg-bai-surface/20 p-2"}`}>
      {!embedded ? (
        <p className="px-1 text-[11px] leading-relaxed text-bai-mute">
          Set USD caps per project. Auto-dispatch blocks when any limit is hit. Leave blank for no cap.
        </p>
      ) : null}
      {budgets.map((b) => {
            const d = getDraft(b);
            return (
              <div key={b.projectId} className="rounded-lg border border-bai-line/70 bg-bai-bg/30 p-2.5 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <DomainBadge domain={b.domain} repo={b.repo} size="xs" />
                  <span className="text-xs font-medium text-bai-fg">{b.name}</span>
                  {b.anyExceeded ? <span className="text-[10px] text-red-400">over limit</span> : null}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["daily", "monthly", "total"] as const).map((key) => (
                    <input
                      key={key}
                      className="rounded border border-bai-line bg-bai-surface px-2 py-1 text-[11px] text-bai-fg placeholder-bai-mute/50"
                      placeholder={key === "daily" ? "Day $" : key === "monthly" ? "Month $" : "Total $"}
                      value={d[key]}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [b.projectId]: { ...getDraft(b), [key]: e.target.value },
                        }))
                      }
                    />
                  ))}
                </div>
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => save.mutate(b.projectId)}
                  className="w-full rounded border border-bai-line py-1 text-[11px] text-bai-mute hover:border-bai-orange hover:text-bai-orange"
                >
                  Save limits
                </button>
              </div>
            );
          })}
          {save.isError ? <p className="text-xs text-red-400">{(save.error as Error).message}</p> : null}
    </div>
  );

  if (embedded) return <section id="project-budgets">{editor}</section>;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-bai-line bg-bai-surface/40 px-3 py-2 text-left text-sm hover:border-bai-mute/50"
      >
        <span className="font-medium text-bai-fg/90">Project budgets</span>
        <span className="text-xs text-bai-mute">{open ? "−" : "+"}</span>
      </button>
      {open ? editor : null}
    </section>
  );
}

function claudeHeadlessCommand(repo: string, issueNumber: number): string {
  return `claude -p "Execute GitHub issue #${issueNumber} in ${repo} using the BAI three-agent team: (1) analyze — explore repo, post analysis comment, (2) implement — feat/ branch and push, (3) validate — verify green, open PR with Closes #${issueNumber}, label agent:review. Follow AGENTS.md + ai/. Never push to main or merge." --permission-mode acceptEdits --allowedTools "Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Edit,Write,Read,Glob,Grep"`;
}

function claudeInteractiveCommand(repo: string, issueNumber: number): string {
  const prompt = [
    `Execute GitHub issue #${issueNumber} in ${repo} via BAI agent team:`,
    `analyze (plan comment) → implement (feat/ branch) → validate (verify + PR, Closes #${issueNumber}, agent:review).`,
    `Never push to main.`,
  ].join(" ");
  return `claude "${prompt.replace(/"/g, '\\"')}" --permission-mode acceptEdits`;
}

function cursorPrompt(repo: string, issueNumber: number): string {
  return [
    `Execute GitHub issue #${issueNumber} in ${repo} using the BAI three-agent team workflow in the issue body.`,
    `Analyze → implement on feat/<slug> → validate (verify green, PR with Closes #${issueNumber}, agent:review).`,
    `Never push to main or merge.`,
  ].join("\n");
}

const PIPELINE_ACTIVE: TaskStage[] = ["agent:analyzing", "agent:implementing", "agent:validating"];

function pipelineTaskCount(board: Board): number {
  return board.tasks.filter((t) => PIPELINE_ACTIVE.includes(t.stage)).length;
}

function copyText(text: string, setCopied: (v: boolean) => void): void {
  void navigator.clipboard.writeText(text);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
}

/* ── agent config (pipeline + specialists) ─────────────────── */

const TEAM_TONE: Record<PipelineAgent["id"], string> = {
  analyze: "text-sky-400",
  implement: "text-amber-400",
  validate: "text-violet-400",
};

const SPECIALIST_TONE: Record<SpecialistAgent["id"], string> = {
  growth: "text-emerald-400",
  research: "text-cyan-400",
};

type AgentSettingsDraft = {
  enabled: boolean;
  model: string;
  role: string;
  title: string;
};

type PipelineDraft = Partial<Record<PipelineAgent["id"], AgentSettingsDraft>>;
type SpecialistDraft = Partial<Record<SpecialistAgent["id"], AgentSettingsDraft>>;

function AgentSettingsCard({
  title,
  tone,
  badge,
  description,
  draft,
  defaults,
  onPatch,
  onReset,
  resetPending,
}: {
  title: string;
  tone: string;
  badge?: string;
  description?: string;
  draft: AgentSettingsDraft;
  defaults: AgentSettingsDraft;
  onPatch: (patch: Partial<AgentSettingsDraft>) => void;
  onReset: () => void;
  resetPending: boolean;
}) {
  return (
    <article className="rounded-lg border border-bai-line bg-bai-surface/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-semibold ${tone}`}>{title}</span>
            {badge ? (
              <span className="rounded-full bg-bai-bg px-2 py-0.5 text-[10px] text-bai-mute">{badge}</span>
            ) : null}
            {!draft.enabled ? (
              <span className="rounded-full bg-bai-line/80 px-2 py-0.5 text-[10px] text-bai-mute">disabled</span>
            ) : null}
          </div>
          {description ? <p className="mt-1 text-[11px] text-bai-mute">{description}</p> : null}
          <p className="mt-1 text-[11px] text-bai-mute/90">{draft.role}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-bai-mute">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
            className="rounded border-bai-line"
          />
          Enabled
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Display name</span>
          <input className={INPUT_CLS} value={draft.title} onChange={(e) => onPatch({ title: e.target.value })} />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Model</span>
          <input
            className={INPUT_CLS}
            value={draft.model}
            list="agent-model-suggestions"
            onChange={(e) => onPatch({ model: e.target.value })}
          />
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Persona / role</span>
          <input className={INPUT_CLS} value={draft.role} onChange={(e) => onPatch({ role: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-bai-mute/80">
        <span>Default model: {defaults.model}</span>
        <button
          type="button"
          disabled={resetPending}
          onClick={onReset}
          className="text-bai-orange hover:underline disabled:opacity-50"
        >
          Reset to defaults
        </button>
      </div>
    </article>
  );
}

function AgentConfigEditor() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["agents"],
    queryFn: () => getJson<AgentsResponse>("/api/agents"),
  });
  const team = query.data?.team;
  const specialists = query.data?.specialists;
  const suggestedModels = query.data?.suggestedModels ?? [];

  const [pipelineDraft, setPipelineDraft] = useState<PipelineDraft>({});
  const [specialistDraft, setSpecialistDraft] = useState<SpecialistDraft>({});

  useEffect(() => {
    if (!team?.length) return;
    setPipelineDraft(
      Object.fromEntries(
        team.map((a) => [a.id, { enabled: a.enabled, model: a.model, role: a.role, title: a.title }])
      ) as PipelineDraft
    );
  }, [team]);

  useEffect(() => {
    if (!specialists?.length) return;
    setSpecialistDraft(
      Object.fromEntries(
        specialists.map((a) => [a.id, { enabled: a.enabled, model: a.model, role: a.role, title: a.title }])
      ) as SpecialistDraft
    );
  }, [specialists]);

  const teamList = team ?? [];
  const specialistList = specialists ?? [];

  const settingsDirty = (saved: { id: string; enabled: boolean; model: string; role: string; title: string }[], draft: Record<string, AgentSettingsDraft | undefined>) =>
    saved.some((agent) => {
      const d = draft[agent.id];
      if (!d) return false;
      return d.enabled !== agent.enabled || d.model !== agent.model || d.role !== agent.role || d.title !== agent.title;
    });

  const dirty = settingsDirty(teamList, pipelineDraft) || settingsDirty(specialistList, specialistDraft);

  const save = useMutation({
    mutationFn: async () =>
      apiWrite("/api/agent-team", {
        method: "PUT",
        body: JSON.stringify({ stages: pipelineDraft, specialists: specialistDraft }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  const resetAgent = useMutation({
    mutationFn: async (id: string) => apiWrite(`/api/agent-team/${id}/reset`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  if (query.isLoading) {
    return <p className="text-sm text-bai-mute">Loading agents…</p>;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {query.data?.teamUpdatedAt ? (
            <p className="text-[10px] text-bai-mute/60">
              Last saved {new Date(query.data.teamUpdatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          className="rounded-md border border-bai-orange bg-bai-orange/15 px-3 py-1.5 text-xs font-semibold text-bai-orange hover:bg-bai-orange/25 disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : "Save all agent settings"}
        </button>
      </div>

      {save.isError ? <p className="text-xs text-red-400">{(save.error as Error).message}</p> : null}
      {save.isSuccess ? <p className="text-xs text-emerald-400">Agent settings saved.</p> : null}

      <section className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-bai-mute">Build pipeline</h4>
        <p className="text-[11px] text-bai-mute/80">Runs in order on every agent:ready task. Disabled steps are skipped.</p>
        {teamList.map((agent) => {
          const d = pipelineDraft[agent.id];
          if (!d) return null;
          return (
            <AgentSettingsCard
              key={agent.id}
              title={agent.title}
              tone={TEAM_TONE[agent.id]}
              badge={agent.stageLabel}
              draft={d}
              defaults={agent.defaults}
              onPatch={(patch) =>
                setPipelineDraft((prev) => ({
                  ...prev,
                  [agent.id]: { ...d, ...patch },
                }))
              }
              onReset={() => resetAgent.mutate(agent.id)}
              resetPending={resetAgent.isPending}
            />
          );
        })}
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-bai-mute">Specialist agents</h4>
        <p className="text-[11px] text-bai-mute/80">On-demand — growth ideas and research scans create agent:idea issues.</p>
        {specialistList.map((agent) => {
          const d = specialistDraft[agent.id];
          if (!d) return null;
          return (
            <AgentSettingsCard
              key={agent.id}
              title={agent.title}
              tone={SPECIALIST_TONE[agent.id]}
              description={agent.description}
              draft={d}
              defaults={agent.defaults}
              onPatch={(patch) =>
                setSpecialistDraft((prev) => ({
                  ...prev,
                  [agent.id]: { ...d, ...patch },
                }))
              }
              onReset={() => resetAgent.mutate(agent.id)}
              resetPending={resetAgent.isPending}
            />
          );
        })}
      </section>

      <datalist id="agent-model-suggestions">
        {suggestedModels.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}

function SpecialistRunPanel({ projects }: { projects: Project[] }) {
  const qc = useQueryClient();
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [focus, setFocus] = useState("");
  const [ideaCount, setIdeaCount] = useState("5");
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const runStatus = useQuery({
    queryKey: ["dispatches"],
    queryFn: () => getJson<{ dispatches: AgentRun[]; spend: SpendSummary }>("/api/dispatches"),
    refetchInterval: lastRunId ? 5000 : false,
    enabled: Boolean(lastRunId),
  });

  const activeSpecialistRun = lastRunId
    ? runStatus.data?.dispatches.find((d) => d.id === lastRunId)
    : undefined;

  const runSpecialist = useMutation({
    mutationFn: async (id: "growth" | "research") =>
      apiWrite<{ message?: string; run?: AgentRun }>(`/api/specialists/${id}/run`, {
        method: "POST",
        body: JSON.stringify({
          project,
          focus: focus.trim(),
          ideaCount: id === "growth" ? Number(ideaCount) || 5 : undefined,
        }),
      }),
    onSuccess: (data) => {
      if (data.run?.id) setLastRunId(data.run.id);
      void qc.invalidateQueries({ queryKey: ["board"] });
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
    },
  });

  if (projects.length === 0) return null;

  return (
    <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-bai-fg">Growth & research</h3>
        <p className="mt-1 text-xs text-bai-mute">
          Specialist agents create <span className="text-lime-300">agent:idea</span> issues — review in Ideas, then promote to a build task.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Project</span>
          <select className={INPUT_CLS} value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Focus (optional)</span>
          <input
            className={INPUT_CLS}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="e.g. retention, SEO, monetization, automation"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Ideas to generate</span>
          <input
            className={INPUT_CLS}
            type="number"
            min={1}
            max={8}
            value={ideaCount}
            onChange={(e) => setIdeaCount(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={runSpecialist.isPending || !project}
          onClick={() => runSpecialist.mutate("growth")}
          className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {runSpecialist.isPending ? "Running…" : "✦ Generate growth ideas"}
        </button>
        <button
          type="button"
          disabled={runSpecialist.isPending || !project}
          onClick={() => runSpecialist.mutate("research")}
          className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {runSpecialist.isPending ? "Running…" : "◎ Run research scan"}
        </button>
      </div>
      {runSpecialist.isError ? <p className="text-xs text-red-400">{(runSpecialist.error as Error).message}</p> : null}
      {activeSpecialistRun?.status === "running" ? (
        <p className="text-xs text-bai-orange animate-pulse">
          Specialist running ({activeSpecialistRun.specialist ?? "agent"}) — ideas will appear in the Ideas column.
        </p>
      ) : activeSpecialistRun?.status === "done" ? (
        <p className="text-xs text-emerald-400">Specialist finished — check the Ideas column on the project board.</p>
      ) : runSpecialist.isSuccess ? (
        <p className="text-xs text-emerald-400">
          Agent started — check the Ideas column on the project board in a few minutes.
        </p>
      ) : null}
    </section>
  );
}

/* ── agent fleet ─────────────────────────────────────────────── */

function AgentFleetPanel({
  selected,
  onSelect,
  showHeader = true,
}: {
  selected: AgentProviderId;
  onSelect: (id: AgentProviderId) => void;
  showHeader?: boolean;
}) {
  const query = useQuery({
    queryKey: ["agents"],
    queryFn: () => getJson<AgentsResponse>("/api/agents"),
  });
  const providers = query.data?.providers ?? [];

  return (
    <section className="space-y-2">
      {showHeader ? (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Agent fleet</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-bai-mute/80">
            Claude Code runs a three-agent team (analyze → implement → validate). Log other runs for cost tracking.
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        {providers.map((p) => {
          const active = selected === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-bai-orange/60 bg-bai-orange/10"
                  : "border-bai-line bg-bai-surface/50 hover:border-bai-mute/50"
              }`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${providerDot(p.tone)}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-medium ${active ? "text-bai-fg" : "text-bai-fg/90"}`}>{p.shortLabel}</span>
                    <span className="rounded-full bg-bai-bg px-2 py-0.5 text-[10px] text-bai-mute">{p.billingLabel}</span>
                    {!p.available ? (
                      <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400">unavailable</span>
                    ) : p.dispatchMode === "office" ? (
                      <span className="rounded-full bg-bai-orange/20 px-2 py-0.5 text-[10px] text-bai-orange">auto</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-bai-mute">{p.tagline}</p>
                  <p className="mt-1.5 text-[10px] text-bai-mute/70">{p.dispatchLabel}</p>
                  {p.unavailableReason ? (
                    <p className="mt-1 text-[10px] text-red-400/90">{p.unavailableReason}</p>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ── log manual run ──────────────────────────────────────────── */

function LogRunForm({
  projects,
  prefill,
  onLogged,
  defaultOpen = false,
  embedded = false,
}: {
  projects: Project[];
  prefill?: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId } | null;
  onLogged?: () => void;
  defaultOpen?: boolean;
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(embedded || defaultOpen || Boolean(prefill));
  const [project, setProject] = useState(prefill?.projectId ?? projects[0]?.id ?? "");
  const [issueNumber, setIssueNumber] = useState(prefill?.issueNumber ? String(prefill.issueNumber) : "");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [provider, setProvider] = useState<AgentProviderId>(prefill?.provider ?? "cursor");
  const [costUsd, setCostUsd] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!prefill) return;
    setOpen(true);
    setProject(prefill.projectId);
    setIssueNumber(String(prefill.issueNumber));
    setTitle(prefill.title);
    setProvider(prefill.provider);
  }, [prefill]);

  const log = useMutation({
    mutationFn: async () =>
      apiWrite("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          project,
          issueNumber: Number(issueNumber),
          title,
          provider,
          costUsd: costUsd.trim() ? Number(costUsd) : undefined,
          durationMs: durationMin.trim() ? Number(durationMin) * 60_000 : undefined,
          notes,
        }),
      }),
    onSuccess: () => {
      setCostUsd("");
      setDurationMin("");
      setNotes("");
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
      onLogged?.();
    },
  });

  if (projects.length === 0) return null;

  const form = (
    <form
      id="log-run-form"
      className={`space-y-3 rounded-lg border border-bai-line bg-bai-surface/30 p-4 ${embedded ? "" : "mt-2"}`}
      onSubmit={(e) => {
        e.preventDefault();
        log.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-bai-mute">
          Agent
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProviderId)} className={INPUT_CLS}>
            <option value="cursor">Cursor</option>
            <option value="claude-interactive">Claude terminal</option>
            <option value="anthropic-api">Anthropic API</option>
            <option value="claude-code">Claude Code headless</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-bai-mute">
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)} className={INPUT_CLS}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-bai-mute">
          Issue #
          <input
            className={INPUT_CLS}
            placeholder="e.g. 42"
            value={issueNumber}
            onChange={(e) => setIssueNumber(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-bai-mute">
          Title
          <input className={INPUT_CLS} placeholder="What the agent did" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-bai-mute">
          Cost (USD)
          <input
            className={INPUT_CLS}
            placeholder="Optional"
            value={costUsd}
            onChange={(e) => setCostUsd(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-bai-mute">
          Duration (minutes)
          <input
            className={INPUT_CLS}
            placeholder="Optional"
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-bai-mute">
        Notes
        <input className={INPUT_CLS} placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button
        type="submit"
        disabled={log.isPending || !title.trim() || !issueNumber.trim()}
        className="w-full rounded-md bg-bai-surface border border-bai-line px-3 py-2 text-sm text-bai-fg hover:border-bai-orange disabled:opacity-50"
      >
        {log.isPending ? "Saving…" : "Save run"}
      </button>
      {log.isError ? <p className="text-xs text-red-400">{(log.error as Error).message}</p> : null}
      {log.isSuccess ? <p className="text-xs text-emerald-400">Run logged — spend updated.</p> : null}
    </form>
  );

  if (embedded) return <section>{form}</section>;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-bai-line bg-bai-surface/40 px-3 py-2 text-left text-sm text-bai-mute hover:border-bai-mute/50"
      >
        <span className="font-medium text-bai-fg/90">Log agent run & cost</span>
        <span className="text-xs">{open ? "−" : "+"}</span>
      </button>
      {open ? form : null}
    </section>
  );
}

/* ── spend dashboard ─────────────────────────────────────────── */

function SpendDashboard({ providers }: { providers: AgentProvider[] }) {
  const query = useQuery({
    queryKey: ["dispatches"],
    queryFn: () => getJson<{ dispatches: AgentRun[]; spend: SpendSummary }>("/api/dispatches"),
    refetchInterval: 10_000,
  });
  const spend = query.data?.spend;
  const dispatches = query.data?.dispatches ?? [];
  const providerMap = Object.fromEntries(providers.map((p) => [p.id, p])) as Record<AgentProviderId, AgentProvider>;

  if (!spend?.runs && dispatches.length === 0) {
    return (
      <section className="mx-auto max-w-4xl rounded-xl border border-bai-line/80 bg-bai-surface/20 px-6 py-12 text-center">
        <h2 className="text-base font-semibold text-bai-fg">No agent spend yet</h2>
        <p className="mt-2 text-sm text-bai-mute">
          Runs from auto-dispatch or manual logging will appear here with per-project breakdown.
        </p>
      </section>
    );
  }

  const dot: Record<AgentRun["status"], string> = {
    running: "bg-bai-orange animate-pulse",
    done: "bg-emerald-500",
    failed: "bg-red-500",
  };

  const maxProjectSpend = Math.max(...(spend?.byProject.map((p) => p.totalUsd) ?? [1]), 1);
  const allProjects = spend?.budgets ?? [];

  return (
    <section className="mx-auto max-w-6xl space-y-5">
      {spend ? (
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm tabular-nums">
          <span className="rounded-full border border-bai-orange/30 bg-bai-orange/10 px-3 py-1 text-bai-orange">
            {usd(spend.todayUsd)} today
          </span>
          <span className="rounded-full border border-bai-line px-3 py-1 text-bai-mute">
            {usd(spend.totalUsd)} total · {spend.runs} runs
          </span>
        </div>
      ) : null}

      {spend?.insights?.topProjectToday || spend?.insights?.mostExpensiveIssue ? (
        <div className="flex flex-wrap gap-2">
          {spend?.insights?.topProjectToday ? (
            <div className="rounded-lg border border-bai-orange/30 bg-bai-orange/5 px-3 py-2 text-xs">
              <span className="text-bai-mute">Hottest domain today · </span>
              <span className="font-medium text-bai-fg">
                {spend.insights.topProjectToday.domain ?? spend.insights.topProjectToday.name}
              </span>
              <span className="ml-2 tabular-nums text-bai-orange">{usd(spend.insights.topProjectToday.todayUsd)}</span>
            </div>
          ) : null}
          {spend?.insights?.mostExpensiveIssue ? (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs">
              <span className="text-bai-mute">Most invested issue · </span>
              <span className="font-medium text-bai-fg">#{spend.insights.mostExpensiveIssue.issueNumber}</span>
              {spend.insights.mostExpensiveIssue.domain ? (
                <span className="ml-1 text-bai-mute">on {spend.insights.mostExpensiveIssue.domain}</span>
              ) : null}
              <span className="ml-2 tabular-nums text-amber-300">
                {usd(spend.insights.mostExpensiveIssue.totalUsd)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {allProjects.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-bai-mute">All projects</h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {allProjects.map((b) => {
              const pSpend = spend?.byProject.find((p) => p.projectId === b.projectId);
              return (
                <div
                  key={b.projectId}
                  className={`rounded-lg border p-3 ${
                    b.anyExceeded
                      ? "border-red-500/40 bg-red-500/5"
                      : b.hasLimits || (pSpend && pSpend.totalUsd > 0)
                        ? "border-bai-line/80 bg-bai-surface/30"
                        : "border-bai-line/40 bg-bai-surface/10 opacity-80"
                  }`}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <DomainBadge domain={b.domain} repo={b.repo} size="xs" />
                    <span className="text-sm font-semibold text-bai-fg">{b.name}</span>
                    {pSpend && pSpend.totalUsd > 0 ? (
                      <span className="ml-auto text-sm tabular-nums font-medium text-bai-orange">{usd(pSpend.totalUsd)}</span>
                    ) : (
                      <span className="ml-auto text-[10px] text-bai-mute/60">$0 spent</span>
                    )}
                  </div>
                  {pSpend && pSpend.runs > 0 ? (
                    <p className="mb-2 text-[10px] tabular-nums text-bai-mute">
                      {usd(pSpend.todayUsd)} today · {usd(pSpend.monthlyUsd)} this month · {pSpend.runs} runs
                      {pSpend.avgCostUsd > 0 ? ` · avg ${usd(pSpend.avgCostUsd)}` : ""}
                    </p>
                  ) : null}
                  {b.hasLimits ? (
                    <ProjectBudgetCard budget={b} compact />
                  ) : (
                    <p className="text-[10px] text-bai-mute/60">No budget set — add limits in Settings.</p>
                  )}
                  {!b.hasLimits && pSpend && pSpend.totalUsd > 0 ? (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-bai-line">
                        <div
                          className="h-full rounded-full bg-bai-orange/60"
                          style={{ width: `${Math.max(4, ((pSpend.totalUsd / maxProjectSpend) * 100))}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-bai-mute">share of portfolio</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {spend ? (
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-bai-mute">Spend by agent</h3>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {(Object.entries(spend.byProvider) as [AgentProviderId, SpendBucket][]).map(([id, bucket]) => {
              const meta = providerMap[id];
              if (!meta) return null;
              return (
                <div key={id} className="rounded-lg border border-bai-line bg-bai-surface/40 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${providerDot(meta.tone)}`} />
                    <span className="text-xs font-medium text-bai-fg">{meta.shortLabel}</span>
                  </div>
                  <p className="mt-2 text-lg font-semibold tabular-nums text-bai-fg">{usd(bucket.totalUsd)}</p>
                  <p className="text-[11px] tabular-nums text-bai-mute">
                    {usd(bucket.todayUsd)} today · {bucket.runs} run{bucket.runs === 1 ? "" : "s"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {dispatches.length > 0 ? (
        <div className="rounded-lg border border-bai-line bg-bai-bg/50 overflow-hidden">
          <div className="border-b border-bai-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-bai-mute">
            Recent agent runs
          </div>
          <div className="divide-y divide-bai-line/60">
            {dispatches.slice(0, 12).map((d) => {
              const meta = providerMap[d.provider];
              return (
                <div key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dot[d.status]}`} />
                  <DomainBadge domain={d.domain} repo={d.repo} size="xs" />
                  {meta ? <span className={`text-[10px] font-medium ${meta.tone}`}>{meta.shortLabel}</span> : null}
                  {d.pipelineStage ? (
                    <span className="rounded bg-bai-surface px-1.5 py-0.5 text-[10px] capitalize text-bai-mute">
                      {d.pipelineStage}
                    </span>
                  ) : null}
                  <span className="text-bai-mute">#{d.issueNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-bai-fg">{d.title}</span>
                  {d.durationMs ? <span className="text-[11px] tabular-nums text-bai-mute">{mins(d.durationMs)}</span> : null}
                  {typeof d.costUsd === "number" && d.costUsd > 0 ? (
                    <SpendPill amount={d.costUsd} />
                  ) : (
                    <span className="text-[10px] text-bai-mute/60">—</span>
                  )}
                  {d.source === "manual" ? <span className="text-[10px] text-bai-mute/60">manual</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ── new task form ───────────────────────────────────────────── */

function NewTaskForm({
  projects,
  selectedProject,
  onProjectChange,
  showTitle = true,
  onCreated,
}: {
  projects: Project[];
  selectedProject: string | null;
  onProjectChange: (id: string) => void;
  showTitle?: boolean;
  onCreated?: (result: { number: number; url: string; projectId: string }) => void;
}) {
  const qc = useQueryClient();
  const project = selectedProject ?? projects[0]?.id ?? "";
  const setProject = onProjectChange;
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [steps, setSteps] = useState("");
  const [criteria, setCriteria] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const criteriaLines = criteria.split("\n").map((c) => c.trim()).filter(Boolean);
  const criteriaMissing = criteria.trim().length > 0 && criteriaLines.length === 0;

  const create = useMutation({
    mutationFn: async () =>
      apiWrite<{ number: number; url: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          project,
          title,
          context,
          steps: steps.split("\n").filter((s) => s.trim()),
          criteria: criteriaLines,
          priority,
        }),
      }),
    onSuccess: (data) => {
      setTitle("");
      setContext("");
      setSteps("");
      setCriteria("");
      void qc.invalidateQueries({ queryKey: ["board"] });
      onCreated?.({ number: data.number, url: data.url, projectId: project });
    },
  });

  return (
    <form
      className="space-y-4 rounded-xl border border-bai-line bg-bai-surface/30 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!criteria.trim()) return;
        create.mutate();
      }}
    >
      {showTitle ? <h3 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Task details</h3> : null}
      <label className="block space-y-1 text-xs text-bai-mute">
        Project
        <select value={project} onChange={(e) => setProject(e.target.value)} className={INPUT_CLS}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.domain ? ` → ${p.domain}` : " (internal)"}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs text-bai-mute">
        Title
        <input
          className={INPUT_CLS}
          placeholder="What the feature does — one clear line"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs text-bai-mute">
        Context
        <textarea
          className={INPUT_CLS}
          rows={3}
          placeholder="Where this lives in the product, patterns and files to reuse"
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs text-bai-mute">
        Build steps
        <textarea
          className={INPUT_CLS}
          rows={3}
          placeholder={"One step per line\n1. Data layer\n2. API route\n3. UI"}
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs text-bai-mute">
        Done when
        <textarea
          className={INPUT_CLS}
          rows={3}
          placeholder={"One criterion per line — agents are graded on these"}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-bai-mute">Priority</span>
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
          disabled={create.isPending || !title.trim() || !criteria.trim()}
          className="ml-auto rounded-md bg-bai-orange px-4 py-2 text-sm font-semibold text-bai-bg hover:bg-bai-orange-deep disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Queue for agents"}
        </button>
      </div>
      {!criteria.trim() ? (
        <p className="text-[11px] text-amber-300">Add at least one &quot;Done when&quot; criterion — agents are graded on these.</p>
      ) : criteriaMissing ? (
        <p className="text-[11px] text-amber-300">Each criterion should be on its own line.</p>
      ) : null}
      {create.isError ? <p className="text-xs text-red-400">{(create.error as Error).message}</p> : null}
      {create.isSuccess ? (
        <p className="text-xs text-bai-orange">
          Created{" "}
          <a className="underline" href={create.data.url} target="_blank" rel="noreferrer">
            #{create.data.number}
          </a>{" "}
          — ready for an agent.
        </p>
      ) : null}
    </form>
  );
}

/* ── board ───────────────────────────────────────────────────── */

const STAGES: { key: TaskStage; label: string; tone: string }[] = [
  { key: "agent:idea", label: "Ideas", tone: "border-lime-400/70" },
  { key: "agent:ready", label: "Ready", tone: "border-bai-orange" },
  { key: "agent:analyzing", label: "Analyze", tone: "border-sky-400/80" },
  { key: "agent:implementing", label: "Build", tone: "border-bai-metal" },
  { key: "agent:validating", label: "Validate", tone: "border-violet-400/80" },
  { key: "agent:review", label: "In review", tone: "border-bai-orange-deep" },
  { key: "agent:blocked", label: "Blocked", tone: "border-red-500/80" },
  { key: "done", label: "Done", tone: "border-bai-line" },
];

function activeRunForTask(runs: AgentRun[] | undefined, repo: string, issueNumber: number): AgentRun | undefined {
  return runs?.find(
    (r) => r.repo === repo && r.issueNumber === issueNumber && r.status === "running" && r.source === "dispatch"
  );
}

function TaskCard({
  task,
  repo,
  projectId,
  domain,
  issueSpend,
  budget,
  provider,
  providers,
  activeRun,
  onLogRun,
}: {
  task: TaskIssue;
  repo: string;
  projectId: string;
  domain?: string;
  issueSpend?: SpendBucket;
  budget?: ProjectBudgetStatus;
  provider: AgentProviderId;
  providers: AgentProvider[];
  activeRun?: AgentRun;
  onLogRun: (prefill: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId }) => void;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const meta = providers.find((p) => p.id === provider);

  const dispatch = useMutation({
    mutationFn: async () =>
      apiWrite("/api/dispatch", {
        method: "POST",
        body: JSON.stringify({
          project: projectId,
          issueNumber: task.number,
          title: task.title,
          provider: "claude-code",
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["board"] });
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
    },
  });

  const promote = useMutation({
    mutationFn: async () =>
      apiWrite("/api/tasks/promote", {
        method: "POST",
        body: JSON.stringify({ project: projectId, issueNumber: task.number }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["board"] }),
  });

  const dismiss = useMutation({
    mutationFn: async () =>
      apiWrite("/api/tasks/dismiss", {
        method: "POST",
        body: JSON.stringify({ project: projectId, issueNumber: task.number }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["board"] }),
  });

  const unblock = useMutation({
    mutationFn: async () =>
      apiWrite("/api/tasks/unblock", {
        method: "POST",
        body: JSON.stringify({ project: projectId, issueNumber: task.number }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["board"] }),
  });

  const readyActions = () => {
    if (budget?.anyExceeded) {
      return (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-300">
          Project budget exceeded — dispatch blocked. Raise limits in Project budgets or wait for the period to reset.
        </p>
      );
    }
    if (provider === "claude-code") {
      return (
        <>
          <button
            type="button"
            disabled={dispatch.isPending || meta?.available === false || budget?.anyExceeded}
            onClick={() => dispatch.mutate()}
            className="w-full rounded border border-bai-orange bg-bai-orange/15 px-1.5 py-1 text-[10px] font-semibold text-bai-orange hover:bg-bai-orange/25 disabled:opacity-50"
          >
            {dispatch.isPending ? "Starting…" : "▶ Dispatch team"}
          </button>
          <button
            type="button"
            onClick={() => copyText(claudeHeadlessCommand(repo, task.number), () => setCopied("cli"))}
            className="w-full rounded border border-bai-line px-2 py-1.5 text-[10px] text-bai-mute hover:text-bai-fg"
          >
            {copied === "cli" ? "Copied CLI command" : "Copy headless CLI command"}
          </button>
          {dispatch.isError ? <p className="text-[10px] text-red-400">{(dispatch.error as Error).message}</p> : null}
        </>
      );
    }
    if (provider === "claude-interactive") {
      return (
        <>
          <button
            type="button"
            onClick={() => copyText(claudeInteractiveCommand(repo, task.number), () => setCopied("interactive"))}
            className="w-full rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-2 text-[11px] font-medium text-amber-300 hover:bg-amber-400/20"
          >
            {copied === "interactive" ? "Copied — paste in terminal" : "Copy Claude terminal command"}
          </button>
          <p className="text-[10px] leading-snug text-bai-mute/80">Uses platform.claude.com credits. Log cost when done.</p>
        </>
      );
    }
    if (provider === "cursor") {
      return (
        <>
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="block w-full rounded-md border border-sky-400/40 bg-sky-400/10 px-2 py-2 text-center text-[11px] font-medium text-sky-300 hover:bg-sky-400/20"
          >
            Open issue in GitHub
          </a>
          <button
            type="button"
            onClick={() => copyText(cursorPrompt(repo, task.number), () => setCopied("cursor"))}
            className="w-full rounded border border-bai-line px-2 py-1.5 text-[10px] text-bai-mute hover:text-bai-fg"
          >
            {copied === "cursor" ? "Copied agent prompt" : "Copy Cursor agent prompt"}
          </button>
          <p className="text-[10px] leading-snug text-bai-mute/80">Open repo in Cursor → Agent → paste prompt.</p>
        </>
      );
    }
    return (
      <p className="text-[10px] leading-snug text-bai-mute/80">
        Run your API agent against this issue, then log cost below. Track usage in console.anthropic.com.
      </p>
    );
  };

  return (
    <div className="rounded-md border border-bai-line bg-bai-surface p-2 hover:border-bai-mute/50 transition-colors">
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        <DomainBadge domain={domain} repo={repo} size="xs" />
        {issueSpend && issueSpend.totalUsd > 0 ? (
          <SpendPill amount={issueSpend.totalUsd} label={`${issueSpend.runs} run${issueSpend.runs === 1 ? "" : "s"}`} />
        ) : null}
        {issueSpend && issueSpend.todayUsd > 0 ? <SpendPill amount={issueSpend.todayUsd} label="today" tone="warn" /> : null}
      </div>
      <a href={task.url} target="_blank" rel="noreferrer" className="block">
        <p className="text-xs font-medium text-bai-fg leading-snug">{task.title}</p>
        <p className="mt-0.5 text-[10px] text-bai-mute/80">
          #{task.number}
          {task.priority ? ` · ${task.priority}` : ""}
          {task.assignee ? ` · ${task.assignee}` : ""}
        </p>
        {task.bodyPreview ? (
          <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-bai-mute/70">{task.bodyPreview}</p>
        ) : null}
      </a>
      {activeRun ? (
        <p className="mt-1.5 rounded border border-bai-orange/30 bg-bai-orange/10 px-1.5 py-0.5 text-[9px] text-bai-orange">
          Agent running · {activeRun.pipelineStage ?? "pipeline"}
        </p>
      ) : null}
      {PIPELINE_ACTIVE.includes(task.stage) && !activeRun ? (
        <p className="mt-1.5 text-[9px] text-bai-mute/70">In pipeline — check GitHub</p>
      ) : null}
      {task.stage === "agent:blocked" ? (
        <div className="mt-1.5 space-y-1 border-t border-red-500/30 pt-1.5">
          <p className="text-[9px] leading-snug text-red-300/90">
            Failed repeatedly — fix the task or the repo, then retry.
          </p>
          <button
            type="button"
            disabled={unblock.isPending}
            onClick={() => unblock.mutate()}
            className="w-full rounded border border-red-400/40 bg-red-400/10 px-1.5 py-1 text-[10px] font-semibold text-red-300 hover:bg-red-400/20 disabled:opacity-50"
          >
            {unblock.isPending ? "Requeueing…" : "↻ Retry (back to Ready)"}
          </button>
          {unblock.isError ? <p className="text-[10px] text-red-400">{(unblock.error as Error).message}</p> : null}
        </div>
      ) : null}
      {task.stage === "agent:idea" ? (
        <div className="mt-1.5 space-y-1 border-t border-bai-line/60 pt-1.5">
          <button
            type="button"
            disabled={promote.isPending}
            onClick={() => promote.mutate()}
            className="w-full rounded border border-lime-400/40 bg-lime-400/10 px-1.5 py-1 text-[10px] font-semibold text-lime-300 hover:bg-lime-400/20 disabled:opacity-50"
          >
            {promote.isPending ? "Promoting…" : "↑ Promote"}
          </button>
          <button
            type="button"
            disabled={dismiss.isPending}
            onClick={() => {
              if (!window.confirm(`Dismiss idea #${task.number}? This closes the issue.`)) return;
              dismiss.mutate();
            }}
            className="w-full rounded border border-bai-line px-1.5 py-1 text-[9px] text-bai-mute hover:border-red-400/40 hover:text-red-300"
          >
            {dismiss.isPending ? "…" : "Dismiss"}
          </button>
          {promote.isError ? <p className="text-[10px] text-red-400">{(promote.error as Error).message}</p> : null}
          {dismiss.isError ? <p className="text-[10px] text-red-400">{(dismiss.error as Error).message}</p> : null}
        </div>
      ) : null}
      {task.stage === "agent:ready" ? (
        <div className="mt-1.5 space-y-1 border-t border-bai-line/60 pt-1.5">
          {meta ? (
            <p className="text-[10px] text-bai-mute">
              via <span className={meta.tone}>{meta.shortLabel}</span>
            </p>
          ) : null}
          {readyActions()}
          {provider !== "claude-code" ? (
            <button
              type="button"
              onClick={() =>
                onLogRun({ projectId, issueNumber: task.number, title: task.title, provider })
              }
              className="w-full rounded border border-dashed border-bai-line px-2 py-1 text-[10px] text-bai-mute hover:border-bai-orange hover:text-bai-orange"
            >
              Log cost in Settings
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PrReviewRow({ repo, pr, domain }: { repo: string; pr: ReviewPr; domain?: string }) {
  const qc = useQueryClient();
  const [branchCopied, setBranchCopied] = useState(false);
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
    mutationFn: async () =>
      apiWrite<{ domain?: string | null; message?: string }>("/api/prs/merge", {
        method: "POST",
        body: JSON.stringify({ repo, number: pr.number }),
      }),
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

  const copyBranchRef = () => {
    const text = `${repo} — ${pr.branch} (PR #${pr.number})`;
    void navigator.clipboard.writeText(text);
    setBranchCopied(true);
    setTimeout(() => setBranchCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-bai-line/80 bg-bai-bg/50 px-2.5 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <a href={pr.url} target="_blank" rel="noreferrer" className="block text-sm text-bai-fg hover:text-bai-orange">
          <span className="text-bai-mute">#{pr.number}</span> {pr.title}
        </a>
        <button
          type="button"
          onClick={copyBranchRef}
          title="Copy repo + branch — paste in chat to request a merge to main"
          className="inline-flex max-w-full items-center gap-1.5 rounded border border-bai-line/80 bg-bai-surface/60 px-2 py-0.5 text-left hover:border-bai-orange/50 hover:bg-bai-orange/10"
        >
          <code className="truncate text-[10px] text-bai-metal">{pr.branch}</code>
          <span className="shrink-0 text-[10px] text-bai-mute">{branchCopied ? "Copied" : "Copy"}</span>
        </button>
      </div>
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
        {merge.isPending ? "Merging…" : "✓ Approve → prod"}
      </button>
      {merge.isSuccess ? <span className="text-[10px] text-emerald-400">Merged — deploying</span> : null}
      {merge.isError ? <span className="text-[10px] text-red-400">{(merge.error as Error).message}</span> : null}
    </div>
  );
}

function isQuiet(board: Board): boolean {
  return board.tasks.length === 0 && board.prs.length === 0;
}

function PortfolioOverview({
  boards,
  spend,
  onSelectProject,
}: {
  boards: Board[];
  spend?: SpendSummary;
  onSelectProject?: (projectId: string) => void;
}) {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {boards.map((board) => {
        const count = (stage: TaskIssue["stage"]) => board.tasks.filter((t) => t.stage === stage).length;
        const quiet = isQuiet(board);
        const pSpend = projectSpend(spend, board.project.id);
        const budget = projectBudget(spend, board.project.id);
        return (
          <button
            key={board.project.id}
            type="button"
            onClick={() => onSelectProject?.(board.project.id)}
            className={`rounded-md border p-2.5 text-left transition-colors ${
              budget?.anyExceeded
                ? "border-red-500/50 bg-red-500/5 hover:border-red-500/70"
                : board.prs.length > 0
                  ? "border-bai-orange/50 bg-bai-orange/5 hover:border-bai-orange"
                  : quiet
                    ? "border-bai-line/60 bg-bai-surface/30 hover:border-bai-line"
                    : "border-bai-line bg-bai-surface hover:border-bai-mute/60"
            }`}
          >
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <DomainBadge domain={board.project.domain} repo={board.project.repo} size="xs" />
              {budget?.anyExceeded ? (
                <span className="text-[10px] text-red-400">over budget</span>
              ) : budget?.anyNearLimit ? (
                <span className="text-[10px] text-amber-300">near limit</span>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-semibold text-bai-fg">{board.project.name}</p>
              {board.prs.length > 0 ? (
                <span className="shrink-0 rounded-full bg-bai-orange px-1.5 text-[10px] font-bold text-bai-bg">
                  {board.prs.length} PR
                </span>
              ) : null}
            </div>
            {pSpend && pSpend.totalUsd > 0 ? (
              <p className="mt-1.5 text-[11px] tabular-nums">
                <span className="text-bai-orange font-medium">{usd(pSpend.totalUsd)}</span>
                <span className="text-bai-mute"> spent · {usd(pSpend.monthlyUsd)} this month</span>
              </p>
            ) : null}
            {budget?.hasLimits && budget.meters.daily.limit ? (
              <p className="mt-1 text-[10px] tabular-nums text-bai-mute">
                today {usd(budget.spent.daily)} / {usd(budget.meters.daily.limit!)}
              </p>
            ) : null}
            {quiet ? (
              <p className="mt-1.5 text-[11px] text-bai-mute/60">quiet</p>
            ) : (
              <p className="mt-1.5 flex gap-2.5 text-[11px] tabular-nums">
                <span className="text-lime-300">{count("agent:idea")} ideas</span>
                <span className="text-bai-orange">{count("agent:ready")} ready</span>
                <span className="text-bai-metal">
                  {PIPELINE_ACTIVE.reduce((n, s) => n + count(s), 0)} in pipeline
                </span>
                <span className="text-bai-orange-deep">{count("agent:review")} review</span>
              </p>
            )}
          </button>
        );
      })}
    </section>
  );
}


function ProjectBoard({
  board,
  provider,
  providers,
  spend,
  dispatches,
  onLogRun,
  showHeader = true,
}: {
  board: Board;
  provider: AgentProviderId;
  providers: AgentProvider[];
  spend?: SpendSummary;
  dispatches?: AgentRun[];
  onLogRun: (prefill: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId }) => void;
  showHeader?: boolean;
}) {
  const pSpend = projectSpend(spend, board.project.id);
  const budget = projectBudget(spend, board.project.id);

  return (
    <section id={`project-${board.project.id}`} className="scroll-mt-6 space-y-3">
      {budget?.anyExceeded ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <strong className="font-semibold">Budget exceeded</strong> — agent dispatch is blocked for this project until spend drops or you raise limits.
        </div>
      ) : null}
      <div className={`flex flex-wrap items-start justify-between gap-3 ${showHeader ? "rounded-lg border border-bai-line/80 bg-bai-surface/20 px-3 py-2.5" : ""}`}>
        {showHeader ? (
          <div className="space-y-1.5 min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-bai-fg">{board.project.name}</h2>
              <DomainBadge domain={board.project.domain} repo={board.project.repo} />
            </div>
            <a
              className="text-xs text-bai-mute hover:text-bai-metal"
              href={`https://github.com/${board.project.repo}`}
              target="_blank"
              rel="noreferrer"
            >
              {board.project.repo}
            </a>
            {pSpend ? (
              <p className="text-[11px] tabular-nums text-bai-mute">
                <span className="text-bai-orange font-medium">{usd(pSpend.totalUsd)}</span> total ·{" "}
                {usd(pSpend.todayUsd)} today · {usd(pSpend.monthlyUsd)} this month · {pSpend.runs} runs
              </p>
            ) : null}
          </div>
        ) : pSpend && pSpend.totalUsd > 0 ? (
          <p className="text-[11px] tabular-nums text-bai-mute">
            <span className="text-bai-orange font-medium">{usd(pSpend.totalUsd)}</span> spent on this project
          </p>
        ) : null}
        {budget && (budget.hasLimits || budget.anyExceeded) ? (
          <div className="w-full sm:w-64 shrink-0">
            <ProjectBudgetCard budget={budget} />
          </div>
        ) : null}
      </div>

      {board.prs.length > 0 ? (
        <div className="rounded-lg border border-bai-orange/40 bg-bai-orange/5 p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-bai-orange">
            Review & approve → ships to {board.project.domain ?? "main"}
          </p>
          {board.prs.map((pr) => (
            <PrReviewRow key={pr.number} repo={board.project.repo} pr={pr} domain={board.project.domain} />
          ))}
        </div>
      ) : null}

      {!showHeader ? (
        <p className="text-[10px] font-medium uppercase tracking-wider text-bai-mute">Task board</p>
      ) : null}
      <div className="scroll-hidden flex gap-2 overflow-x-auto pb-1">
        {STAGES.map((stage) => {
          const tasks = board.tasks.filter((t) => t.stage === stage.key);
          return (
            <div
              key={stage.key}
              className={`w-[9.5rem] shrink-0 rounded-md border-t-2 ${stage.tone} bg-bai-bg p-1.5 space-y-1.5`}
            >
              <p className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-bai-mute">
                {stage.label} <span className="text-bai-mute/60">{tasks.length}</span>
              </p>
              {tasks.map((task) => (
                <TaskCard
                  key={task.number}
                  task={task}
                  repo={board.project.repo}
                  projectId={board.project.id}
                  domain={board.project.domain}
                  issueSpend={spend?.byIssue[issueSpendKey(board.project.repo, task.number)]}
                  budget={budget}
                  provider={provider}
                  providers={providers}
                  activeRun={activeRunForTask(dispatches, board.project.repo, task.number)}
                  onLogRun={onLogRun}
                />
              ))}
              {tasks.length === 0 ? <p className="px-0.5 pb-0.5 text-[10px] text-bai-mute/60">—</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── navigation & views ─────────────────────────────────────── */

function boardScore(board: Board): number {
  return board.prs.length * 100 + board.tasks.filter((t) => t.stage === "agent:ready").length * 10 + board.tasks.length;
}

function TabButton({
  active,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 pt-1 text-sm font-medium transition-colors ${
        active
          ? "border-bai-orange text-bai-fg"
          : "border-transparent text-bai-mute hover:border-bai-line hover:text-bai-metal"
      }`}
    >
      {label}
      {badge != null && badge > 0 ? (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums font-semibold ${
            active ? "bg-bai-orange text-bai-bg" : "bg-bai-surface text-bai-mute"
          }`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function CompactAgentPicker({
  providers,
  selected,
  onSelect,
}: {
  providers: AgentProvider[];
  selected: AgentProviderId;
  onSelect: (id: AgentProviderId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => {
        const active = selected === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            title={p.tagline}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-bai-orange/60 bg-bai-orange/15 text-bai-fg"
                : "border-bai-line bg-bai-surface/50 text-bai-mute hover:border-bai-mute/50 hover:text-bai-fg"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${providerDot(p.tone)}`} />
            {p.shortLabel}
            {!p.available ? <span className="text-red-400">·</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function DashboardView({
  boards,
  spend,
  totals,
  onOpenProject,
  onOpenProjects,
  onOpenNewTask,
}: {
  boards: Board[];
  spend?: SpendSummary;
  totals: { ready: number; pipeline: number; review: number; prs: number; ideas: number };
  onOpenProject: (projectId: string) => void;
  onOpenProjects: () => void;
  onOpenNewTask: (projectId?: string) => void;
}) {
  const reviewQueue = boards.flatMap((b) => b.prs.map((pr) => ({ board: b, pr })));
  const readyQueue = boards.flatMap((b) =>
    b.tasks.filter((t) => t.stage === "agent:ready").map((task) => ({ board: b, task }))
  );
  const ideasQueue = boards.flatMap((b) =>
    b.tasks.filter((t) => t.stage === "agent:idea").map((task) => ({ board: b, task }))
  );
  const quietCount = boards.filter(isQuiet).length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <WorkflowStrip />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatCard label="Awaiting review" value={totals.prs} tone={totals.prs > 0 ? "accent" : "default"} />
        <StatCard label="Ready for agents" value={totals.ready} tone={totals.ready > 0 ? "warn" : "default"} />
        <StatCard label="Ideas to review" value={totals.ideas} tone={totals.ideas > 0 ? "warn" : "default"} />
        <StatCard label="In pipeline" value={totals.pipeline} />
        <StatCard label="Spend today" value={spend ? usd(spend.todayUsd) : "$0.00"} />
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-bai-fg">Needs your attention</h3>
            <p className="text-xs text-bai-mute">Approve PRs, review ideas, or dispatch agents on ready tasks.</p>
          </div>
          {reviewQueue.length + readyQueue.length + ideasQueue.length > 0 ? (
            <button
              type="button"
              onClick={onOpenProjects}
              className="text-xs text-bai-orange hover:text-bai-orange-deep"
            >
              Open all projects →
            </button>
          ) : null}
        </div>

        {reviewQueue.length === 0 && readyQueue.length === 0 && ideasQueue.length === 0 ? (
          <div className="rounded-xl border border-bai-line/80 bg-bai-surface/20 px-4 py-8 text-center">
            <p className="text-sm text-bai-fg">All clear — nothing waiting on you.</p>
            <button
              type="button"
              onClick={() => onOpenNewTask()}
              className="mt-3 rounded-md bg-bai-orange px-4 py-2 text-sm font-semibold text-bai-bg hover:bg-bai-orange-deep"
            >
              Queue a new task
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {reviewQueue.length > 0 ? (
              <div className="rounded-xl border border-bai-orange/40 bg-bai-orange/5 p-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-bai-orange">
                  {reviewQueue.length} PR{reviewQueue.length === 1 ? "" : "s"} awaiting review
                </p>
                {reviewQueue.map(({ board, pr }) => (
                  <div key={`${board.project.id}-${pr.number}`}>
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <DomainBadge domain={board.project.domain} repo={board.project.repo} size="xs" />
                      <button
                        type="button"
                        onClick={() => onOpenProject(board.project.id)}
                        className="text-[11px] text-bai-mute hover:text-bai-orange"
                      >
                        {board.project.name}
                      </button>
                    </div>
                    <PrReviewRow repo={board.project.repo} pr={pr} domain={board.project.domain} />
                  </div>
                ))}
              </div>
            ) : null}

            {ideasQueue.length > 0 ? (
              <div className="rounded-lg border border-lime-400/30 bg-lime-400/5 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-lime-300">
                  {ideasQueue.length} idea{ideasQueue.length === 1 ? "" : "s"} to review
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ideasQueue.slice(0, 4).map(({ board, task }) => (
                    <button
                      key={`${board.project.id}-${task.number}`}
                      type="button"
                      onClick={() => onOpenProject(board.project.id)}
                      className="rounded-md border border-bai-line bg-bai-bg/60 p-2.5 text-left hover:border-lime-400/40"
                    >
                      <div className="mb-1">
                        <DomainBadge domain={board.project.domain} repo={board.project.repo} size="xs" />
                      </div>
                      <p className="text-sm text-bai-fg line-clamp-2">{task.title}</p>
                      {task.bodyPreview ? (
                        <p className="mt-1 line-clamp-2 text-[11px] text-bai-mute/70">{task.bodyPreview}</p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-bai-mute">#{task.number} · {board.project.name}</p>
                    </button>
                  ))}
                </div>
                {ideasQueue.length > 4 ? (
                  <button type="button" onClick={onOpenProjects} className="text-xs text-lime-300">
                    + {ideasQueue.length - 4} more in Projects
                  </button>
                ) : null}
              </div>
            ) : null}

            {readyQueue.length > 0 ? (
              <div className="rounded-lg border border-bai-line bg-bai-surface/20 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-bai-mute">
                  {readyQueue.length} task{readyQueue.length === 1 ? "" : "s"} ready for agents
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {readyQueue.slice(0, 6).map(({ board, task }) => (
                    <button
                      key={`${board.project.id}-${task.number}`}
                      type="button"
                      onClick={() => onOpenProject(board.project.id)}
                      className="rounded-md border border-bai-line bg-bai-bg/60 p-2.5 text-left hover:border-bai-orange/50"
                    >
                      <div className="mb-1">
                        <DomainBadge domain={board.project.domain} repo={board.project.repo} size="xs" />
                      </div>
                      <p className="text-sm text-bai-fg line-clamp-2">{task.title}</p>
                      <p className="mt-1 text-[11px] text-bai-mute">#{task.number} · {board.project.name}</p>
                    </button>
                  ))}
                </div>
                {readyQueue.length > 6 ? (
                  <button type="button" onClick={onOpenProjects} className="text-xs text-bai-orange">
                    + {readyQueue.length - 6} more in Projects
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-bai-fg">All projects</h3>
          <p className="text-xs text-bai-mute">Click a card to open its board in Projects.</p>
        </div>
        {boards.length > 0 ? (
          <PortfolioOverview boards={boards} spend={spend} onSelectProject={onOpenProject} />
        ) : (
          <p className="text-sm text-bai-mute">Loading projects…</p>
        )}
        {quietCount > 0 ? (
          <p className="text-xs text-bai-mute">
            {quietCount} quiet project{quietCount === 1 ? "" : "s"} with no activity — browse in{" "}
            <button type="button" onClick={onOpenProjects} className="text-bai-orange hover:underline">
              Projects
            </button>
            .
          </p>
        ) : null}
      </section>

      <SitesPanel />
    </div>
  );
}

function ProjectListItem({
  board,
  active,
  onClick,
  spend,
}: {
  board: Board;
  active: boolean;
  onClick: () => void;
  spend?: SpendSummary;
}) {
  const ready = board.tasks.filter((t) => t.stage === "agent:ready").length;
  const ideas = board.tasks.filter((t) => t.stage === "agent:idea").length;
  const pipeline = pipelineTaskCount(board);
  const quiet = isQuiet(board);
  const budget = projectBudget(spend, board.project.id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
        active
          ? "border-bai-orange/60 bg-bai-orange/10"
          : quiet
            ? "border-bai-line/50 bg-bai-surface/20 hover:border-bai-line"
            : "border-bai-line bg-bai-surface/30 hover:border-bai-mute/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-bai-fg">{board.project.name}</p>
          <p className="mt-0.5 truncate text-[10px] text-bai-mute">{board.project.domain ?? board.project.repo.split("/")[1]}</p>
        </div>
        {board.prs.length > 0 ? (
          <span className="shrink-0 rounded-full bg-bai-orange px-1.5 text-[10px] font-bold text-bai-bg">
            {board.prs.length}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] tabular-nums">
        {quiet ? (
          <span className="text-bai-mute/60">quiet</span>
        ) : (
          <>
            {ideas > 0 ? <span className="text-lime-300">{ideas} ideas</span> : null}
            {ready > 0 ? <span className="text-bai-orange">{ready} ready</span> : null}
            {pipeline > 0 ? <span className="text-bai-metal">{pipeline} in pipeline</span> : null}
          </>
        )}
        {budget?.anyExceeded ? <span className="text-red-400">over budget</span> : null}
      </div>
    </button>
  );
}

function ProjectsView({
  boards,
  selectedProjectId,
  onSelectProject,
  provider,
  providers,
  spend,
  dispatches,
  onLogRun,
  onNewTask,
}: {
  boards: Board[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  provider: AgentProviderId;
  providers: AgentProvider[];
  spend?: SpendSummary;
  dispatches?: AgentRun[];
  onLogRun: (prefill: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId }) => void;
  onNewTask: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "quiet">("all");

  const sorted = [...boards].sort((a, b) => boardScore(b) - boardScore(a));
  const filtered = sorted.filter((b) => {
    if (filter === "active" && isQuiet(b)) return false;
    if (filter === "quiet" && !isQuiet(b)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      b.project.name.toLowerCase().includes(q) ||
      b.project.id.toLowerCase().includes(q) ||
      (b.project.domain?.toLowerCase().includes(q) ?? false) ||
      b.project.repo.toLowerCase().includes(q)
    );
  });

  const effectiveId =
    selectedProjectId ??
    sorted.find((b) => !isQuiet(b))?.project.id ??
    sorted[0]?.project.id ??
    null;

  const selected = boards.find((b) => b.project.id === effectiveId) ?? null;

  const filterBtn = (key: typeof filter, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        filter === key ? "bg-bai-orange/15 text-bai-orange" : "text-bai-mute hover:text-bai-fg"
      }`}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:gap-5">
      <aside className="shrink-0 border-b border-bai-line pb-3 lg:w-52 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
        <div className="shrink-0 space-y-2 pb-2">
          <input
            className={`${INPUT_CLS} py-1.5 text-xs`}
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {filterBtn("all", "All", boards.length)}
            {filterBtn("active", "Active", boards.filter((b) => !isQuiet(b)).length)}
            {filterBtn("quiet", "Quiet", boards.filter(isQuiet).length)}
          </div>
        </div>
        <div className="space-y-1">
          {filtered.map((board) => (
            <ProjectListItem
              key={board.project.id}
              board={board}
              active={effectiveId === board.project.id}
              onClick={() => onSelectProject(board.project.id)}
              spend={spend}
            />
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 py-4 text-xs text-bai-mute">No projects match.</p>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {selected ? (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-bai-fg">{selected.project.name}</h3>
                  <DomainBadge domain={selected.project.domain} repo={selected.project.repo} size="xs" />
                </div>
                <a
                  className="mt-1 inline-block text-xs text-bai-mute hover:text-bai-orange"
                  href={`https://github.com/${selected.project.repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selected.project.repo} ↗
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onNewTask(selected.project.id)}
                  className="rounded-md border border-bai-line px-3 py-1.5 text-xs text-bai-fg hover:border-bai-orange hover:text-bai-orange"
                >
                  + New task
                </button>
              </div>
            </div>

            {isQuiet(selected) ? (
              <div className="rounded-xl border border-bai-line/80 bg-bai-surface/20 p-8 text-center">
                <p className="text-sm text-bai-mute">No agent activity yet — queue the first task for this product.</p>
                <button
                  type="button"
                  onClick={() => onNewTask(selected.project.id)}
                  className="mt-4 rounded-md bg-bai-orange px-4 py-2 text-sm font-semibold text-bai-bg hover:bg-bai-orange-deep"
                >
                  Queue first task
                </button>
              </div>
            ) : (
              <ProjectBoard
                board={selected}
                provider={provider}
                providers={providers}
                spend={spend}
                dispatches={dispatches}
                onLogRun={onLogRun}
                showHeader={false}
              />
            )}
          </>
        ) : (
          <p className="text-sm text-bai-mute">Select a project from the list.</p>
        )}
      </div>
    </div>
  );
}

/* ── shell ───────────────────────────────────────────────────── */

function BaiDigitalOffice() {
  const [tab, setTab] = useState<OfficeTab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    if (
      saved === "dashboard" ||
      saved === "projects" ||
      saved === "new-task" ||
      saved === "automation" ||
      saved === "spend" ||
      saved === "settings"
    ) {
      return saved;
    }
    return "dashboard";
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [formProject, setFormProject] = useState<string | null>(null);
  const [logPrefill, setLogPrefill] = useState<{
    projectId: string;
    issueNumber: number;
    title: string;
    provider: AgentProviderId;
  } | null>(null);
  const [provider, setProvider] = useState<AgentProviderId>(() => {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return saved === "cursor" || saved === "claude-interactive" || saved === "anthropic-api" || saved === "claude-code"
      ? saved
      : "claude-code";
  });

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    localStorage.setItem(PROVIDER_KEY, provider);
  }, [provider]);

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => getJson<AgentsResponse>("/api/agents"),
  });
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
  const spendQuery = useQuery({
    queryKey: ["dispatches"],
    queryFn: () => getJson<{ dispatches: AgentRun[]; spend: SpendSummary }>("/api/dispatches"),
    refetchInterval: 15_000,
  });

  const providers = agentsQuery.data?.providers ?? [];
  const projects = projectsQuery.data?.projects ?? [];
  const boards = boardQuery.data?.boards ?? [];
  const activeBoards = boards.filter((b) => !isQuiet(b));
  const spend = spendQuery.data?.spend;
  const dispatches = spendQuery.data?.dispatches ?? [];
  const totals = boards.reduce(
    (acc, b) => {
      for (const t of b.tasks) {
        if (t.stage === "agent:ready") acc.ready += 1;
        else if (t.stage === "agent:idea") acc.ideas += 1;
        else if (PIPELINE_ACTIVE.includes(t.stage)) acc.pipeline += 1;
        else if (t.stage === "agent:review") acc.review += 1;
      }
      acc.prs += b.prs.length;
      return acc;
    },
    { ready: 0, pipeline: 0, review: 0, prs: 0, ideas: 0 }
  );

  const attentionCount = totals.prs + totals.ready + totals.ideas;

  const openProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setTab("projects");
  };

  const openNewTask = (projectId?: string) => {
    if (projectId) setFormProject(projectId);
    setTab("new-task");
  };

  const openSettingsForLog = (prefill: {
    projectId: string;
    issueNumber: number;
    title: string;
    provider: AgentProviderId;
  }) => {
    setLogPrefill(prefill);
    setTab("settings");
  };

  useEffect(() => {
    if (tab === "settings" && logPrefill) {
      requestAnimationFrame(() => {
        document.getElementById("log-run-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }, [tab, logPrefill]);

  if (projectsQuery.data && !projectsQuery.data.github) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bai-bg p-6 text-bai-fg">
        <div className="max-w-md rounded-xl border border-bai-line bg-bai-surface/30 p-6 text-center">
          <h1 className="text-xl font-bold">
            bai digital <span className="text-bai-orange">office</span>
          </h1>
          <p className="mt-4 text-sm text-bai-orange">
            Set <code>GITHUB_TOKEN</code> in environment variables (repo scope) and redeploy.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bai-bg text-bai-fg">
      <header className="shrink-0 border-b border-bai-line bg-bai-surface/30">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight sm:text-xl">
              bai digital <span className="text-bai-orange">office</span>
            </h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
            {boards.length > 0 ? (
              <>
                {totals.prs > 0 ? (
                  <span className="rounded-full bg-bai-orange px-2 py-0.5 font-semibold text-bai-bg">
                    {totals.prs} review
                  </span>
                ) : null}
                {totals.ready > 0 ? (
                  <span className="rounded-full border border-bai-orange/40 px-2 py-0.5 text-bai-orange">
                    {totals.ready} ready
                  </span>
                ) : null}
              </>
            ) : null}
            {spend ? (
              <span className="rounded-full border border-bai-line px-2 py-0.5 text-bai-mute">
                {usd(spend.todayUsd)} today
              </span>
            ) : null}
          </div>
        </div>

        <nav className="scroll-hidden mx-auto flex max-w-7xl gap-4 overflow-x-auto px-4 sm:gap-6 sm:px-6" role="tablist" aria-label="Office sections">
          {(Object.keys(TAB_META) as OfficeTab[]).map((id) => (
            <TabButton
              key={id}
              active={tab === id}
              label={TAB_META[id].label}
              badge={
                id === "dashboard"
                  ? attentionCount
                  : id === "projects"
                    ? activeBoards.length
                    : undefined
              }
              onClick={() => setTab(id)}
            />
          ))}
        </nav>
      </header>

      <SystemHealthBar />

      <main className="mx-auto min-h-0 w-full max-w-7xl flex-1 overflow-y-auto scroll-subtle px-4 py-4 sm:px-6 sm:py-5">
        {tab !== "dashboard" ? (
          <PageHeader title={TAB_META[tab].label} description={TAB_META[tab].hint} />
        ) : null}

        {boardQuery.isError ? (
          <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {(boardQuery.error as Error).message}
          </p>
        ) : null}

        {tab === "dashboard" ? (
          boardQuery.isLoading ? (
            <LoadingBlock label="Loading your portfolio…" />
          ) : (
            <DashboardView
              boards={boards}
              spend={spend}
              totals={totals}
              onOpenProject={openProject}
              onOpenProjects={() => setTab("projects")}
              onOpenNewTask={openNewTask}
            />
          )
        ) : null}

        {tab === "projects" ? (
          boardQuery.isLoading ? (
            <LoadingBlock label="Loading projects…" />
          ) : (
            <ProjectsView
              boards={boards}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              provider={provider}
              providers={providers}
              spend={spend}
              dispatches={dispatches}
              onLogRun={openSettingsForLog}
              onNewTask={openNewTask}
            />
          )
        ) : null}

        {tab === "new-task" ? (
          <div className="mx-auto max-w-2xl space-y-5">
            {projects.length > 0 ? (
              <>
                <SpecialistRunPanel projects={projects} />
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-bai-mute">Default agent</p>
                  <CompactAgentPicker providers={providers} selected={provider} onSelect={setProvider} />
                  <p className="text-[11px] text-bai-mute/80">
                    Used for dispatch commands on ready tasks. Change anytime in Settings.
                  </p>
                </div>
                <NewTaskForm
                  projects={projects}
                  selectedProject={formProject}
                  onProjectChange={setFormProject}
                  showTitle={false}
                  onCreated={({ projectId }) => {
                    setSelectedProjectId(projectId);
                  }}
                />
              </>
            ) : (
              <LoadingBlock label="Loading projects…" />
            )}
          </div>
        ) : null}

        {tab === "automation" ? <AutomationView projects={projects} /> : null}

        {tab === "spend" ? <SpendDashboard providers={providers} /> : null}

        {tab === "settings" ? (
          <div className="mx-auto max-w-3xl space-y-10">
            <WriteSecretSettings />
            <section>
              <h3 className="mb-1 text-sm font-semibold text-bai-fg">All agents</h3>
              <p className="mb-4 text-xs text-bai-mute">
                Configure the build pipeline and specialist agents. Manual providers below for copy-paste workflows.
              </p>
              <AgentConfigEditor />
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold text-bai-fg">Manual providers</h3>
              <AgentFleetPanel selected={provider} onSelect={setProvider} showHeader={false} />
            </section>
            {projects.length > 0 ? (
              <>
                <section>
                  <h3 className="mb-3 text-sm font-semibold text-bai-fg">Manual run log</h3>
                  <LogRunForm
                    projects={projects}
                    prefill={logPrefill}
                    onLogged={() => setLogPrefill(null)}
                    embedded
                  />
                </section>
                {spend?.budgets ? (
                  <section>
                    <h3 className="mb-3 text-sm font-semibold text-bai-fg">Budget limits</h3>
                    <ProjectBudgetsEditor budgets={spend.budgets} embedded />
                  </section>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BaiDigitalOffice />
    </QueryClientProvider>
  );
}
