# template-webapp

BAI Digital's product starter: React 19 + Vite + TypeScript + Tailwind SPA,
Express 5 API (Node 22, type-stripped TS), Vitest, ESLint, and the agent
workflow prewired (AGENTS.md, ai/ context folder, verify pipeline, PR flow).

## Start a new product

1. GitHub → **Use this template** → create `bai-digital-office/<product>`.
2. `npm install` → `npm run dev` (SPA on :8080, API on :3001).
3. Rename `bai-webapp` in `package.json` + `index.html`.
4. Fill in `ai/` (VISION, ARCHITECTURE, ROADMAP, DECISIONS).
5. Add the product to [bai-digital-office/ai/PORTFOLIO.md](https://github.com/bai-digital-office/ai/blob/main/PORTFOLIO.md).
6. Create the Vercel project (root = repo), and a Supabase project if it has data.
7. Protect `main`: require PR + 1 review. CODEOWNERS is prewired to @Hugosterberg.

## Scripts

`dev` · `build` · `test` · `lint` · `typecheck` · **`verify`** (all of the
above — must be green before any PR).
