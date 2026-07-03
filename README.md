# bai-digital-office

BAI Digital's company infrastructure — the operating system for a company of
AI agents with human review gates. One umbrella repo for now; each top-level
folder becomes its own repo under the `bai-digital-office` GitHub org when
the org is created (`push-to-org.sh` does the split).

| Folder | What it is |
|---|---|
| [`ai/`](./ai/README.md) | **The company brain**: vision, playbook (how agents work), portfolio (where every repo lives), decisions, agent roles. Agents read this first. |
| [`mission-control/`](./mission-control/README.md) | **The cockpit**: write well-described tasks → GitHub issues labeled `agent:ready` → agents build → PR review board. |
| [`template-webapp/`](./template-webapp/README.md) | **The product starter**: React+Vite+Express with vertical slices, AGENTS.md, ai/ folder, verify CI and PR flow prewired. |
| [`dot-github/`](./dot-github/README.md) | Org defaults (PR template, workflow templates, org profile) — activates when pushed as the org's `.github` repo. |
| `push-to-org.sh` | Splits this umbrella into per-repo org repos once the org exists. |

## The operating loop

1. Hugo writes a task in **mission-control** (context, build steps,
   done-criteria) → it becomes an `agent:ready` issue in the target repo.
2. An agent picks it up (`gh issue list --label agent:ready`), builds the
   vertical slice on a `feat/<slug>` branch per the **PLAYBOOK**, keeps the
   verify suite green.
3. The agent opens a PR (`Closes #N`) → Hugo reviews in GitHub → merge deploys.

Everything an agent needs to know starts in [`ai/README.md`](./ai/README.md).
