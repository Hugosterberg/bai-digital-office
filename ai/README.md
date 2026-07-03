# bai-digital-office/ai — the company brain

This repo is the **org-wide context for every AI agent and human** working in
any BAI Digital repository. Product repos carry their own `ai/` folder for
product context; this repo is the level above — the company.

**Every agent working in any bai-digital-office repo reads, in order:**
1. This repo: [VISION.md](./VISION.md) → [PLAYBOOK.md](./PLAYBOOK.md)
2. The product repo's `AGENTS.md` (engineering rules)
3. The product repo's `ai/` folder (product context)

| File | What it holds | Update when |
|---|---|---|
| [VISION.md](./VISION.md) | What BAI Digital is and where it's going | Founder-owned; rare |
| [PLAYBOOK.md](./PLAYBOOK.md) | How work happens: slices, PR flow, definition of done | The process itself changes |
| [PORTFOLIO.md](./PORTFOLIO.md) | Every project: status, repo, domain, stack | A project starts, ships, or is parked |
| [DECISIONS.md](./DECISIONS.md) | Company-level ADRs | A company-wide decision is made |
| [agents/](./agents/) | Reusable agent definitions and prompts | An agent role is added or refined |

Keeping this repo true is part of every project's definition of done —
stale company context is worse than none.
