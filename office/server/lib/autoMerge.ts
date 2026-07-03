/**
 * Conditional auto-merge — closes the loop after a successful pipeline.
 *
 * Per-project autonomy (projects.ts):
 *   manual    — never auto-merge (default)
 *   auto-safe — merge when CI is green, diff is small, and no sensitive files changed
 *   full      — merge when CI is green
 *
 * All merges reuse mergePullRequest(), which already blocks on drafts,
 * conflicts, and non-green CI.
 */

import {
  findOpenPrForIssue,
  getPullRequestDetail,
  listPullRequestFiles,
  mergePullRequest,
  commentOnIssue,
} from "./github.ts";
import { findProjectByRepo, projectAutonomy } from "./projects.ts";
import { notify } from "./notify.ts";
import { verifyDomainAfterDeploy } from "./siteMonitor.ts";

const MAX_SAFE_DIFF_LINES = Number(process.env.AUTO_MERGE_MAX_LINES) || 400;
const CI_WAIT_ATTEMPTS = 20;
const CI_WAIT_INTERVAL_MS = 30_000;

/** Files where a bad change can break auth, CI, billing, or the deploy itself. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.github\//,
  /(^|\/)Dockerfile/i,
  /(^|\/)(vercel|railway)\.(json|toml)$/,
  /(^|\/)\.env/,
  /(^|\/)(auth|secret|token|billing|payment)[^/]*\.(ts|js|tsx|jsx)$/i,
  /package(-lock)?\.json$/,
];

function sensitiveFiles(files: Array<{ filename: string }>): string[] {
  return files.map((f) => f.filename).filter((name) => SENSITIVE_PATTERNS.some((p) => p.test(name)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Try to auto-merge the PR belonging to a finished pipeline.
 * Fire-and-forget: waits for CI, applies the project's autonomy policy,
 * merges, and verifies the deployed domain. Never throws.
 */
export async function maybeAutoMerge(repo: string, issueNumber: number, title: string): Promise<void> {
  try {
    const project = findProjectByRepo(repo);
    const autonomy = projectAutonomy(project);
    if (autonomy === "manual") return;

    const pr = await findOpenPrForIssue(repo, issueNumber);
    if (!pr) return;

    // Wait for CI to settle (checks usually start seconds after the PR opens).
    let detail = null;
    for (let i = 0; i < CI_WAIT_ATTEMPTS; i++) {
      detail = await getPullRequestDetail(repo, pr.number);
      if (!detail || detail.merged) return;
      if (detail.checks.state === "success") break;
      if (detail.checks.state === "failure") {
        await commentOnIssue(
          repo,
          issueNumber,
          `Auto-merge skipped — CI failed on PR #${pr.number}. Review manually in office.`
        );
        return;
      }
      // pending or unknown (checks not registered yet) — wait and re-check
      await sleep(CI_WAIT_INTERVAL_MS);
    }
    if (!detail || detail.checks.state !== "success") {
      await commentOnIssue(
        repo,
        issueNumber,
        `Auto-merge skipped — CI did not turn green within ${Math.round((CI_WAIT_ATTEMPTS * CI_WAIT_INTERVAL_MS) / 60000)} minutes on PR #${pr.number}.`
      );
      return;
    }

    if (autonomy === "auto-safe") {
      const files = await listPullRequestFiles(repo, pr.number);
      const totalLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
      const sensitive = sensitiveFiles(files);
      if (totalLines > MAX_SAFE_DIFF_LINES || sensitive.length > 0) {
        const reason =
          sensitive.length > 0
            ? `touches sensitive files (${sensitive.slice(0, 5).join(", ")})`
            : `diff is ${totalLines} lines (limit ${MAX_SAFE_DIFF_LINES})`;
        await commentOnIssue(
          repo,
          issueNumber,
          `Auto-merge held for human review — ${reason}. Approve PR #${pr.number} in office.`
        );
        return;
      }
    }

    const result = await mergePullRequest(repo, pr.number);
    if (!result.ok) {
      await commentOnIssue(repo, issueNumber, `Auto-merge attempt failed: ${result.message}`);
      return;
    }

    await commentOnIssue(
      repo,
      issueNumber,
      `**Auto-merged** PR #${pr.number} to main (autonomy: ${autonomy}, CI green). Post-deploy verification will run shortly.`
    );
    void notify({
      kind: "auto-merged",
      repo,
      prNumber: pr.number,
      title,
      domain: project?.domain,
    });

    if (project?.domain) {
      void verifyDomainAfterDeploy(project);
    }
  } catch (err) {
    console.warn(`[auto-merge] ${repo}#${issueNumber} failed:`, err instanceof Error ? err.message : err);
  }
}
