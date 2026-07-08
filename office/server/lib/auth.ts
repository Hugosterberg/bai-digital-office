/**
 * Optional bearer auth for write routes when deployed (office.baidigital.xyz).
 * Local dev: if OFFICE_SECRET is unset, writes are allowed.
 */

import type { Request, Response, NextFunction } from "express";

export function requireWriteAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = String(process.env.OFFICE_SECRET || "").trim();
  if (!secret) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || "").trim();
  if (auth === `Bearer ${secret}`) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized — set Authorization: Bearer <OFFICE_SECRET>." });
}
