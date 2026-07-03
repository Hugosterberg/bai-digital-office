# ARCHITECTURE.md — bai digital office

## Stack
- **UI**: React 19 + Vite SPA (`src/App.tsx`), Tailwind with `bai-*` tokens.
- **API**: Express (`server/server.ts`) — served by Vercel serverless
  (`api/index.mjs`) in production, or directly in local dev.
- **Worker**: always-on Node HTTP service (`server/worker.ts`) on Railway —
  runs headless Claude Code (`claude -p`), site monitoring, and the auto-cycle.

## Deployment split
| Host | Role | Key env |
|---|---|---|
| Vercel | UI + API, no agent execution | `DISPATCH_DISABLED=true`, `WORKER_WEBHOOK_URL`, `OFFICE_SECRET` |
| Railway | 24/7 agents, monitor, cycle, durable data | `DISPATCH_DISABLED=false`, `AGENT_POLL_ENABLED=true`, `SITE_MONITOR_ENABLED`, `AUTO_CYCLE_ENABLED`, volume at `/app/server/data` |

Vercel forwards to the worker via `server/lib/workerWebhook.ts`
(`/poll`, `/config`, `/budgets`, `/projects`, `/specialist/:id`, `/cycle`) and
reads durable state back via `GET /state` (runs, spend, site checks).

## State model — GitHub is the store
- Task = issue labeled `agent` + one stage label:
  `agent:idea → agent:ready → agent:analyzing → agent:implementing →
  agent:validating → agent:review → done (closed)`, plus `agent:blocked`
  (failed ≥ AGENT_MAX_ATTEMPTS times) and `attempts:N` (retry counter).
- Review queue = open PRs; completion = squash-merge with `Closes #N`.

## Local persistence (`server/data/`, Railway volume)
| File | Contents |
|---|---|
| `agent-runs.jsonl` | Append-only run log (cost, duration, stages) |
| `project-budgets.json` | Per-project USD caps |
| `agent-team.json` | Pipeline + specialist agent settings |
| `projects.json` | Runtime project registry incl. autonomy levels |
| `auto-cycle.json` | Weekly cycle state (round-robin position, history) |

## Key modules (`server/lib/`)
- `dispatch.ts` — 3-stage pipeline orchestration, retry/blocked policy,
  server-side `agent:review` guarantee, auto-merge trigger.
- `autoMerge.ts` — autonomy policy (manual / auto-safe / full), CI wait,
  diff-size + sensitive-file checks, post-deploy verification.
- `siteMonitor.ts` — domain probes, incident issues (deduped), recovery close.
- `autoCycle.ts` — growth agent → prioritizer agent → auto-promote best idea.
- `notify.ts` — Slack webhook events (fire-and-forget).
- `claude.ts` — shared `claude -p` runner.
- `github.ts` — REST client: tasks, PRs, labels, merge, incident issues.
- `projects.ts` — registry (file-backed, seeded with defaults).

## Invariants
- Agents never push to `main`; everything lands via PR.
- `mergePullRequest` refuses drafts, conflicts, and non-green CI — auto-merge
  reuses the same gate.
- Budget caps block dispatch before an agent starts, never mid-run.
- Max 3 concurrent pipelines; max `AGENT_MAX_ATTEMPTS` (2) tries per issue.
- Notifications and worker pings are fire-and-forget: their failure never
  breaks the pipeline.
