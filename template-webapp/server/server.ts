/**
 * Express API for this product. Every feature slice registers its routes
 * here; keep handlers thin and move logic into server/lib/.
 */
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`api on :${PORT}`));
