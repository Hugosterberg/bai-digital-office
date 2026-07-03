/**
 * Project registry — seeded from DEFAULT_PROJECTS, editable at runtime via
 * server/data/projects.json (add/remove projects, set autonomy level).
 *
 * Autonomy levels:
 *   manual    — human approves every PR in office (default)
 *   auto-safe — green CI + small diff + no sensitive files → auto-merge
 *   full      — green CI → auto-merge (size/sensitivity checks skipped)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AutonomyLevel = "manual" | "auto-safe" | "full";

export interface Project {
  id: string;
  name: string;
  repo: string;
  domain?: string;
  autonomy?: AutonomyLevel;
}

const DEFAULT_PROJECTS: Project[] = [
  { id: "bai-digital-office", name: "bai digital office", repo: "Hugosterberg/bai-digital-office", domain: "office.baidigital.xyz" },
  { id: "automazing", name: "automazing", repo: "Hugosterberg/automazing-flow", domain: "automazing.life" },
  { id: "baidigital-site", name: "baidigital.xyz", repo: "Hugosterberg/bai-digital", domain: "baidigital.xyz" },
  { id: "bitcoinlivet", name: "bitcoinlivet", repo: "Hugosterberg/bitcoinlivet" },
  { id: "bra-erbjudanden", name: "bra-erbjudanden", repo: "Hugosterberg/bra-erbjudanden", domain: "braerbjudanden.se" },
  { id: "smilo", name: "smilo", repo: "Hugosterberg/smilo" },
  { id: "pump", name: "pump", repo: "Hugosterberg/pump" },
  { id: "pump-shopify", name: "pump-shopify", repo: "Hugosterberg/pump-shopify" },
  { id: "los-tios", name: "los-tios", repo: "Hugosterberg/los-tios" },
];

const PROJECTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "projects.json");

function normalizeAutonomy(raw: unknown): AutonomyLevel | undefined {
  return raw === "auto-safe" || raw === "full" || raw === "manual" ? raw : undefined;
}

function normalizeProject(raw: Record<string, unknown>): Project | null {
  const id = String(raw.id || "").trim();
  const repo = String(raw.repo || "").trim();
  if (!id || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return {
    id,
    name: String(raw.name || id).trim(),
    repo,
    domain: String(raw.domain || "").trim() || undefined,
    autonomy: normalizeAutonomy(raw.autonomy),
  };
}

function readProjectsFile(): Project[] | null {
  try {
    const raw = JSON.parse(readFileSync(PROJECTS_FILE, "utf8")) as { projects?: unknown[] };
    if (!Array.isArray(raw.projects)) return null;
    const projects = raw.projects
      .map((p) => normalizeProject(p as Record<string, unknown>))
      .filter((p): p is Project => p !== null);
    return projects.length > 0 ? projects : null;
  } catch {
    return null;
  }
}

export function listProjects(): Project[] {
  return readProjectsFile() ?? DEFAULT_PROJECTS;
}

function writeProjects(projects: Project[]): void {
  mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2) + "\n");
}

export function upsertProject(input: Record<string, unknown>): Project {
  const project = normalizeProject(input);
  if (!project) throw new Error("Project needs an id and a repo in owner/name format.");
  const projects = listProjects().slice();
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx >= 0) projects[idx] = { ...projects[idx], ...project };
  else projects.push(project);
  writeProjects(projects);
  return project;
}

export function setProjectAutonomy(id: string, autonomy: AutonomyLevel): Project {
  const projects = listProjects().slice();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("Unknown project.");
  projects[idx] = { ...projects[idx], autonomy };
  writeProjects(projects);
  return projects[idx];
}

export function removeProject(id: string): void {
  const projects = listProjects().filter((p) => p.id !== id);
  writeProjects(projects);
}

export function projectAutonomy(project: Project | null): AutonomyLevel {
  return project?.autonomy ?? "manual";
}

export function findProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

export function findProjectByRepo(repo: string): Project | null {
  const normalized = String(repo || "").trim().toLowerCase();
  return listProjects().find((p) => p.repo.toLowerCase() === normalized) ?? null;
}
