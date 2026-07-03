# bai digital office

The agent cockpit at [baidigital.office.xyz](https://baidigital.office.xyz) —
styled after [baidigital.xyz](https://baidigital.xyz) (near-black `#050505`, warm off-white
`#f5f2ea`, orange accent `#f7931a`, Geist type — see the `bai` palette in
`tailwind.config.ts`).

Write a well-described task → it becomes a GitHub issue labeled `agent:ready` →
an agent picks it up → you review the PR. No database — GitHub Issues are the
queue, PRs are the review surface.

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

## Run locally

1. `cp .env.example .env.local` and set `GITHUB_TOKEN` (Issues + PRs read/write + merge on portfolio repos).
2. `npm install` → `npm run dev` (UI on :8080, API on :3001).
3. Ensure **Claude Code** is logged in (`claude`) and **GitHub CLI** (`gh auth login`) — agents use your platform.claude.com credits.

### Auto agent pickup

Set `AGENT_POLL_ENABLED=true` in `.env.local` — the API polls every 90s for
`agent:ready` issues and dispatches headless `claude -p` runs (max 3 concurrent).

Or run a dedicated worker:

```bash
npm run worker
```

## Approve → production

Open PRs show on the board with CI status. Click **Approve → prod** to squash-merge
to `main`. Vercel deploys production automatically when each product repo is linked.

## Deploy (baidigital.office.xyz)

1. Deploy this folder (`office/`) to Vercel — set **Root Directory** to `office` in the repo import.
2. Env vars: `GITHUB_TOKEN`, `OFFICE_SECRET`, `DISPATCH_DISABLED=true` (Vercel has no Claude CLI).
3. Point DNS `baidigital.office.xyz` at the Vercel project.
4. Run `npm run worker` on your machine (or a small VPS) for agent dispatch — the UI and merge API work from Vercel.

Projects shown on the board are defined in `server/lib/projects.ts` —
mirror of [bai-digital-office/ai/PORTFOLIO.md](https://github.com/bai-digital-office/ai/blob/main/PORTFOLIO.md).
