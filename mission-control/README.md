# Mission Control

BAI Digital's cockpit for the agent workforce: **write a well-described task →
it becomes a GitHub issue labeled `agent:ready` → an agent picks it up →
you review the PR.** No database — GitHub Issues are the queue, PRs are the
review surface.

## The task lifecycle

| Stage | Meaning | Who moves it |
|---|---|---|
| `agent:ready` | Described with done-criteria, waiting | Created here |
| `agent:building` | An agent claimed it | The agent |
| `agent:review` | PR open (`Closes #N`) — awaiting Hugo | The agent |
| closed | PR merged | GitHub, on merge |

Agents pick up work with:

```bash
gh issue list --repo <owner/repo> --label agent:ready
```

Each issue body carries the company task template (Context / Build steps /
Done when) plus the agent contract — everything an agent needs to build the
slice and open a compliant PR.

## Run

1. `cp .env.example .env.local` and set `GITHUB_TOKEN` (fine-grained PAT:
   Issues read/write + Pull requests read on the portfolio repos).
2. `npm install` → `npm run dev` (UI on :8080, API on :3001).

Projects shown on the board are defined in `server/lib/projects.ts` —
mirror of [bai-digital-office/ai/PORTFOLIO.md](https://github.com/bai-digital-office/ai/blob/main/PORTFOLIO.md).

## Deploy note

v0 is a local/internal tool. If deployed, put it behind auth first — the
server holds a GitHub token.
