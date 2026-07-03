/**
 * Agent provider catalog — every way work can run through an AI agent.
 * Office auto-dispatches only providers with dispatchMode "office"; the rest
 * are documented here so Hugo can pick the right tool and log cost consistently.
 */

export type AgentProviderId = "claude-code" | "claude-interactive" | "cursor" | "anthropic-api";

export type AgentBilling = "auto" | "manual" | "subscription";
export type AgentDispatchMode = "office" | "cli" | "ide" | "api";

export interface AgentProvider {
  id: AgentProviderId;
  name: string;
  shortLabel: string;
  tagline: string;
  /** Tailwind text-* class for badges */
  tone: string;
  billing: AgentBilling;
  billingLabel: string;
  dispatchMode: AgentDispatchMode;
  dispatchLabel: string;
  costTracking: "auto" | "manual" | "dashboard";
  costNote: string;
  requirements: string[];
  docsUrl?: string;
}

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: "claude-code",
    name: "Claude Code (headless)",
    shortLabel: "Claude Code",
    tagline: "Auto-dispatch via `claude -p` — billed on platform.claude.com",
    tone: "text-bai-orange",
    billing: "auto",
    billingLabel: "platform.claude.com credits",
    dispatchMode: "office",
    dispatchLabel: "One-click dispatch from office",
    costTracking: "auto",
    costNote: "USD per run parsed from Claude CLI JSON (`total_cost_usd`).",
    requirements: ["Claude Code CLI logged in (`claude`)", "Runs on your machine or worker — not Vercel"],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
  },
  {
    id: "claude-interactive",
    name: "Claude Code (interactive)",
    shortLabel: "Claude terminal",
    tagline: "You drive the session in a terminal — same credits, manual control",
    tone: "text-amber-400",
    billing: "subscription",
    billingLabel: "platform.claude.com plan",
    dispatchMode: "cli",
    dispatchLabel: "Copy CLI command from a ready task",
    costTracking: "manual",
    costNote: "Log estimated cost after the session — check platform.claude.com usage.",
    requirements: ["Claude Code CLI", "You start and stop the run"],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    shortLabel: "Cursor",
    tagline: "IDE agent in Cursor Desktop — subscription or usage-based",
    tone: "text-sky-400",
    billing: "subscription",
    billingLabel: "Cursor Pro / usage",
    dispatchMode: "ide",
    dispatchLabel: "Open repo in Cursor → Agent with issue context",
    costTracking: "manual",
    costNote: "Log runs here; check cursor.com/settings for plan usage.",
    requirements: ["Cursor Desktop", "Repo cloned locally"],
    docsUrl: "https://cursor.com/docs",
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    shortLabel: "API",
    tagline: "Custom scripts or agents hitting api.anthropic.com directly",
    tone: "text-rose-400",
    billing: "auto",
    billingLabel: "Pay-as-you-go API key",
    dispatchMode: "api",
    dispatchLabel: "Your own runner — log cost when done",
    costTracking: "dashboard",
    costNote: "Track in console.anthropic.com; log significant runs here for portfolio totals.",
    requirements: ["ANTHROPIC_API_KEY", "Custom agent script"],
    docsUrl: "https://platform.claude.com/",
  },
];

export function findProvider(id: string): AgentProvider | undefined {
  return AGENT_PROVIDERS.find((p) => p.id === id);
}

export function normalizeProviderId(raw: string): AgentProviderId {
  const id = String(raw || "").trim() as AgentProviderId;
  return findProvider(id) ? id : "claude-code";
}

/** Prompt pasted into Cursor Agent or similar IDE agents. */
export function ideAgentPrompt(repo: string, issueNumber: number): string {
  return [
    `Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract in the issue body.`,
    ``,
    `1. Read the issue on GitHub (Context, Build steps, Done-when criteria).`,
    `2. Label the issue agent:building, then create feat/<slug> from main.`,
    `3. Follow AGENTS.md + ai/ in the repo. Smallest safe diff; run verify until green.`,
    `4. Open a PR with "Closes #${issueNumber}" and label agent:review.`,
    `Never push to main or merge the PR.`,
  ].join("\n");
}

/** One-liner for headless Claude Code (interactive terminal paste). */
export function claudeInteractiveCommand(repo: string, issueNumber: number): string {
  const prompt = [
    `Execute GitHub issue #${issueNumber} in ${repo} per the BAI agent contract in its body:`,
    `read with gh issue view ${issueNumber} --repo ${repo}, label agent:building, clone,`,
    `build on feat/ branch, verify green, PR with Closes #${issueNumber}, label agent:review.`,
    `Never push to main or merge.`,
  ].join(" ");
  return `claude "${prompt.replace(/"/g, '\\"')}" --permission-mode acceptEdits`;
}

export interface AgentCatalogEntry extends AgentProvider {
  available: boolean;
  unavailableReason?: string;
}

export function agentCatalog(dispatchEnabled: boolean): AgentCatalogEntry[] {
  return AGENT_PROVIDERS.map((provider) => {
    if (provider.dispatchMode === "office") {
      return dispatchEnabled
        ? { ...provider, available: true }
        : {
            ...provider,
            available: false,
            unavailableReason: "Dispatch disabled on this host — run locally or `npm run worker`.",
          };
    }
    return { ...provider, available: true };
  });
}
