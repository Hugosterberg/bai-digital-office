# VISION.md — bai digital office

## What this product is
The control room of BAI Digital — a company where AI agents do the development
work and one human sets direction and approves what ships. Office turns GitHub
into the company's operating system: issues are the task queue, PRs are the
review queue, labels are workflow state.

## For whom
Hugo (founder/operator). Later: anyone running a portfolio of AI-built products.

## Why it wins
- **The loop is closed**: idea → build → validate → deploy → monitor → new idea,
  with a human only at the trust boundaries they choose.
- **Autonomy is a dial, not a switch**: per-project levels (manual / auto-safe /
  full) let trust grow with track record.
- **GitHub is the database**: no proprietary state to migrate, every action is
  auditable as issues, labels, comments, and PRs.

## End state (fully automated company)
1. Specialist agents generate and rank their own backlog weekly.
2. The build pipeline ships small, verified slices continuously.
3. Site monitoring feeds production reality back into the queue as incidents.
4. The human reviews exceptions (blocked tasks, sensitive diffs) — not routine work.
