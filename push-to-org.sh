#!/usr/bin/env bash
# One-shot: create the three org repos on GitHub and push the local scaffold.
# Prereq: the GitHub organization "bai-digital-office" exists and you own it.
# Run from anywhere: bash /c/Code/bai-digital-office/push-to-org.sh
set -euo pipefail
ORG="bai-digital-office"
BASE="$(cd "$(dirname "$0")" && pwd)"

push_repo() { # <local-dir> <repo-name> <description>
  local dir="$1" name="$2" desc="$3"
  cd "$BASE/$dir"
  # The umbrella phase flattens inner .git dirs — re-init per repo here.
  if [ ! -d .git ]; then
    git init -q -b main && git add -A && git commit -q -m "initial import from the bai-digital-office umbrella repo"
  fi
  if ! gh repo view "$ORG/$name" >/dev/null 2>&1; then
    gh repo create "$ORG/$name" --private --description "$desc"
  fi
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$ORG/$name.git"
  git push -u origin main
  echo "✓ $ORG/$name"
}

push_repo ai ai "Company brain: vision, playbook, portfolio, agent definitions"
push_repo dot-github ".github" "Org defaults: PR template, workflow templates, profile"
push_repo template-webapp template-webapp "Product starter: React+Vite+Express, vertical slices, agent workflow prewired"
push_repo mission-control mission-control "Agent cockpit: task queue over GitHub Issues + human review board"

# Mark the starter as a template repo + protect its main branch.
gh api -X PATCH "repos/$ORG/template-webapp" -f is_template=true >/dev/null && echo "✓ template flag set"
gh api -X PUT "repos/$ORG/template-webapp/branches/main/protection" \
  --input - >/dev/null <<'JSON' && echo "✓ branch protection on template-webapp/main"
{
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "required_status_checks": null,
  "enforce_admins": false,
  "restrictions": null
}
JSON

echo
echo "Done. Existing repos (Hugosterberg/automazing-flow) stay put by decision —"
echo "see ai/DECISIONS.md. PORTFOLIO.md maps every project to its real location."
