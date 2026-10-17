// The write → run → observe → fix loop. The agent writes a script, the sandbox runs it,
// a fixed validator checks the output, and any failure goes back to the LLM to fix.
import { chat, extractPython, currentModel } from "./llm.mjs";
import { SYSTEM, fixTask } from "./prompts.mjs";
import { upload, runPython } from "./sandbox.mjs";
import { config } from "./config.mjs";

/**
 * @param {object} p
 * @param {import("@nodeops-createos/sandbox").Sandbox} p.sb
 * @param {string} p.name        e.g. "clean.py"
 * @param {string} p.task        the instruction for the LLM
 * @param {string[]} [p.args]    args for the script
 * @param {string} [p.validator] python source of a validator that prints problems (empty = ok)
 * @param {(e: object) => void} p.emit
 */
export async function writeRunFix({ sb, name, task, args = [], validator, emit }) {
  const path = `/work/${name}`;
  const base = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];
  let messages = base;

  if (validator) await upload(sb, `/work/validate_${name}`, validator);

  for (let attempt = 1; attempt <= config.maxFixAttempts; attempt++) {
    // Model escalation: first draft from the fast model, every fix from the strong model.
    const model = attempt === 1 && config.llm.fastModel ? config.llm.fastModel : undefined;
    const modelName = model || currentModel();
    emit({ type: "agent", phase: "writing", script: name, attempt, model: modelName });
    const reply = await chat(messages, { maxTokens: 3500, model });
    const code = extractPython(reply);
    await upload(sb, path, code);

    emit({ type: "agent", phase: "running", script: name, attempt, code, model: modelName });
    const run = await runPython(sb, path, args);

    let problems = "";
    if (!run.ok) {
      problems = run.stderr || run.stdout || `exit code ${run.exitCode}`;
    } else if (validator) {
      const v = await runPython(sb, `/work/validate_${name}`, args);
      problems = v.ok ? v.stdout.trim() : (v.stderr || v.stdout);
    }

    if (!problems) {
      emit({ type: "agent", phase: "succeeded", script: name, attempt, code, stdout: run.stdout, ms: run.ms });
      return { code, attempts: attempt, stdout: run.stdout };
    }

    emit({ type: "agent", phase: "failed", script: name, attempt, code, error: problems.slice(-2500) });
    // Keep the context small (free-tier token limits): task + latest attempt + its error only.
    messages = [...base, { role: "user", content: fixTask({ code, error: problems.slice(-1500) }) }];
  }

  throw new Error(`${name} still failing after ${config.maxFixAttempts} attempts`);
}

