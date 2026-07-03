# ROADMAP.md — bai digital office

## Shipped
- Kanban over GitHub Issues for the whole portfolio (labels = stages).
- Three-agent build pipeline (analyze → implement → validate) as headless
  Claude Code, auto-picked from `agent:ready` by the Railway worker.
- Specialist agents (growth, research) creating `agent:idea` issues; promote /
  dismiss from the UI.
- Spend tracking per project/provider/issue with budget caps that block dispatch.
- Agent settings UI (models, roles, enabled) synced Vercel → worker.
- Retry policy: 1 automatic retry, then `agent:blocked` + human unblock button.
- Server-side `agent:review` guarantee after a green pipeline.
- Slack notifications (PR ready, failures, blocked, incidents, auto-merges).
- Per-project autonomy: manual / auto-safe (CI + small diff + no sensitive
  files) / full — with post-deploy domain verification.
- Site monitor: probes all domains, opens/closes incident issues automatically.
- Weekly auto-cycle: growth ideas → prioritizer promotes the best to the queue.
- Runtime project registry (add/remove projects without deploying).

## v-next
- Read durable state from the worker everywhere (spend page badge for source).
- Founder agent: one-line idea → new repo from template-webapp → first task.
- Auto-generate missing `ai/` docs (VISION etc.) per portfolio repo.
- Cost-aware prioritizer (weigh budget remaining into idea ranking).
- Lighthouse / console-error checks in the site monitor.

## Parked
- Cursor Cloud Agents as a second dispatchable provider.
- External database (Postgres) — revisit if the Railway volume becomes limiting.
