import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";

const queryClient = new QueryClient();
const PROVIDER_KEY = "bai-office-agent-provider";
const TAB_KEY = "bai-office-tab";

type OfficeTab = "dashboard" | "projects" | "new-task" | "spend" | "settings";

const TAB_META: Record<OfficeTab, { label: string; hint: string }> = {
  dashboard: { label: "Dashboard", hint: "What needs you right now — PRs to approve and tasks ready for agents." },
  projects: { label: "Projects", hint: "Pick a product, review its kanban, and merge PRs to production." },
  "new-task": { label: "Create", hint: "Describe the work — it becomes a GitHub issue for agents to pick up." },
  spend: { label: "Spend", hint: "Track agent cost by project, provider, and issue." },
  settings: { label: "Settings", hint: "Choose your default agent, log manual runs, and set budget caps." },
};

/* ── types ──────────────────────────────────────────────────── */

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
    { label: "Agent builds", sub: "PR on feat/" },
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
    <div className={`rounded-lg border px-3 py-2.5 ${styles}`}>
      <p className="text-[10px] font-medium uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
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
      const res = await fetch("/api/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          dailyUsd: d.daily.trim() ? Number(d.daily) : null,
          monthlyUsd: d.monthly.trim() ? Number(d.monthly) : null,
          totalUsd: d.total.trim() ? Number(d.total) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not save budget");
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dispatches"] });
    },
  });

  if (budgets.length === 0) return null;

  const editor = (
    <div className={`space-y-3 ${embedded ? "" : "mt-2 max-h-80 overflow-y-auto rounded-lg border border-bai-line bg-bai-surface/20 p-2"}`}>
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
  return `claude -p "Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract in its body: read it with gh issue view ${issueNumber} --repo ${repo}, label agent:building, clone, build on a feat/ branch, run the repo's verify scripts until green, push, open a PR with Closes #${issueNumber}, then label agent:review. Never push to main or merge." --permission-mode acceptEdits --allowedTools "Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Edit,Write,Read,Glob,Grep"`;
}

function claudeInteractiveCommand(repo: string, issueNumber: number): string {
  const prompt = [
    `Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract:`,
    `gh issue view ${issueNumber} --repo ${repo}, label agent:building, feat/ branch, verify green,`,
    `PR with Closes #${issueNumber}, label agent:review. Never push to main.`,
  ].join(" ");
  return `claude "${prompt.replace(/"/g, '\\"')}" --permission-mode acceptEdits`;
}

function cursorPrompt(repo: string, issueNumber: number): string {
  return [
    `Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract in the issue body.`,
    `Label agent:building, build on feat/<slug>, run verify until green, open PR with Closes #${issueNumber}, label agent:review.`,
    `Never push to main or merge.`,
  ].join("\n");
}

