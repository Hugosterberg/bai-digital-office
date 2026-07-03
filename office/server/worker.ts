/**
 * Standalone agent worker — polls GitHub for agent:ready tasks and dispatches
 * Claude Code (`claude -p`) using your platform.claude.com subscription.
 *
 * Run on a machine where `claude` and `gh` are logged in:
 *   npm run worker
 */
import dotenv from "dotenv";
import { pollReadyTasks } from "./lib/agentPoller.ts";

dotenv.config({ path: [".env.local", ".env"] });

const intervalMs = Number(process.env.AGENT_POLL_INTERVAL_MS) || 90_000;

console.log("[worker] BAI agent worker — polling for agent:ready tasks");
console.log(`[worker] interval=${intervalMs}ms DISPATCH_DISABLED=${process.env.DISPATCH_DISABLED ?? "false"}`);

async function tick() {
  try {
    const { dispatched, skipped } = await pollReadyTasks();
    if (dispatched > 0 || skipped > 0) {
      console.log(`[worker] dispatched=${dispatched} skipped=${skipped}`);
    }
  } catch (err) {
    console.error("[worker] poll failed:", err);
  }
}

void tick();
setInterval(() => void tick(), intervalMs);
