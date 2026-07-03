# bai digital office

The agent cockpit at [office.baidigital.xyz](https://office.baidigital.xyz) —
styled after [baidigital.xyz](https://baidigital.xyz) (near-black `#050505`, warm off-white
`#f5f2ea`, orange accent `#f7931a`, Geist type — see the `bai` palette in
`tailwind.config.ts`).

Write a well-described task → it becomes a GitHub issue labeled `agent:ready` →
a hosted worker picks it up → you review the PR. No database — GitHub Issues are the
queue, PRs are the review surface.

## Architecture (two services)

| Service | Host | Role |
|---|---|---|
| **UI + API** | Vercel | Board, create tasks, merge PRs, spend/budgets |
| **Agent worker** | Railway (always-on) | Polls GitHub, runs `claude -p`, builds PRs |

Vercel cannot run agents (no Claude CLI, no background process). The worker runs 24/7 in the cloud.

```
You → office.baidigital.xyz → GitHub issue (agent:ready)
                                    ↓
              Railway worker → claude -p → PR → you approve in office
```

## Deploy Vercel (UI)

1. Import repo — **Root Directory** = `office`, preset **Other**.
2. Environment variables:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT (Issues + PRs + merge) |
| `OFFICE_SECRET` | Random secret (`openssl rand -hex 32`) |
| `DISPATCH_DISABLED` | `true` |
| `AGENT_POLL_ENABLED` | `false` |
| `WORKER_WEBHOOK_URL` | `https://<your-worker>.up.railway.app/poll` |
| `WORKER_SECRET` | Same secret as on Railway worker |

3. DNS → `office.baidigital.xyz`

## Deploy Railway (agents)

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub → repo `bai-digital-office`.
2. Service **`bai-digital-office`** → **Settings → Root Directory** = `office` (**important**).
3. **Settings → Build** → Builder: **Dockerfile** → path: `Dockerfile.worker`  
   (If Root Directory is blank/repo root, use root `Dockerfile.worker` instead — Railpack will fail without a start script.)
4. Generate a public domain (Settings → Networking).
5. Environment variables:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Same as Vercel |
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) — powers headless Claude Code |
| `WORKER_SECRET` | Random secret — must match Vercel |
| `DISPATCH_DISABLED` | `false` |
| `AGENT_POLL_ENABLED` | `true` |
| `AGENT_POLL_INTERVAL_MS` | `90000` |

6. Copy the public URL → set `WORKER_WEBHOOK_URL=https://…/poll` on Vercel → redeploy Vercel.

**Optional:** mount a Railway volume at `/app/server/data` to persist agent spend logs and project budgets across redeploys.

### Verify worker

```bash
curl https://YOUR-WORKER.up.railway.app/health
# → {"ok":true,"service":"bai-agent-worker"}
```

Create a task on office.baidigital.xyz — within seconds the worker should pick it up (webhook) or within 90s (poll).

## Run locally (development)

1. `cp .env.example .env.local` — set `GITHUB_TOKEN`.
2. `npm install` → `npm run dev` (UI :8080, API :3001).
3. Optional: `npm run worker` in another terminal (or rely on hosted Railway worker).

## Approve → production

Open PRs show on the board with CI status. Click **Approve → prod** to squash-merge
to `main`. Vercel deploys production when each product repo is linked.

Projects are defined in `server/lib/projects.ts` —
mirror of [bai-digital-office/ai/PORTFOLIO.md](https://github.com/bai-digital-office/ai/blob/main/PORTFOLIO.md).
