/**
 * Vercel serverless entry — API only (no long-running agent dispatch on Vercel).
 * Run `npm run worker` locally for Claude Code agents.
 */
import app from "../server/server.ts";

export default app;
