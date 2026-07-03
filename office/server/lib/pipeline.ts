/**
 * Three-agent pipeline — analyze → implement → validate.
 * Settings loaded from agentConfig (UI-editable) with env fallbacks.
 */

import { getStageSettings, type StageSettings, type PipelineStageId } from "./agentConfig.ts";
import type { StageLabel } from "./github.ts";

export type { PipelineStageId } from "./agentConfig.ts";

export interface PipelineStage {
  id: PipelineStageId;
  role: string;
  title: string;
  stageLabel: StageLabel;
  model: string;
  enabled: boolean;
  prompt: (repo: string, issueNumber: number) => string;
}

const ANALYSIS_MARKER = "<!-- bai:analysis -->";

const STAGE_LABELS: Record<PipelineStageId, StageLabel> = {
  analyze: "agent:analyzing",
  implement: "agent:implementing",
  validate: "agent:validating",
};

function analyzePrompt(repo: string, issueNumber: number, settings: StageSettings): string {
  return [
    `You are a ${settings.role} on the BAI Digital agent team. Your job is analysis only — do not implement or open a PR.`,
    ``,
    `Task: GitHub issue #${issueNumber} in ${repo}.`,
    ``,
    `1. Read the issue: gh issue view ${issueNumber} --repo ${repo} --json title,body`,
    `2. Clone the repo into ./work if missing: gh repo clone ${repo} work`,
    `3. Explore ./work — read AGENTS.md, ai/, package.json, and code paths relevant to the task. Understand existing patterns and constraints.`,
    `4. Post your analysis as an issue comment starting with ${ANALYSIS_MARKER}:`,
    `   ## Analysis`,
    `   ### Problem & goal`,
    `   ### Recommended approach (smallest safe diff)`,
    `   ### Files to touch`,
    `   ### Risks & edge cases`,
    `   ### Verification plan`,
    `   ### Open questions (if any — prefer sensible defaults)`,
    `5. End the comment with: "Handoff → Implementation agent."`,
    ``,
    `Rules: read-only in ./work (no feature commits). Never push to main. If the task is impossible or already done, explain in the comment and stop.`,
    `Finish by printing "Analysis complete" on its own line.`,
  ].join("\n");
}

function implementPrompt(repo: string, issueNumber: number, settings: StageSettings): string {
  return [
    `You are a ${settings.role} on the BAI Digital agent team. Implement the solution — the validation agent will verify and open the PR.`,
    ``,
    `Task: GitHub issue #${issueNumber} in ${repo}.`,
    ``,
    `1. Read the issue and the latest analysis comment (${ANALYSIS_MARKER}). If ./work is missing, clone: gh repo clone ${repo} work`,
    `2. In ./work: create branch feat/<short-slug-from-title> from main`,
    `3. Follow AGENTS.md + ai/. Reuse existing patterns; smallest safe diff; never invent APIs, env vars, or DB fields.`,
    `4. Build the vertical slice per the issue's Build steps and Done-when criteria.`,
    `5. Commit with message ending in "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" and push the branch.`,
    `6. Do NOT open a PR yet — the validation agent handles verify + PR.`,
    ``,
    `Rules: never push to main; never merge. If blocked, comment on the issue with what you tried and stop.`,
    `Finish by printing the branch name on its own line.`,
  ].join("\n");
}

function validatePrompt(repo: string, issueNumber: number, settings: StageSettings): string {
  return [
    `You are a ${settings.role} on the BAI Digital agent team. Validate the implementation and ship a review-ready PR.`,
    ``,
    `Task: GitHub issue #${issueNumber} in ${repo}.`,
    ``,
    `1. Read the issue, analysis comment, and implementation branch in ./work (clone if missing: gh repo clone ${repo} work)`,
    `2. Checkout the feat/ branch pushed by the implementation agent`,
    `3. Run the repo's verify/lint/build scripts (read package.json) until green. Fix any gaps against Done-when criteria.`,
    `4. Open PR: gh pr create --base main with body containing Summary / Files touched / Verification / Assumptions, and "Closes #${issueNumber}"`,
    `5. Update stage: gh issue edit ${issueNumber} --repo ${repo} --remove-label "agent:validating" --add-label "agent:review"`,
    ``,
    `Rules: never push to main; never merge the PR. If implementation is missing or unfixable, comment on the issue and restore agent:ready.`,
    `Finish by printing the PR URL on its own line.`,
  ].join("\n");
}

const PROMPT_BUILDERS: Record<
  PipelineStageId,
  (repo: string, issueNumber: number, settings: StageSettings) => string
> = {
  analyze: analyzePrompt,
  implement: implementPrompt,
  validate: validatePrompt,
};

const STAGE_ORDER: PipelineStageId[] = ["analyze", "implement", "validate"];

/** Active pipeline stages in order — respects enabled flags from settings. */
export function getPipelineStages(): PipelineStage[] {
  return STAGE_ORDER.map((id) => {
    const settings = getStageSettings(id);
    return {
      id,
      role: settings.role,
      title: settings.title,
      stageLabel: STAGE_LABELS[id],
      model: settings.model,
      enabled: settings.enabled,
      prompt: (repo, issueNumber) => PROMPT_BUILDERS[id](repo, issueNumber, settings),
    };
  }).filter((stage) => stage.enabled);
}

export function pipelineStageById(id: PipelineStageId): PipelineStage {
  const stage = getPipelineStages().find((s) => s.id === id);
  if (!stage) {
    const settings = getStageSettings(id);
    return {
      id,
      role: settings.role,
      title: settings.title,
      stageLabel: STAGE_LABELS[id],
      model: settings.model,
      enabled: settings.enabled,
      prompt: (repo, issueNumber) => PROMPT_BUILDERS[id](repo, issueNumber, settings),
    };
  }
  return stage;
}

export function pipelineStageLabel(id: PipelineStageId): StageLabel {
  return STAGE_LABELS[id];
}

/** Monolithic fallback prompt for copy-to-clipboard UI (full pipeline in one session). */
export function fullPipelinePrompt(repo: string, issueNumber: number): string {
  return [
    `Execute GitHub issue #${issueNumber} in ${repo} using the BAI three-agent team workflow:`,
    `1) Analyze — explore repo, post structured analysis comment`,
    `2) Implement — feat/ branch, vertical slice, push (no PR)`,
    `3) Validate — verify green, open PR with Closes #${issueNumber}, label agent:review`,
    `Follow AGENTS.md + ai/. Never push to main or merge.`,
  ].join("\n");
}
