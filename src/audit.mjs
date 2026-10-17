// Audit trail: Postgres (Neon via Stripe Projects) when configured, else a local JSONL file.
import { appendFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { config } from "./config.mjs";

let pool = null;
let ready = null;

if (config.databaseUrl) {
  pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false }, max: 3 });
  pool.on("error", (e) => console.warn("postgres pool error (ignored):", e.message));
  ready = pool
    .query(`CREATE TABLE IF NOT EXISTS kk_audit (
      id BIGSERIAL PRIMARY KEY,
      case_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      step TEXT NOT NULL,
      detail JSONB
    )`)
    .catch((e) => {
      console.warn("Postgres unavailable, falling back to file audit:", e.message);
      pool = null;
    });
}

mkdirSync("runs", { recursive: true });

export async function audit(caseId, step, detail = {}) {
  const row = { case_id: caseId, ts: new Date().toISOString(), step, detail };
  appendFileSync("runs/audit.jsonl", JSON.stringify(row) + "\n");
  if (!pool) return;
  try {
    await ready;
    if (pool) await pool.query("INSERT INTO kk_audit (case_id, step, detail) VALUES ($1, $2, $3)", [caseId, step, detail]);
  } catch (e) {
    console.warn("audit insert failed:", e.message);
  }
}

export async function auditTrail(caseId) {
  if (!pool) return null;
  await ready;
  if (!pool) return null;
  const { rows } = await pool.query("SELECT ts, step, detail FROM kk_audit WHERE case_id = $1 ORDER BY id", [caseId]);
  return rows;
}

export const auditBackend = () => (pool ? "postgres" : "file");
