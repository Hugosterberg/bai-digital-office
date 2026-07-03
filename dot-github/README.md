# .github — org defaults for bai-digital-office

Repos in this org inherit from here unless they override locally:

- `profile/README.md` — the org's public profile page.
- `PULL_REQUEST_TEMPLATE.md` — default PR template (the review surface is the
  PR body; agents fill it from their PR.md).
- `workflow-templates/` — starter GitHub Actions (verify on PR).

Per-repo (not inheritable, set in each repo): branch protection on `main`
(require PR + 1 review), CODEOWNERS (`* @Hugosterberg`).
