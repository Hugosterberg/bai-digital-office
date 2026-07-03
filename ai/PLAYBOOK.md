# Playbook — how work happens at BAI Digital

## The feature loop (all repos)

1. **Describe** — a feature is written as a well-described task: what it does,
   what done looks like (3–6 checkable criteria), which slice it lives in.
2. **Build** — an agent (Claude Code session, CMA worker, Cursor) implements
   the whole vertical slice on a branch named `feat/<feature-description-like-this>`.
3. **Verify** — the repo's verify suite (typecheck, lint, tests, build) must
   be green, and the change observed working, before a PR is opened.
4. **PR** — the agent (or its operator) opens a GitHub PR: title + what/why +
   files touched + how verified. Agent co-authorship is credited in commits
   (`Co-Authored-By: <agent> <noreply@anthropic.com>`).
5. **Review & merge** — Hugo (or a designated human) reviews in the GitHub UI,
   checks the Vercel preview deploy, and merges. Merge = production deploy.

## Hard rules

- Agents never push to `main`. Branch protection enforces PR + review.
- No invented APIs, env vars, or DB fields — verify against the repo first.
- Tenant/data isolation rules of each product are inviolable (see the
  product repo's ai/ARCHITECTURE.md).
- Secrets never appear in code, chat, or PR bodies. Domain env vars follow a
  domain move; service env vars (Supabase URLs, API keys) never do.
- Every new repo starts from `template-webapp` so the loop above works from
  day 1.

## Definition of done (company default)

- Verify suite green (typecheck server+client, lint, tests, build).
- The change demonstrated in the running app (or its output graded against
  the task's criteria).
- The repo's ai/-docs updated if architecture, roadmap, or decisions changed.
- PR text complete enough that a reviewer needs nothing else.

## Repo topology

- `bai-digital-office/ai` — this brain. `bai-digital-office/.github` — org defaults.
- `bai-digital-office/template-webapp` — the starter every product is born from.
- One repo per product/venture; its own Vercel project and (if needed) its
  own Supabase project. Watertight bulkheads between products.
- **Where a repo actually lives is defined in [PORTFOLIO.md](./PORTFOLIO.md)**
  — some existing repos remain on the personal account (`Hugosterberg/*`) to
  keep their deploy chains untouched. Always navigate from PORTFOLIO, never
  assume the org owns a repo.
