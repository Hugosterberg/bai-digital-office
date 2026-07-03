import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const queryClient = new QueryClient();
const PROVIDER_KEY = "bai-office-agent-provider";

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

const usd = (n: number) => `$${n.toFixed(2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

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

function ProjectBudgetsEditor({ budgets }: { budgets: ProjectBudgetStatus[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
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

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-bai-line bg-bai-surface/40 px-3 py-2 text-left text-sm hover:border-bai-mute/50"
      >
        <span className="font-medium text-bai-fg/90">Project budgets</span>
        <span className="text-xs text-bai-mute">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="mt-2 max-h-80 space-y-3 overflow-y-auto rounded-lg border border-bai-line bg-bai-surface/20 p-2">
          <p className="px-1 text-[11px] leading-relaxed text-bai-mute">
            Set USD caps per project. Auto-dispatch blocks when any limit is hit. Leave blank for no cap.
          </p>
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
      ) : null}
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
}: {
  selected: AgentProviderId;
  onSelect: (id: AgentProviderId) => void;
}) {
  const query = useQuery({
    queryKey: ["agents"],
    queryFn: () => getJson<{ providers: AgentProvider[] }>("/api/agents"),
  });
  const providers = query.data?.providers ?? [];

  return (
    <section className="mt-6 space-y-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Agent fleet</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-bai-mute/80">
          Pick how work runs. Only Claude Code headless dispatches from here — log other runs for cost tracking.
        </p>
      </div>
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
}: {
  projects: Project[];
  prefill?: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId } | null;
  onLogged?: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(Boolean(prefill));
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

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-bai-line bg-bai-surface/40 px-3 py-2 text-left text-sm text-bai-mute hover:border-bai-mute/50"
      >
        <span className="font-medium text-bai-fg/90">Log agent run & cost</span>
        <span className="text-xs">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <form
          className="mt-2 space-y-2 rounded-lg border border-bai-line bg-bai-surface/30 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            log.mutate();
          }}
        >
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProviderId)} className={INPUT_CLS}>
            <option value="cursor">Cursor</option>
            <option value="claude-interactive">Claude terminal</option>
            <option value="anthropic-api">Anthropic API</option>
            <option value="claude-code">Claude Code headless</option>
          </select>
          <select value={project} onChange={(e) => setProject(e.target.value)} className={INPUT_CLS}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className={INPUT_CLS}
            placeholder="Issue #"
            value={issueNumber}
            onChange={(e) => setIssueNumber(e.target.value)}
          />
          <input className={INPUT_CLS} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input
              className={INPUT_CLS}
              placeholder="Cost USD (optional)"
              value={costUsd}
              onChange={(e) => setCostUsd(e.target.value)}
            />
            <input
              className={INPUT_CLS}
              placeholder="Minutes (optional)"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
            />
          </div>
          <input className={INPUT_CLS} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
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
      ) : null}
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

  if (!spend?.runs && dispatches.length === 0) return null;

  const dot: Record<AgentRun["status"], string> = {
    running: "bg-bai-orange animate-pulse",
    done: "bg-emerald-500",
    failed: "bg-red-500",
  };

  const maxProjectSpend = Math.max(...(spend?.byProject.map((p) => p.totalUsd) ?? [1]), 1);
  const allProjects = spend?.budgets ?? [];

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Spend & activity</h2>
          <p className="mt-1 text-xs text-bai-mute">
            Per project with budget limits — see where spend goes and what is left
          </p>
        </div>
        {spend ? (
          <div className="text-right text-sm tabular-nums">
            <span className="text-bai-orange font-semibold">{usd(spend.todayUsd)}</span>
            <span className="text-bai-mute"> today · </span>
            <span className="text-bai-fg font-semibold">{usd(spend.totalUsd)}</span>
            <span className="text-bai-mute"> total · {spend.runs} runs</span>
          </div>
        ) : null}
      </div>

      {spend?.insights.topProjectToday || spend?.insights.mostExpensiveIssue ? (
        <div className="flex flex-wrap gap-2">
          {spend.insights.topProjectToday ? (
            <div className="rounded-lg border border-bai-orange/30 bg-bai-orange/5 px-3 py-2 text-xs">
              <span className="text-bai-mute">Hottest domain today · </span>
              <span className="font-medium text-bai-fg">
                {spend.insights.topProjectToday.domain ?? spend.insights.topProjectToday.name}
              </span>
              <span className="ml-2 tabular-nums text-bai-orange">{usd(spend.insights.topProjectToday.todayUsd)}</span>
            </div>
          ) : null}
          {spend.insights.mostExpensiveIssue ? (
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
                    <p className="text-[10px] text-bai-mute/60">No budget set — open Project budgets in sidebar to add limits.</p>
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
}: {
  projects: Project[];
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

  return (
    <form
      className="space-y-3 rounded-xl border border-bai-line bg-bai-surface/30 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">New task</h2>
      <select value={project} onChange={(e) => setProject(e.target.value)} className={INPUT_CLS}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.domain ? ` → ${p.domain}` : " (internal)"}
          </option>
        ))}
      </select>
      <input
        className={INPUT_CLS}
        placeholder="Title — what the feature does, one line"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={INPUT_CLS}
        rows={3}
        placeholder="Context — where this lives in the product, patterns/files to reuse"
        value={context}
        onChange={(e) => setContext(e.target.value)}
      />
      <textarea
        className={INPUT_CLS}
        rows={3}
        placeholder={"Build steps (one per line)\n1 data · 2 API · 3 UI"}
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
      />
      <textarea
        className={INPUT_CLS}
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
              Log run & cost
            </button>
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
      {merge.isSuccess ? <span className="text-[10px] text-emerald-400">Merged — deploying</span> : null}
      {merge.isError ? <span className="text-[10px] text-red-400">{(merge.error as Error).message}</span> : null}
    </div>
  );
}

function isQuiet(board: Board): boolean {
  return board.tasks.length === 0 && board.prs.length === 0;
}

function PortfolioOverview({ boards, spend }: { boards: Board[]; spend?: SpendSummary }) {
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
            onClick={() =>
              document.getElementById(`project-${board.project.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
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

function QuietProjectRow({ board, onNewTask, spend }: { board: Board; onNewTask: (id: string) => void; spend?: SpendSummary }) {
  const pSpend = projectSpend(spend, board.project.id);
  return (
    <div
      id={`project-${board.project.id}`}
      className="scroll-mt-4 flex flex-wrap items-center gap-3 rounded-md border border-bai-line/70 bg-bai-surface/40 px-3 py-2"
    >
      <DomainBadge domain={board.project.domain} repo={board.project.repo} size="xs" />
      <span className="text-sm font-medium text-bai-fg/90">{board.project.name}</span>
      {pSpend && pSpend.totalUsd > 0 ? <SpendPill amount={pSpend.totalUsd} label="spent" tone="mute" /> : null}
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

function ProjectBoard({
  board,
  provider,
  providers,
  spend,
  onLogRun,
}: {
  board: Board;
  provider: AgentProviderId;
  providers: AgentProvider[];
  spend?: SpendSummary;
  onLogRun: (prefill: { projectId: string; issueNumber: number; title: string; provider: AgentProviderId }) => void;
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
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-bai-line/80 bg-bai-surface/20 px-3 py-2.5">
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
        {budget ? (
          <div className="w-full sm:w-64 shrink-0">
            <ProjectBudgetCard budget={budget} />
          </div>
        ) : null}
      </div>

      {board.prs.length > 0 ? (
        <div className="rounded-lg border border-bai-orange/40 bg-bai-orange/5 p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-bai-orange">
            Awaiting your review — ships to {board.project.domain ?? "main (no domain linked)"}
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

/* ── shell ───────────────────────────────────────────────────── */

function BaiDigitalOffice() {
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
  const boards = boardQuery.data?.boards ?? [];
  const activeBoards = boards.filter((b) => !isQuiet(b));
  const quietBoards = boards.filter(isQuiet);
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

  return (
    <div className="min-h-screen bg-bai-bg text-bai-fg">
      <header className="border-b border-bai-line bg-bai-surface/20">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              bai digital <span className="text-bai-orange">office</span>
            </h1>
            <p className="text-xs text-bai-mute">
              Task → agent builds PR → you approve → Vercel ships. Track spend across Claude, Cursor, and API.
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs tabular-nums">
            {boards.length > 0 ? (
              <>
                <span className="rounded-full border border-bai-line px-2.5 py-1 text-bai-orange">{totals.ready} ready</span>
                <span className="rounded-full border border-bai-line px-2.5 py-1 text-bai-metal">{totals.building} building</span>
                <span
                  className={
                    totals.prs > 0
                      ? "rounded-full bg-bai-orange px-2.5 py-1 font-semibold text-bai-bg"
                      : "rounded-full border border-bai-line px-2.5 py-1 text-bai-mute"
                  }
                >
                  {totals.prs} awaiting review
                </span>
              </>
            ) : null}
            {spend ? (
              <span className="rounded-full border border-bai-orange/30 bg-bai-orange/10 px-2.5 py-1 text-bai-orange">
                {usd(spend.todayUsd)} today · {usd(spend.totalUsd)} total
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl grid-cols-1 items-start gap-8 p-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {projectsQuery.data ? (
            projectsQuery.data.github ? (
              <>
                <NewTaskForm
                  projects={projectsQuery.data.projects}
                  selectedProject={formProject}
                  onProjectChange={setFormProject}
                />
                <AgentFleetPanel selected={provider} onSelect={setProvider} />
                <LogRunForm
                  projects={projectsQuery.data.projects}
                  prefill={logPrefill}
                  onLogged={() => setLogPrefill(null)}
                />
                {spend?.budgets ? <ProjectBudgetsEditor budgets={spend.budgets} /> : null}
              </>
            ) : (
              <p className="text-sm text-bai-orange">
                Set <code>GITHUB_TOKEN</code> in <code>.env.local</code> (repo scope) and restart the server.
              </p>
            )
          ) : (
            <p className="text-sm text-bai-mute">Loading projects…</p>
          )}
        </aside>

        <div className="space-y-10 min-w-0">
          {boardQuery.isLoading ? <p className="text-sm text-bai-mute">Loading board…</p> : null}
          {boardQuery.isError ? <p className="text-sm text-red-400">{(boardQuery.error as Error).message}</p> : null}

          <SpendDashboard providers={providers} />

          {boards.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-bai-mute">Portfolio</h2>
              <PortfolioOverview boards={boards} spend={spend} />
            </div>
          ) : null}

          {activeBoards.map((board) => (
            <ProjectBoard
              key={board.project.id}
              board={board}
              provider={provider}
              providers={providers}
              spend={spend}
              onLogRun={setLogPrefill}
            />
          ))}

          {quietBoards.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-bai-mute">
                Quiet projects — no agent activity yet
              </h2>
              {quietBoards.map((board) => (
                <QuietProjectRow key={board.project.id} board={board} onNewTask={setFormProject} spend={spend} />
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
      <BaiDigitalOffice />
    </QueryClientProvider>
  );
}
