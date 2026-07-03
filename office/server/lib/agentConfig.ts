/**
 * Persisted agent-team settings — pipeline + specialist agents.
 * Stored in server/data/agent-team.json (Railway volume recommended).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PipelineStageId = "analyze" | "implement" | "validate";
export type SpecialistAgentId = "growth" | "research";

export interface StageSettings {
  enabled: boolean;
  model: string;
  role: string;
  title: string;
}

export interface AgentTeamConfig {
  stages: Record<PipelineStageId, StageSettings>;
  specialists: Record<SpecialistAgentId, StageSettings>;
  updatedAt: string;
}

export interface PipelineAgentView {
  id: PipelineStageId;
  kind: "pipeline";
  title: string;
  role: string;
  model: string;
  enabled: boolean;
  stageLabel: string;
  docsPath: string;
  order: number;
  defaults: StageSettings;
}

export interface SpecialistAgentView {
  id: SpecialistAgentId;
  kind: "specialist";
  title: string;
  role: string;
  model: string;
  enabled: boolean;
  docsPath: string;
  description: string;
  order: number;
  defaults: StageSettings;
}

export const SUGGESTED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

const STAGE_META: Record<
  PipelineStageId,
  {
    stageLabel: string;
    docsPath: string;
    order: number;
    defaultRole: string;
    defaultTitle: string;
    envKey: string;
    envFallback: string;
  }
> = {
  analyze: {
    stageLabel: "agent:analyzing",
    docsPath: "ai/agents/analyze-agent.md",
    order: 1,
    defaultRole: "Senior software analyst",
    defaultTitle: "Analysis",
    envKey: "AGENT_MODEL_ANALYZE",
    envFallback: "claude-sonnet-4-6",
  },
  implement: {
    stageLabel: "agent:implementing",
    docsPath: "ai/agents/implement-agent.md",
    order: 2,
    defaultRole: "Staff software engineer",
    defaultTitle: "Implementation",
    envKey: "AGENT_MODEL_IMPLEMENT",
    envFallback: "claude-opus-4-6",
  },
  validate: {
    stageLabel: "agent:validating",
    docsPath: "ai/agents/validate-agent.md",
    order: 3,
    defaultRole: "Senior QA / release engineer",
    defaultTitle: "Validation",
    envKey: "AGENT_MODEL_VALIDATE",
    envFallback: "claude-sonnet-4-6",
  },
};

const SPECIALIST_META: Record<
  SpecialistAgentId,
  {
    docsPath: string;
    description: string;
    order: number;
    defaultRole: string;
    defaultTitle: string;
    envKey: string;
    envFallback: string;
  }
> = {
  growth: {
    docsPath: "ai/agents/growth-agent.md",
    description: "Creative feature ideas to grow the business — creates agent:idea issues",
    order: 1,
    defaultRole: "Chief growth & product strategist",
    defaultTitle: "Growth ideation",
    envKey: "AGENT_MODEL_GROWTH",
    envFallback: "claude-opus-4-6",
  },
  research: {
    docsPath: "ai/agents/research-agent.md",
    description: "Market gaps and opportunity scan — research brief as agent:idea",
    order: 2,
    defaultRole: "Market & competitor analyst",
    defaultTitle: "Research",
    envKey: "AGENT_MODEL_RESEARCH",
    envFallback: "claude-sonnet-4-6",
  },
};

const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "agent-team.json");

function envModel(key: string, fallback: string): string {
  return String(process.env[key] || "").trim() || fallback;
}

export function defaultStageSettings(id: PipelineStageId): StageSettings {
  const meta = STAGE_META[id];
  return {
    enabled: true,
    model: envModel(meta.envKey, meta.envFallback),
    role: meta.defaultRole,
    title: meta.defaultTitle,
  };
}

export function defaultSpecialistSettings(id: SpecialistAgentId): StageSettings {
  const meta = SPECIALIST_META[id];
  return {
    enabled: true,
    model: envModel(meta.envKey, meta.envFallback),
    role: meta.defaultRole,
    title: meta.defaultTitle,
  };
}

interface RawConfig {
  stages?: Partial<Record<PipelineStageId, Partial<StageSettings>>>;
  specialists?: Partial<Record<SpecialistAgentId, Partial<StageSettings>>>;
  updatedAt?: string;
}

function readRawFile(): RawConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as RawConfig;
  } catch {
    return {};
  }
}

function mergeStage(id: PipelineStageId, raw?: Partial<StageSettings>): StageSettings {
  const defaults = defaultStageSettings(id);
  if (!raw) return defaults;
  return {
    enabled: raw.enabled !== false,
    model: String(raw.model || "").trim() || defaults.model,
    role: String(raw.role || "").trim() || defaults.role,
    title: String(raw.title || "").trim() || defaults.title,
  };
}

function mergeSpecialist(id: SpecialistAgentId, raw?: Partial<StageSettings>): StageSettings {
  const defaults = defaultSpecialistSettings(id);
  if (!raw) return defaults;
  return {
    enabled: raw.enabled !== false,
    model: String(raw.model || "").trim() || defaults.model,
    role: String(raw.role || "").trim() || defaults.role,
    title: String(raw.title || "").trim() || defaults.title,
  };
}

export function readAgentTeamConfig(): AgentTeamConfig {
  const raw = readRawFile();
  return {
    stages: {
      analyze: mergeStage("analyze", raw.stages?.analyze),
      implement: mergeStage("implement", raw.stages?.implement),
      validate: mergeStage("validate", raw.stages?.validate),
    },
    specialists: {
      growth: mergeSpecialist("growth", raw.specialists?.growth),
      research: mergeSpecialist("research", raw.specialists?.research),
    },
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  };
}

export function getStageSettings(id: PipelineStageId): StageSettings {
  return readAgentTeamConfig().stages[id];
}

export function getSpecialistSettings(id: SpecialistAgentId): StageSettings {
  return readAgentTeamConfig().specialists[id];
}

export function listPipelineAgentViews(): PipelineAgentView[] {
  const config = readAgentTeamConfig();
  return (Object.keys(STAGE_META) as PipelineStageId[])
    .map((id) => {
      const meta = STAGE_META[id];
      const stage = config.stages[id];
      return {
        id,
        kind: "pipeline" as const,
        title: stage.title,
        role: stage.role,
        model: stage.model,
        enabled: stage.enabled,
        stageLabel: meta.stageLabel,
        docsPath: meta.docsPath,
        order: meta.order,
        defaults: defaultStageSettings(id),
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function listSpecialistAgentViews(): SpecialistAgentView[] {
  const config = readAgentTeamConfig();
  return (Object.keys(SPECIALIST_META) as SpecialistAgentId[])
    .map((id) => {
      const meta = SPECIALIST_META[id];
      const s = config.specialists[id];
      return {
        id,
        kind: "specialist" as const,
        title: s.title,
        role: s.role,
        model: s.model,
        enabled: s.enabled,
        docsPath: meta.docsPath,
        description: meta.description,
        order: meta.order,
        defaults: defaultSpecialistSettings(id),
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function setAgentTeamConfig(input: {
  stages?: Partial<Record<PipelineStageId, Partial<StageSettings>>>;
  specialists?: Partial<Record<SpecialistAgentId, Partial<StageSettings>>>;
}): AgentTeamConfig {
  const current = readAgentTeamConfig();
  const stages: Record<PipelineStageId, StageSettings> = {
    analyze: mergeStage("analyze", { ...current.stages.analyze, ...input.stages?.analyze }),
    implement: mergeStage("implement", { ...current.stages.implement, ...input.stages?.implement }),
    validate: mergeStage("validate", { ...current.stages.validate, ...input.stages?.validate }),
  };
  const specialists: Record<SpecialistAgentId, StageSettings> = {
    growth: mergeSpecialist("growth", { ...current.specialists.growth, ...input.specialists?.growth }),
    research: mergeSpecialist("research", { ...current.specialists.research, ...input.specialists?.research }),
  };

  const enabledPipeline = Object.values(stages).filter((s) => s.enabled).length;
  if (enabledPipeline === 0) {
    throw new Error("At least one pipeline agent must stay enabled.");
  }

  const updatedAt = new Date().toISOString();
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ stages, specialists, updatedAt }, null, 2) + "\n");
  return { stages, specialists, updatedAt };
}

export function resetAgentTeamStage(id: PipelineStageId): AgentTeamConfig {
  const current = readAgentTeamConfig();
  const othersEnabled = (Object.keys(current.stages) as PipelineStageId[])
    .filter((key) => key !== id)
    .some((key) => current.stages[key].enabled);
  if (!defaultStageSettings(id).enabled && !othersEnabled) {
    throw new Error("At least one pipeline agent must stay enabled.");
  }
  return setAgentTeamConfig({ stages: { [id]: defaultStageSettings(id) } });
}

export function resetSpecialistAgent(id: SpecialistAgentId): AgentTeamConfig {
  return setAgentTeamConfig({ specialists: { [id]: defaultSpecialistSettings(id) } });
}

export function isSpecialistAgentId(raw: string): raw is SpecialistAgentId {
  return raw === "growth" || raw === "research";
}

export function isPipelineStageId(raw: string): raw is PipelineStageId {
  return raw === "analyze" || raw === "implement" || raw === "validate";
}
