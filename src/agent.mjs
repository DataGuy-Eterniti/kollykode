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
    def find(keys, avoid=("date", "day", "term")):
        # first column whose header contains one of the name variants (e.g. "Inv No", not "Inv Date")
        for k in keys:
            for c in raw.columns:
                l = c.lower().strip()
                if k in l and not any(a in l for a in avoid): return c
    idcol = find(["invoice", "inv", "reference", "ref"]) or raw.columns[0]
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
                            f"Raw dates mix formats (e.g. ISO 2026-07-07, 2026/07/07, day-first 15/09/2026 or 15-09-2026, 'Sep 03 2026', '03 Sep 2026'); parse each format explicitly instead of one pd.to_datetime call.")
    bad = ~df["aging_bucket"].isin(["current","1-30","31-60","61-90","90+"])
    if bad.any(): problems.append(f"invalid aging_bucket values: {sorted(df[bad]['aging_bucket'].unique().tolist())[:5]}")
    out = pd.to_numeric(df["outstanding"], errors="coerce")
    if (out < 0).any(): problems.append("negative outstanding values")
    # Reconciliation: invoiced totals per currency must match an independent parse of the raw file.
    tcol, acol, ccol = find(["type", "kind"]), find(["amount", "value", "gross"]), find(["currency", "ccy"])
    def amt(s):
        # "$1,234.50", "28,474 USD", "€12.400,50" (European), "£3,050.00" → float
        t = re.sub(r"[^0-9.,]", "", str(s))
        if "," in t and "." in t:
            t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
        elif "," in t:
            t = t.replace(",", ".") if re.search(r"^\d+,\d{1,2}$", t) else t.replace(",", "")
        elif t.count(".") > 1:
            t = t.replace(".", "")
        return float(t) if t else 0.0
    if tcol and acol and ccol:
        r = raw.drop_duplicates()
        kind = r[tcol].str.strip().str.lower()
        inv = r[kind.isin(["invoice", "inv"])]
        expect = inv.assign(v=inv[acol].map(amt)).groupby(inv[ccol].str.strip())["v"].sum()
        got = pd.to_numeric(df["invoice_amount"], errors="coerce").groupby(df["currency"].str.strip()).sum()
        # payments and credit notes both reduce what the buyer owes
        pay = r[kind.isin(["payment", "pmt", "credit", "credit note"])]
        pexp = pay.assign(v=pay[acol].map(amt)).groupby(pay[ccol].str.strip())["v"].sum()
        pgot = pd.to_numeric(df["amount_paid"], errors="coerce").groupby(df["currency"].str.strip()).sum()
        for cur, val in pexp.items():
            g = float(pgot.get(cur, 0))
            if abs(g - val) > max(1.0, 0.005 * val):
                problems.append(f"RECONCILIATION FAILED for {cur} payments: sum of amount_paid is {g:,.2f} but raw payment and credit rows total {val:,.2f}. "
                                f"Match payment rows case- and whitespace-insensitively (e.g. 'payment ', 'Pmt', 'PAYMENT'), count Credit rows as payments, and drop exact duplicate rows first.")
        for cur, val in expect.items():
            g = float(got.get(cur, 0))
            if abs(g - val) > max(1.0, 0.005 * val):
                problems.append(f"RECONCILIATION FAILED for {cur}: sum of invoice_amount is {g:,.2f} but the raw invoice rows total {val:,.2f}. "
                                f"Check amount parsing (symbols like £ € $, codes like 'USD 8,200' or ' GBP', thousands commas, and European format like €12.400,50 = 12400.50) and that every invoice row ('Invoice', 'INV', 'invoice') is counted.")
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
import os, json
p = "/work/site/index.html"
problems = []
if not os.path.exists(p): problems.append("/work/site/index.html was not created")
else:
    s = open(p, encoding="utf-8").read()
    low = s.lower()
    if "<html" not in low: problems.append("dashboard is not an HTML document")
    if "<script src" in low or 'rel="stylesheet" href="http' in low: problems.append("dashboard must not load external assets")
    w = json.load(open("/work/winner.json"))
    missing = [r["invoice_id"] for r in w.get("top", []) if str(r["invoice_id"]) not in s]
    if missing: problems.append(f"dashboard is missing the winner's top invoices {missing} — read them from winner.json['top']")
    d = json.load(open("/work/drafts.json"))
    gone = [m["invoice_id"] for m in d if m.get("subject") and m["subject"][:25] not in s]
    if gone: problems.append(f"dashboard is missing approved message cards for {gone} — show each draft's subject and body")
    summ = json.load(open("/work/clean_summary.json"))
    curs = list((summ.get("total_outstanding_by_currency") or {}).keys())
    if curs and not all(c in s for c in curs): problems.append(f"dashboard must show outstanding totals for each currency {curs}")
print("\n".join(problems))
`;
