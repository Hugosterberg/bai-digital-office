/**
 * Outbound notifications — Slack incoming webhook (SLACK_WEBHOOK_URL).
 * All senders are fire-and-forget: notification failure never breaks the pipeline.
 */

export type NotifyEvent =
  | { kind: "pr-ready"; repo: string; issueNumber: number; title: string; prUrl?: string }
  | { kind: "pipeline-failed"; repo: string; issueNumber: number; title: string; stage: string; attempt: number }
  | { kind: "task-blocked"; repo: string; issueNumber: number; title: string; reason: string }
  | { kind: "auto-merged"; repo: string; prNumber: number; title: string; domain?: string }
  | { kind: "incident"; repo: string; domain: string; detail: string; issueUrl?: string }
  | { kind: "incident-resolved"; repo: string; domain: string }
  | { kind: "budget-warning"; project: string; detail: string }
  | { kind: "idea-promoted"; repo: string; issueNumber: number; title: string; by: string };

function webhookUrl(): string {
  return String(process.env.SLACK_WEBHOOK_URL || "").trim();
}

export function notificationsConfigured(): boolean {
  return Boolean(webhookUrl());
}

function formatEvent(event: NotifyEvent): string {
  switch (event.kind) {
    case "pr-ready":
      return `:white_check_mark: *PR ready for review* — ${event.repo}#${event.issueNumber} “${event.title}”${event.prUrl ? `\n${event.prUrl}` : ""}`;
    case "pipeline-failed":
      return `:warning: *Pipeline failed* at ${event.stage} (attempt ${event.attempt}) — ${event.repo}#${event.issueNumber} “${event.title}”`;
    case "task-blocked":
      return `:no_entry: *Task blocked* — ${event.repo}#${event.issueNumber} “${event.title}”\n${event.reason}`;
    case "auto-merged":
      return `:rocket: *Auto-merged to prod* — ${event.repo} PR #${event.prNumber} “${event.title}”${event.domain ? ` → ${event.domain}` : ""}`;
    case "incident":
      return `:fire: *Site incident* — ${event.domain} (${event.repo}): ${event.detail}${event.issueUrl ? `\n${event.issueUrl}` : ""}`;
    case "incident-resolved":
      return `:sunny: *Site recovered* — ${event.domain} (${event.repo})`;
    case "budget-warning":
      return `:money_with_wings: *Budget* — ${event.project}: ${event.detail}`;
    case "idea-promoted":
      return `:bulb: *Idea promoted to build queue* by ${event.by} — ${event.repo}#${event.issueNumber} “${event.title}”`;
  }
}

/** Send a notification. Never throws; logs and continues on failure. */
export async function notify(event: NotifyEvent): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: formatEvent(event) }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.warn(`[notify] Slack webhook responded ${res.status}`);
  } catch (err) {
    console.warn("[notify] failed:", err instanceof Error ? err.message : err);
  }
}
