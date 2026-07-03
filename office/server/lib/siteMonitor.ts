/**
 * Site monitor — the company's eyes on its own products.
 *
 * Periodically checks every project domain (HTTP status + response time).
 * On failure: opens a high-priority agent:ready incident issue (deduped).
 * On recovery: closes the incident issue and notifies.
 *
 * Also used post-auto-merge to verify a deploy did not take the site down.
 */

import {
  createAgentIssue,
  findOpenIssueByTitlePrefix,
  closeIssueWithComment,
  githubConfigured,
} from "./github.ts";
import { listProjects, type Project } from "./projects.ts";
import { notify } from "./notify.ts";

const CHECK_TIMEOUT_MS = 15_000;
/** Consecutive failures before an incident is opened (rides out blips). */
const FAILURES_BEFORE_INCIDENT = 2;
/** Post-deploy: wait for Vercel to build before probing. */
const POST_DEPLOY_DELAY_MS = Number(process.env.POST_DEPLOY_DELAY_MS) || 180_000;

const INCIDENT_TITLE_PREFIX = "[Incident] Site check failed:";

interface SiteStatus {
  projectId: string;
  domain: string;
  ok: boolean;
  httpStatus?: number;
  responseMs?: number;
  error?: string;
  checkedAt: string;
}

const lastStatus = new Map<string, SiteStatus>();
const consecutiveFailures = new Map<string, number>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function listSiteStatuses(): SiteStatus[] {
  return [...lastStatus.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

async function probe(domain: string): Promise<Omit<SiteStatus, "projectId" | "domain">> {
  const started = Date.now();
  try {
    const res = await fetch(`https://${domain}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { "User-Agent": "bai-office-monitor/1.0" },
    });
    return {
      ok: res.ok,
      httpStatus: res.status,
      responseMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      responseMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function openIncident(project: Project, status: Omit<SiteStatus, "projectId" | "domain">): Promise<void> {
  const prefix = `${INCIDENT_TITLE_PREFIX} ${project.domain}`;
  const existing = await findOpenIssueByTitlePrefix(project.repo, prefix);
  if (existing) return;

  const detail = status.httpStatus ? `HTTP ${status.httpStatus}` : (status.error ?? "no response");
  const result = await createAgentIssue({
    repo: project.repo,
    title: `${prefix} (${detail})`,
    body: [
      `## Context`,
      `Automated site monitoring detected that https://${project.domain} is failing.`,
      ``,
      `- Detected: ${status.checkedAt}`,
      `- Result: ${detail}`,
      `- Response time: ${status.responseMs ?? "?"}ms`,
      ``,
      `## Build (as a vertical slice)`,
      `1. Reproduce: curl -I https://${project.domain} and check recent deploys/commits on main`,
      `2. Identify the root cause (recent merge, config, dependency)`,
      `3. Fix forward with the smallest safe diff, or revert the breaking commit`,
      ``,
      `## Done when`,
      `- [ ] https://${project.domain} responds with HTTP 200`,
      `- [ ] Root cause explained in the PR description`,
      ``,
      `---`,
      `**Agent contract:** follow AGENTS.md + ai/. Work on a \`fix/\` branch, verify green, open a PR with \`Closes #N\`.`,
    ].join("\n"),
    priority: "high",
  });

  void notify({
    kind: "incident",
    repo: project.repo,
    domain: project.domain!,
    detail,
    issueUrl: result.ok ? result.url : undefined,
  });
}

async function resolveIncident(project: Project): Promise<void> {
  const prefix = `${INCIDENT_TITLE_PREFIX} ${project.domain}`;
  const existing = await findOpenIssueByTitlePrefix(project.repo, prefix);
  if (!existing) return;
  await closeIssueWithComment(
    project.repo,
    existing.number,
    `Site monitoring: https://${project.domain} is responding normally again — closing this incident.`
  );
  void notify({ kind: "incident-resolved", repo: project.repo, domain: project.domain! });
}

export async function checkAllSites(): Promise<SiteStatus[]> {
  const projects = listProjects().filter((p) => p.domain);
  const results: SiteStatus[] = [];

  for (const project of projects) {
    const status = await probe(project.domain!);
    const full: SiteStatus = { projectId: project.id, domain: project.domain!, ...status };
    const wasFailing = (consecutiveFailures.get(project.id) ?? 0) >= FAILURES_BEFORE_INCIDENT;
    lastStatus.set(project.id, full);
    results.push(full);

    if (!status.ok) {
      const failures = (consecutiveFailures.get(project.id) ?? 0) + 1;
      consecutiveFailures.set(project.id, failures);
      if (failures === FAILURES_BEFORE_INCIDENT && githubConfigured()) {
        await openIncident(project, status);
      }
    } else {
      consecutiveFailures.set(project.id, 0);
      if (wasFailing && githubConfigured()) {
        await resolveIncident(project);
      }
    }
  }
  return results;
}

/** After an auto-merge deploy: wait, probe, and open an incident immediately on failure. */
export async function verifyDomainAfterDeploy(project: Project): Promise<void> {
  if (!project.domain) return;
  await new Promise((r) => setTimeout(r, POST_DEPLOY_DELAY_MS));
  const status = await probe(project.domain);
  lastStatus.set(project.id, { projectId: project.id, domain: project.domain, ...status });
  if (!status.ok && githubConfigured()) {
    await openIncident(project, status);
  }
}

export function startSiteMonitor(intervalMs = Number(process.env.SITE_MONITOR_INTERVAL_MS) || 30 * 60_000): void {
  if (monitorTimer) return;
  if (process.env.SITE_MONITOR_ENABLED !== "true") {
    console.log("[monitor] SITE_MONITOR_ENABLED is not true — site monitoring disabled.");
    return;
  }
  const tick = () => {
    void checkAllSites().then((results) => {
      const failing = results.filter((r) => !r.ok);
      if (failing.length > 0) {
        console.warn(`[monitor] ${failing.length} site(s) failing: ${failing.map((f) => f.domain).join(", ")}`);
      }
    });
  };
  tick();
  monitorTimer = setInterval(tick, intervalMs);
  console.log(`[monitor] checking ${listProjects().filter((p) => p.domain).length} domains every ${Math.round(intervalMs / 60_000)}m`);
}
