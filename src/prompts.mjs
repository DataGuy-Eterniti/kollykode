// Prompts for every piece of code the agent writes.

export const SYSTEM = `You are KollyKode, an engineer agent that writes Python 3.13 scripts which run inside an isolated Linux sandbox.
Rules:
- The sandbox has pandas available and NO internet access. Never use network calls or install packages.
- Use only absolute paths under /work.
- Return exactly ONE fenced \`\`\`python code block and nothing else.
- Scripts must be deterministic and print a short summary at the end.`;

export function cleanTask({ asOf, columns, sampleRows, filename }) {
  return `Write /work/clean.py.

Input: /work/${filename} — an accounts-receivable export from a small exporter. It is messy:
mixed date formats, amounts stored as text with currency symbols, codes and commas,
payments recorded as separate rows sharing an invoice number, inconsistent "type" values,
inconsistent customer-name casing, possible duplicate rows, and blank due dates.

Columns: ${JSON.stringify(columns)}
First rows (raw):
${sampleRows}

Produce /work/clean.csv with EXACTLY one row per invoice and these columns, in order:
invoice_id, buyer, currency, invoice_amount, amount_paid, outstanding, issue_date, due_date,
days_overdue, aging_bucket, part_payment_count, last_payment_date

Definitions:
- As-of date is ${asOf}.
- invoice_amount comes from the invoice row; amount_paid is the sum of that invoice's payment rows (after dropping exact duplicate rows).
- outstanding = max(invoice_amount - amount_paid, 0), rounded to 2 decimals.
- issue_date, due_date, last_payment_date as YYYY-MM-DD (last_payment_date empty if none).
- If due date is blank, due_date = issue_date + 60 days.
- days_overdue = max((as-of - due_date).days, 0).
- aging_bucket is one of: "current", "1-30", "31-60", "61-90", "90+" (current = not yet overdue).
- part_payment_count = number of payment rows for the invoice.
- buyer: one consistent name per buyer (title case is fine).
Also write /work/clean_summary.json with keys: invoices, total_outstanding_by_currency, buckets.`;
}

export function strategyTask() {
  return `Write /work/strategy.py. It is run as: python3 /work/strategy.py <A|B|C>
It reads /work/clean.csv (columns: invoice_id, buyer, currency, invoice_amount, amount_paid,
outstanding, issue_date, due_date, days_overdue, aging_bucket, part_payment_count, last_payment_date).

Consider only rows with outstanding > 0. Rank them by strategy:
- A "Largest first": outstanding descending.
- B "Oldest first": days_overdue descending, then outstanding descending.
- C "Most likely to pay": score = 2*part_payment_count + (1 if last_payment_date within 60 days of the as-of date else 0), descending, then outstanding descending. Read the as-of date (YYYY-MM-DD) from /work/asof.txt.

Write /work/strategy_<letter>.json with:
{ "strategy": letter, "name": strategy name,
  "top": [ up to 5 rows as objects with invoice_id, buyer, currency, outstanding, days_overdue, aging_bucket, part_payment_count ],
  "metrics": { "invoices_targeted": int, "buyers_contacted": int,
               "outstanding_covered_by_currency": {currency: amount},
               "avg_days_overdue": float, "share_of_total_outstanding_pct": float } }
share_of_total_outstanding_pct is the targeted outstanding as a share of all outstanding, computed per currency then averaged.
Print the JSON at the end.`;
}

export function dashboardTask({ title }) {
  return `Write /work/build_dashboard.py.
Inputs: /work/clean.csv, /work/clean_summary.json, /work/winner.json (the chosen strategy output) and
/work/drafts.json (a list of approved follow-up messages: invoice_id, buyer, subject, body).
Output: a single self-contained /work/site/index.html (inline CSS, no external assets, no JavaScript needed) titled "${title}".
It must show: headline totals of outstanding by currency, a table of aging buckets, the chosen strategy and
its top invoices, and each approved message in a readable card. Clean, modern, readable design.`;
}

export function fixTask({ code, error }) {
  return `The script failed or produced invalid output.

Script:
\`\`\`python
${code}
\`\`\`

Error / validation problems:
${error}

Fix the script. Return the complete corrected script.`;
}

export const DRAFT_SYSTEM = `You write short, professional payment follow-up emails for a small business owner to send to a foreign buyer.
Rules: courteous and factual; reference the invoice number, amount outstanding with currency, and due date;
tone by age — under 30 days overdue: friendly reminder; 30–90: firm follow-up; over 90: final courteous request.
Never threaten legal action, never invent fees or penalties, never include bank details or payment links.
Keep each body under 110 words. Sign off as "[Your name]".`;

export function compareAndDraftTask({ results, asOf }) {
  return `As-of date ${asOf}. Three recovery strategies were run in parallel on the same cleaned ledger:
${JSON.stringify(results, null, 2)}

1) Pick the single best strategy for a small exporter who needs cash soon but wants to keep buyer relationships.
2) Draft one follow-up email per invoice in the winner's "top" list.

Return JSON: { "winner": "A"|"B"|"C", "reasoning": "2-3 sentences",
  "drafts": [ { "invoice_id", "buyer", "subject", "body" } ] }`;
}
