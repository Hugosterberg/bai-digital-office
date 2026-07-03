/**
 * Project registry — mirrors bai-digital-office/ai/PORTFOLIO.md (that file is the
 * source of truth; keep this list in sync when the portfolio changes).
 * `repo` is the GitHub "owner/name" the task queue (issues) lives in.
 */
export interface Project {
  id: string;
  name: string;
  repo: string;
  domain?: string;
}

export const PROJECTS: Project[] = [
  { id: "bai-digital-office", name: "bai digital office", repo: "Hugosterberg/bai-digital-office", domain: "baidigital.office.xyz" },
  { id: "automazing", name: "automazing", repo: "Hugosterberg/automazing-flow", domain: "automazing.life" },
  { id: "baidigital-site", name: "baidigital.xyz", repo: "Hugosterberg/bai-digital", domain: "baidigital.xyz" },
  { id: "bitcoinlivet", name: "bitcoinlivet", repo: "Hugosterberg/bitcoinlivet" },
  { id: "bra-erbjudanden", name: "bra-erbjudanden", repo: "Hugosterberg/bra-erbjudanden", domain: "braerbjudanden.se" },
  { id: "smilo", name: "smilo", repo: "Hugosterberg/smilo" },
  { id: "pump", name: "pump", repo: "Hugosterberg/pump" },
  { id: "pump-shopify", name: "pump-shopify", repo: "Hugosterberg/pump-shopify" },
  { id: "los-tios", name: "los-tios", repo: "Hugosterberg/los-tios" },
  // New products: add their row here when created from template-webapp,
  // e.g. { id: "invest", name: "invest", repo: "bai-digital-office/invest" }.
];

export function findProject(id: string): Project | null {
  return PROJECTS.find((p) => p.id === id) ?? null;
}
