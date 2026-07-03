# DECISIONS.md — bai digital office

Product-level ADRs, newest first.

## 2026-07 — Autonomy is per-project, defaulting to manual
Auto-merge is opt-in per project (`manual | auto-safe | full`) instead of a
global flag. Trust is earned per product; a marketing site can run `full`
while revenue-critical code stays `manual`. Sensitive-file and diff-size
checks only apply to `auto-safe` — `full` means the CI gate is the only gate.

## 2026-07 — Retries are bounded by labels, not memory
Failed pipelines get one automatic retry, tracked with an `attempts:N` label on
the issue itself, then park as `agent:blocked`. State lives on GitHub so it
survives worker restarts and is human-visible.

## 2026-07 — The worker is the durable host
Vercel serverless has an ephemeral filesystem; the Railway worker (with a
volume) owns runs, budgets, agent config, and the project registry. Vercel
reads state back over `GET /state` instead of duplicating storage.

## 2026-07 — Notifications are Slack-webhook, fire-and-forget
One `SLACK_WEBHOOK_URL`, plain text messages, failures logged and swallowed.
No notification infrastructure to maintain; the pipeline never blocks on it.

## 2026-06 — GitHub is the task database
Issues + labels + PRs instead of a database. Free audit trail, agents already
speak `gh`, and any tool that can label an issue can integrate with office.
