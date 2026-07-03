# AGENTS.md

## Project overview
A BAI Digital product built from `template-webapp`. React 19 + Vite SPA with
an Express API, built as vertical slices by AI agents and reviewed by humans.

Company-level context (vision, playbook, portfolio) lives in
[github.com/bai-digital-office/ai](https://github.com/bai-digital-office/ai) — read the
PLAYBOOK there first. Product-level context lives in [ai/](./ai/README.md).

## How work happens here
- Features are built as **vertical slices**: UI in `src/features/<name>/`
  (+ page), API route in `server/`, data migration if needed.
- Work happens on **`feat/<feature-description-like-this>` branches**; every
  change reaches `main` through a PR reviewed by a human. Never push to main.
- **Definition of done:** `npm run verify` green (typecheck, lint, tests,
  build) AND the change observed working in the running app AND the ai/ docs
  updated when architecture/roadmap/decisions changed.

## Engineering rules
- Reliability over cleverness; smallest safe diff; reuse before rebuilding.
- Never invent libraries, APIs, env vars, or DB fields — verify they exist.
- Handle loading, empty, error, and success states explicitly.
- Isolate provider-specific logic in dedicated modules.
- Secrets never in code, chat, or PR bodies.
- Automation flows must be idempotent: no duplicate sends/posts/executions.
