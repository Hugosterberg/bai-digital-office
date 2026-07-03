/**
 * Polls GitHub for agent:ready tasks and dispatches Claude Code agents.
 * Runs on the machine where `claude` CLI is logged in (platform.claude.com credits).
 *
 * Enable with AGENT_POLL_ENABLED=true on the API host, or run `npm run worker`.
 */

import { PROJECTS } from "./projects.ts";
import { listTasks } from "./github.ts";
import { startDispatch, runningDispatchCount } from "./dispatch.ts";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

export async function pollReadyTasks(): Promise<{ dispatched: number; skipped: number }> {
  if (polling) return { dispatched: 0, skipped: 0 };
  polling = true;
  let dispatched = 0;
  let skipped = 0;
  try {
    for (const project of PROJECTS) {
      if (runningDispatchCount() >= 3) break;
      let tasks;
      try {
        tasks = await listTasks(project.repo);
      } catch (err) {
        console.warn(`[poller] could not list tasks for ${project.repo}:`, err);
        continue;
      }
      for (const task of tasks) {
        if (task.stage !== "agent:ready") continue;
        if (runningDispatchCount() >= 3) break;
        const result = startDispatch({
          repo: project.repo,
          issueNumber: task.number,
          title: task.title,
        });
        if (result.ok) {
          dispatched += 1;
          console.log(`[poller] dispatched ${project.repo}#${task.number}`);
        } else {
          skipped += 1;
          if (result.status === 429) break;
        }
      }
    }
  } finally {
    polling = false;
  }
  return { dispatched, skipped };
}

export function startAgentPoller(intervalMs = 90_000): void {
  if (pollTimer) return;
  if (process.env.AGENT_POLL_ENABLED !== "true") {
    console.log("[poller] AGENT_POLL_ENABLED is not true — auto-pickup disabled.");
    return;
  }
  if (process.env.DISPATCH_DISABLED === "true") {
    console.log("[poller] DISPATCH_DISABLED=true — agents will not start.");
    return;
  }
  const tick = () => {
    void pollReadyTasks().then(({ dispatched, skipped }) => {
      if (dispatched > 0) console.log(`[poller] dispatched=${dispatched} skipped=${skipped}`);
    });
  };
  tick();
  pollTimer = setInterval(tick, intervalMs);
  console.log(`[poller] auto-pickup every ${Math.round(intervalMs / 1000)}s`);
}

export function stopAgentPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
