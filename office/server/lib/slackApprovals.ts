/**
 * Slack approval flow — approve PRs by reacting with ✅ in Slack.
 *
 * When a pipeline finishes on a manual-autonomy project, the bot posts an
 * approval request to SLACK_CHANNEL_ID. The worker polls reactions on
 * pending messages: ✅ (white_check_mark et al) → squash-merge to main,
 * ❌ → stop watching (review manually in office instead).
 *
 * Requires a Slack app bot token (SLACK_BOT_TOKEN, scopes: chat:write,
 * reactions:read) and the bot invited to the channel. The plain
 * SLACK_WEBHOOK_URL notifications keep working independently of this.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergePullRequest, commentOnIssue } from "./github.ts";
import { findProjectByRepo } from "./projects.ts";
import { verifyDomainAfterDeploy } from "./siteMonitor.ts";

const PENDING_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "slack-approvals.json");
const APPROVE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "+1"]);
const REJECT_REACTIONS = new Set(["x", "no_entry", "-1"]);
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

interface PendingApproval {
  ts: string;
  channel: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
  title: string;
  createdAt: string;
  /** Last merge-failure message replied to the thread — avoids repeating it every poll. */
  lastError?: string;
}

function botToken(): string {
  return String(process.env.SLACK_BOT_TOKEN || "").trim();
}

function channelId(): string {
  return String(process.env.SLACK_CHANNEL_ID || "").trim();
}

export function slackApprovalsConfigured(): boolean {
  return Boolean(botToken() && channelId());
}

function readPending(): PendingApproval[] {
  try {
    const raw = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as { pending?: PendingApproval[] };
    return Array.isArray(raw.pending) ? raw.pending : [];
  } catch {
    return [];
  }
}

function writePending(pending: PendingApproval[]): void {
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify({ pending }, null, 2) + "\n");
}

export function listPendingApprovals(): PendingApproval[] {
  return readPending();
}

async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken()}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!data.ok) {
      console.warn(`[slack-approvals] ${method} failed: ${String(data.error)}`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[slack-approvals] ${method} error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Post an approval request. Returns true if the message was posted. */
export async function postApprovalRequest(input: {
  repo: string;
  prNumber: number;
  issueNumber: number;
  title: string;
  prUrl?: string;
}): Promise<boolean> {
  if (!slackApprovalsConfigured()) return false;

  const text = [
    `:package: *Klar för review* — ${input.repo}#${input.issueNumber} “${input.title}”`,
    input.prUrl ? `PR: ${input.prUrl}` : `PR #${input.prNumber}`,
    ``,
    `Reagera med :white_check_mark: för att godkänna och merga till main · :x: för att hantera manuellt i office.`,
  ].join("\n");

  const posted = await slackApi("chat.postMessage", { channel: channelId(), text, unfurl_links: false });
  const ts = String((posted?.message as Record<string, unknown> | undefined)?.ts || posted?.ts || "");
  if (!ts) return false;

  const pending = readPending();
  pending.push({
    ts,
    channel: channelId(),
    repo: input.repo,
    prNumber: input.prNumber,
    issueNumber: input.issueNumber,
    title: input.title,
    createdAt: new Date().toISOString(),
  });
  writePending(pending);
  return true;
}

async function reply(item: PendingApproval, text: string): Promise<void> {
  await slackApi("chat.postMessage", { channel: item.channel, thread_ts: item.ts, text, unfurl_links: false });
}

async function reactionsOn(item: PendingApproval): Promise<Set<string>> {
  const data = await slackApi("reactions.get", { channel: item.channel, timestamp: item.ts });
  const message = data?.message as Record<string, unknown> | undefined;
  const reactions = Array.isArray(message?.reactions) ? (message.reactions as Array<{ name?: string }>) : [];
  return new Set(reactions.map((r) => String(r.name || "")));
}

/** Check all pending approval messages for ✅/❌ reactions and act on them. */
export async function pollSlackApprovals(): Promise<void> {
  if (!slackApprovalsConfigured()) return;
  const pending = readPending();
  if (pending.length === 0) return;

  const remaining: PendingApproval[] = [];
  for (const item of pending) {
    if (Date.now() - Date.parse(item.createdAt) > PENDING_MAX_AGE_MS) continue;

    const names = await reactionsOn(item);
    const approved = [...names].some((n) => APPROVE_REACTIONS.has(n));
    const rejected = [...names].some((n) => REJECT_REACTIONS.has(n));

    if (rejected && !approved) {
      await reply(item, `:eyes: Uppmärkt för manuell hantering — granska PR #${item.prNumber} i office.`);
      continue;
    }

    if (approved) {
      const result = await mergePullRequest(item.repo, item.prNumber);
      if (result.ok) {
        await reply(item, `:rocket: Mergad till main — deploy är på väg.`);
        await commentOnIssue(
          item.repo,
          item.issueNumber,
          `Approved via Slack (✅ reaction) — PR #${item.prNumber} squash-merged to main.`
        );
        const project = findProjectByRepo(item.repo);
        if (project?.domain) void verifyDomainAfterDeploy(project);
      } else if (result.status === 409 && /already merged/i.test(result.message)) {
        await reply(item, `PR #${item.prNumber} var redan mergad.`);
      } else {
        // Keep watching and retry next poll — the branch may just have been
        // updated with latest main (CI re-running) or a conflict gets fixed.
        // Only post to the thread when the reason changes, not every 45s.
        if (result.message !== item.lastError) {
          const prefix = result.code === "updated-base" ? ":arrows_counterclockwise:" : ":warning:";
          await reply(item, `${prefix} PR #${item.prNumber}: ${result.message}`);
        }
        remaining.push({ ...item, lastError: result.message });
      }
      continue;
    }

    remaining.push(item);
  }
  writePending(remaining);
}

let approvalTimer: ReturnType<typeof setInterval> | null = null;

export function startSlackApprovalPolling(intervalMs = Number(process.env.SLACK_APPROVAL_POLL_MS) || 45_000): void {
  if (approvalTimer) return;
  if (!slackApprovalsConfigured()) {
    console.log("[slack-approvals] SLACK_BOT_TOKEN/SLACK_CHANNEL_ID not set — ✅-to-merge disabled.");
    return;
  }
  approvalTimer = setInterval(() => void pollSlackApprovals(), intervalMs);
  console.log(`[slack-approvals] polling reactions every ${Math.round(intervalMs / 1000)}s`);
}