// Fixed validators — written by us, not the agent — so the agent can't grade itself.
export const VALIDATE_CLEAN = String.raw`
import json, sys, re
import pandas as pd
problems = []
try:
    df = pd.read_csv("/work/clean.csv", dtype=str, keep_default_na=False)
except Exception as e:
    print(f"cannot read /work/clean.csv: {e}"); sys.exit(0)
need = ["invoice_id","buyer","currency","invoice_amount","amount_paid","outstanding","issue_date","due_date",
        "days_overdue","aging_bucket","part_payment_count","last_payment_date"]
missing = [c for c in need if c not in df.columns]
if missing: problems.append(f"missing columns: {missing}")
else:
    if df["invoice_id"].duplicated().any():
        problems.append(f"duplicate invoice_id rows: {df[df['invoice_id'].duplicated()]['invoice_id'].tolist()[:5]}")
    raw = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "/work/input.csv", dtype=str, keep_default_na=False)
    idcol = next((c for c in raw.columns if "inv" in c.lower()), raw.columns[0])
    expected = raw[idcol].str.strip().nunique()
    if len(df) != expected: problems.append(f"expected {expected} invoices, got {len(df)}")
    for c in ["invoice_amount","amount_paid","outstanding","days_overdue","part_payment_count"]:
        bad = pd.to_numeric(df[c], errors="coerce").isna()
        if bad.any(): problems.append(f"{c} not numeric for: {df[bad]['invoice_id'].tolist()[:5]}")
    for c in ["issue_date","due_date"]:
        bad = ~df[c].str.match(r"^\d{4}-\d{2}-\d{2}$")
        if bad.any():
            ex = ", ".join(f"{i}={v!r}" for i, v in df[bad][["invoice_id", c]].head(4).values)
            problems.append(f"{bad.sum()} rows have {c} not in YYYY-MM-DD form, e.g. {ex}. "
                            f"Raw dates mix formats (ISO 2026-07-07, day-first 15/09/2026, and 'Sep 03 2026'); parse each format explicitly instead of one pd.to_datetime call.")
    bad = ~df["aging_bucket"].isin(["current","1-30","31-60","61-90","90+"])
    if bad.any(): problems.append(f"invalid aging_bucket values: {sorted(df[bad]['aging_bucket'].unique().tolist())[:5]}")
    out = pd.to_numeric(df["outstanding"], errors="coerce")
    if (out < 0).any(): problems.append("negative outstanding values")
    # Reconciliation: invoiced totals per currency must match an independent parse of the raw file.
    cols = {c.lower().strip(): c for c in raw.columns}
    tcol, acol, ccol = cols.get("type"), cols.get("amount"), cols.get("currency")
    if tcol and acol and ccol:
        r = raw.drop_duplicates()
        inv = r[r[tcol].str.strip().str.lower() == "invoice"]
        expect = inv.assign(v=inv[acol].str.replace(r"[^0-9.]", "", regex=True).astype(float)).groupby(inv[ccol].str.strip())["v"].sum()
        got = pd.to_numeric(df["invoice_amount"], errors="coerce").groupby(df["currency"].str.strip()).sum()
        for cur, val in expect.items():
            g = float(got.get(cur, 0))
            if abs(g - val) > max(1.0, 0.005 * val):
                problems.append(f"RECONCILIATION FAILED for {cur}: sum of invoice_amount is {g:,.2f} but the raw invoice rows total {val:,.2f}. "
                                f"Check amount parsing (symbols like £ € $, thousands commas, and suffixes like ' GBP').")
    try:
        json.load(open("/work/clean_summary.json"))
    except Exception as e:
        problems.append(f"/work/clean_summary.json missing or invalid: {e}")
print("\n".join(problems))
`;

export const VALIDATE_STRATEGY = String.raw`
import json, sys
letter = sys.argv[1] if len(sys.argv) > 1 else "A"
try:
    d = json.load(open(f"/work/strategy_{letter}.json"))
except Exception as e:
    print(f"/work/strategy_{letter}.json missing or invalid: {e}"); sys.exit(0)
p = []
if not isinstance(d.get("top"), list) or not d["top"]: p.append("top must be a non-empty list")
m = d.get("metrics") or {}
for k in ["invoices_targeted","buyers_contacted","outstanding_covered_by_currency","avg_days_overdue","share_of_total_outstanding_pct"]:
    if k not in m: p.append(f"metrics.{k} missing")
if isinstance(d.get("top"), list) and m.get("invoices_targeted") not in (None, len(d["top"])):
    p.append(f"metrics must describe only the targeted top rows: invoices_targeted is {m.get('invoices_targeted')} but top has {len(d['top'])} rows")
if (m.get("share_of_total_outstanding_pct") or 0) > 100.0001:
    p.append("share_of_total_outstanding_pct cannot exceed 100")
for r in d.get("top") or []:
    for k in ["invoice_id","buyer","currency","outstanding","days_overdue"]:
        if k not in r: p.append(f"top row missing {k}"); break
print("\n".join(p[:8]))
`;

export const VALIDATE_DASHBOARD = String.raw`
import os
p = "/work/site/index.html"
if not os.path.exists(p): print("/work/site/index.html was not created")
else:
    s = open(p, encoding="utf-8").read()
    if len(s) < 800: print("dashboard HTML is suspiciously short")
    elif "<html" not in s.lower(): print("dashboard is not an HTML document")
    elif "<script src" in s.lower() or 'rel="stylesheet" href="http' in s.lower(): print("dashboard must not load external assets")
`;
