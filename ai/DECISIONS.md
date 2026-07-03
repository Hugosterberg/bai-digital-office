# Decisions — company-level ADRs

_Newest first. Status: Active / Proposed / Reversed._

## 2026-07-03 — Existing repos stay on the personal account for now — **Active**

`Hugosterberg/automazing-flow` (and its Vercel + Supabase links) stays where
it is: transferring would force re-linking the deploy chain for zero product
value today. The org owns everything NEW (`ai`, `.github`, `template-webapp`,
future products). PORTFOLIO.md is the single source of truth for where each
repo actually lives — agents navigate from there, never from assumptions.
Revisit the transfer when there's a second human or a real need for org-level
access control.

## 2026-07-03 — Polyrepo under one GitHub org — **Active**

One repo per product under `github.com/bai-digital-office`; no monorepo. Rationale:
products deploy independently (one Vercel project per repo, own Supabase),
secrets and blast radius stay separated, and **AI agents perform better in
small, focused repos**. Shared code is extracted to a package only on the
third duplication. The org also hosts `ai` (company brain), `.github`
(org defaults), and `template-webapp` (product starter).

## 2026-07-03 — Human-gated PR flow is the only path to main — **Active**

Agents deliver on `feat/<slug>` branches and open PRs; Hugo reviews in the
GitHub UI (with Vercel preview) and merges. Branch protection enforces it.
Raw diffs/patch files are never a human review surface.

## 2026-07-03 — automazing is a BAI Digital product — **Active**

automazing (automazing.life) is built by BAI Digital and will be sold as
SaaS (B2B and B2C subscription). Its product-level context lives in its own
repo's ai/ folder; this repo holds only the company view.