function copyText(text: string, setCopied: (v: boolean) => void): void {
  void navigator.clipboard.writeText(text);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
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
    queryFn: () => getJson<{ providers: AgentProvider[] }>("/api/agents"),
  });
  const providers = query.data?.providers ?? [];

  return (
    <section className="space-y-2">
      {showHeader ? (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Agent fleet</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-bai-mute/80">
            Pick how work runs. Only Claude Code headless dispatches from here — log other runs for cost tracking.
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
    mutationFn: async () => {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          issueNumber: Number(issueNumber),
          title,
          provider,
          costUsd: costUsd.trim() ? Number(costUsd) : undefined,
          durationMs: durationMin.trim() ? Number(durationMin) * 60_000 : undefined,
          notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not log run");
      return data;
    },
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
          — ready for an agent.
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

function TaskCard({
  task,
  repo,
  projectId,
  domain,
  issueSpend,
  budget,
  provider,
  providers,
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
  onLogRun: (prefill: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId }) => void;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const meta = providers.find((p) => p.id === provider);

  const dispatch = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          issueNumber: task.number,
          title: task.title,
          provider: "claude-code",
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
            className="w-full rounded-md border border-bai-orange bg-bai-orange/15 px-2 py-2 text-[11px] font-semibold text-bai-orange hover:bg-bai-orange/25 disabled:opacity-50"
          >
            {dispatch.isPending ? "Starting…" : "▶ Dispatch Claude Code"}
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
    <div className="rounded-lg border border-bai-line bg-bai-surface p-2.5 hover:border-bai-mute/50 transition-colors">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <DomainBadge domain={domain} repo={repo} size="xs" />
        {issueSpend && issueSpend.totalUsd > 0 ? (
          <SpendPill amount={issueSpend.totalUsd} label={`${issueSpend.runs} run${issueSpend.runs === 1 ? "" : "s"}`} />
        ) : null}
        {issueSpend && issueSpend.todayUsd > 0 ? <SpendPill amount={issueSpend.todayUsd} label="today" tone="warn" /> : null}
      </div>
      <a href={task.url} target="_blank" rel="noreferrer" className="block">
        <p className="text-sm text-bai-fg leading-snug">{task.title}</p>
        <p className="mt-1 text-[11px] text-bai-mute/80">
          #{task.number}
          {task.priority ? ` · ${task.priority}` : ""}
          {task.assignee ? ` · ${task.assignee}` : ""}
        </p>
      </a>
      {task.stage === "agent:ready" ? (
        <div className="mt-2 space-y-1.5 border-t border-bai-line/60 pt-2">
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
        {merge.isPending ? "Merging…" : "Approve → prod"}
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
            className={`rounded-lg border p-3 text-left transition-colors ${
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


function ProjectBoard({
  board,
  provider,
  providers,
  spend,
  onLogRun,
  showHeader = true,
}: {
  board: Board;
  provider: AgentProviderId;
  providers: AgentProvider[];
  spend?: SpendSummary;
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!showHeader ? (
          <p className="col-span-full text-xs font-medium uppercase tracking-wider text-bai-mute">Task board</p>
        ) : null}
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
                  domain={board.project.domain}
                  issueSpend={spend?.byIssue[issueSpendKey(board.project.repo, task.number)]}
                  budget={budget}
                  provider={provider}
                  providers={providers}
                  onLogRun={onLogRun}
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
  totals: { ready: number; building: number; review: number; prs: number };
  onOpenProject: (projectId: string) => void;
  onOpenProjects: () => void;
  onOpenNewTask: (projectId?: string) => void;
}) {
  const reviewQueue = boards.flatMap((b) => b.prs.map((pr) => ({ board: b, pr })));
  const readyQueue = boards.flatMap((b) =>
    b.tasks.filter((t) => t.stage === "agent:ready").map((task) => ({ board: b, task }))
  );
  const quietCount = boards.filter(isQuiet).length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <WorkflowStrip />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Awaiting review" value={totals.prs} tone={totals.prs > 0 ? "accent" : "default"} />
        <StatCard label="Ready for agents" value={totals.ready} tone={totals.ready > 0 ? "warn" : "default"} />
        <StatCard label="Building" value={totals.building} />
        <StatCard label="Spend today" value={spend ? usd(spend.todayUsd) : "$0.00"} />
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-bai-fg">Needs your attention</h3>
            <p className="text-xs text-bai-mute">Approve PRs or dispatch agents on ready tasks.</p>
          </div>
          {reviewQueue.length + readyQueue.length > 0 ? (
            <button
              type="button"
              onClick={onOpenProjects}
              className="text-xs text-bai-orange hover:text-bai-orange-deep"
            >
              Open all projects →
            </button>
          ) : null}
        </div>

        {reviewQueue.length === 0 && readyQueue.length === 0 ? (
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

            {readyQueue.length > 0 ? (
              <div className="rounded-xl border border-bai-line bg-bai-surface/20 p-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-bai-mute">
                  {readyQueue.length} task{readyQueue.length === 1 ? "" : "s"} ready for agents
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {readyQueue.slice(0, 6).map(({ board, task }) => (
                    <button
                      key={`${board.project.id}-${task.number}`}
                      type="button"
                      onClick={() => onOpenProject(board.project.id)}
                      className="rounded-lg border border-bai-line bg-bai-bg/60 p-3 text-left hover:border-bai-orange/50"
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
  const building = board.tasks.filter((t) => t.stage === "agent:building").length;
  const quiet = isQuiet(board);
  const budget = projectBudget(spend, board.project.id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
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
            {ready > 0 ? <span className="text-bai-orange">{ready} ready</span> : null}
            {building > 0 ? <span className="text-bai-metal">{building} building</span> : null}
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
  onLogRun,
  onNewTask,
}: {
  boards: Board[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  provider: AgentProviderId;
  providers: AgentProvider[];
  spend?: SpendSummary;
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
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row lg:gap-6">
      <aside className="flex max-h-56 shrink-0 flex-col min-h-0 border-b border-bai-line pb-4 lg:max-h-none lg:w-72 lg:shrink-0 lg:border-b-0 lg:border-r lg:pr-4">
        <div className="shrink-0 space-y-3 pb-3">
          <input
            className={INPUT_CLS}
            placeholder="Search by name, domain, repo…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {filterBtn("all", "All", boards.length)}
            {filterBtn("active", "Active", boards.filter((b) => !isQuiet(b)).length)}
            {filterBtn("quiet", "Quiet", boards.filter(isQuiet).length)}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-bai-fg">{selected.project.name}</h3>
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
    if (saved === "dashboard" || saved === "projects" || saved === "new-task" || saved === "spend" || saved === "settings") {
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
    queryFn: () => getJson<{ providers: AgentProvider[] }>("/api/agents"),
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

  const attentionCount = totals.prs + totals.ready;

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

        <nav className="mx-auto flex max-w-7xl gap-4 overflow-x-auto px-4 sm:gap-6 sm:px-6" role="tablist" aria-label="Office sections">
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

      <main
        className={`mx-auto min-h-0 w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 ${
          tab === "projects" ? "flex flex-col overflow-hidden" : "overflow-y-auto"
        }`}
      >
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
              onLogRun={openSettingsForLog}
              onNewTask={openNewTask}
            />
          )
        ) : null}

        {tab === "new-task" ? (
          <div className="mx-auto max-w-2xl space-y-5">
            {projects.length > 0 ? (
              <>
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

        {tab === "spend" ? <SpendDashboard providers={providers} /> : null}

        {tab === "settings" ? (
          <div className="mx-auto max-w-3xl space-y-10">
            <section>
              <h3 className="mb-3 text-sm font-semibold text-bai-fg">Default agent</h3>
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
