# Portfolio — every BAI Digital project

_One row per project. Status: idea / building / live / parked. Last updated: 2026-07-03._

> **Repo locations:** existing repos stay on the personal account
> (`Hugosterberg/*`) for now — deliberately, to avoid re-linking Vercel and
> Supabase (see DECISIONS.md). New repos are created under the `bai-digital-office`
> org. **Agents: navigate from this table, never from assumptions.**

| Project | Status | Repo | Local path | Domain | Stack | Notes |
|---|---|---|---|---|---|---|
| **automazing** | live | [Hugosterberg/automazing-flow](https://github.com/Hugosterberg/automazing-flow) | `c:\Code\automazing-flow` | [automazing.life](https://automazing.life) | React 19 + Vite, Express, Supabase, Vercel | First product: life/business automation SaaS. 16 MCP providers; CMA agent `bai-repo-engineer`. |
| **baidigital-site** | live | [Hugosterberg/bai-digital](https://github.com/Hugosterberg/bai-digital) | — | [baidigital.xyz](https://baidigital.xyz) | TypeScript, Vercel | The agency site. Org name is `bai-digital-office`, so no name clash. |
| **bitcoinlivet** | building | [Hugosterberg/bitcoinlivet](https://github.com/Hugosterberg/bitcoinlivet) | `c:\Code\bitcoinlivet` | — | Next.js (TS) | Bitcoin leg: content/product around living on bitcoin. |
| **bra-erbjudanden** | building | [Hugosterberg/bra-erbjudanden](https://github.com/Hugosterberg/bra-erbjudanden) | `c:\Code\bra-erbjudanden` | braerbjudanden.se | Next.js + TS + Supabase | Swedish affiliate/deals platform. |
| **smilo** | live | [Hugosterberg/smilo](https://github.com/Hugosterberg/smilo) | — | [smilo-flame.vercel.app](https://smilo-flame.vercel.app) | TypeScript, Vercel | — |
| **pump** | building | [Hugosterberg/pump](https://github.com/Hugosterberg/pump) | `c:\Code\pump` | — | Portal/site | "Portable Utilities Made Perfect" — product brand. |
| **pump-shopify** | building | [Hugosterberg/pump-shopify](https://github.com/Hugosterberg/pump-shopify) | `c:\Code\pump-shopify` | — | Shopify theme (Liquid) | Pump's storefront theme. |
| **los-tios** | parked | [Hugosterberg/los-tios](https://github.com/Hugosterberg/los-tios) | `c:\Code\los-tios` | — | Vite + React | Los Tios. |
| **mission-control** | building | `bai-digital-office/mission-control` (local until org exists) | `c:\Code\bai-digital-office\mission-control` | local tool | React + Express over GitHub API | Agent cockpit: task queue = GitHub Issues, review board = PRs. |
| **bai-repo-engineer** (CMA agent) | live | agent folder `c:\Code\launch-your-agent\my-agent` | see left | — | Anthropic CMA (workspace `automazing`) | First AI employee; rubric-graded. |
| **invest** | idea | `bai-digital-office/invest` (from template-webapp) | — | — | TBD | Investment leg; LunarCrush/Quartr MCP. |

## For agents: how to reach a project

1. Find its row above → clone/open the **Repo** (or the local path on Hugo's
   machine).
2. Read that repo's `AGENTS.md` + `ai/` folder if present; older repos may
   lack them — then the company PLAYBOOK still applies in full.
3. Deliver on a `feat/<slug>` branch → PR → Hugo reviews and merges.
4. The task queue per repo: issues labeled `agent:ready` (see mission-control).

## Adding a project

1. Create the repo from `bai-digital-office/template-webapp` ("Use this template").
2. Add its row here AND to `mission-control/server/lib/projects.ts`.
3. Create its Vercel project (+ Supabase project if it has data).
4. Point its `ai/README.md` back to this brain.
