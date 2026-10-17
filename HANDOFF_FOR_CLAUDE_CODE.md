# KollyKode — handoff for Claude Code

You are continuing work on **KollyKode**, a hackathon entry for the CreateOS × Stripe Projects
"Build Agents That Run Code" hackathon. **Hard deadline: submissions lock 01:30 Lagos time (WAT).
Feature freeze 23:45 WAT.** Make small, safe changes. Do not refactor.

## What the app does (already working)
Node.js (ESM, no build step) web app. `npm start` → http://localhost:3000.
1. Creates a CreateOS sandbox with egress locked to `127.0.0.1`, proves it with a curl.
2. LLM writes `clean.py` → runs in sandbox → fixed validator + reconciliation → LLM fixes on failure (up to 4 attempts).
3. LLM writes `strategy.py`, tested in the base sandbox.
4. Pauses base → forks 3 branches (A/B/C) → re-locks egress on each → runs strategies in parallel.
5. LLM compares and drafts emails → losers destroyed → winner **paused** for human approval.
6. On approve: **resume** winner → LLM writes `build_dashboard.py` → serve on port 8080 → ingress live URL.

Steps 1–5 work reliably. **Step 6 and occasionally step 4 fail on CreateOS lifecycle timing.**

## Files
| File | Role |
|---|---|
| `src/server.mjs` | HTTP server + SSE event stream |
| `src/pipeline.mjs` | The whole case flow (`runAnalysis`, `approveCase`, `cleanupCase`) |
| `src/sandbox.mjs` | CreateOS SDK wrapper: create, egress lock, pause, fork, resume, publishSite, withRetry |
| `src/agent.mjs` | write→run→validate→fix loop + Python validators (VALIDATE_CLEAN / STRATEGY / DASHBOARD) |
| `src/llm.mjs` | OpenAI-compatible client (Groq / OpenRouter), model auto-pick, retries |
| `src/prompts.mjs` | Prompts for each script the agent writes |
| `src/config.mjs` | Env loading (.env from `stripe projects env --pull`) |
| `src/check.mjs` | `npm run check` preflight |
| `public/index.html` | Single-page UI (handles SSE event types: stage, sandbox, egress, agent, summary, branch, decision, approved, published, error) |

## Facts you must respect
- SDK: `@nodeops-createos/sandbox` v0.8.2. Base URL **must** be `https://api-eu.sb.createos.sh` (already set in config).
- **Free plan quota: 5 sandboxes at once, paused ones count.**
- **Empty egress allowlist = allow ALL.** Lock with `["127.0.0.1"]`. Forks inherit the parent allowlist; we re-lock explicitly.
- `fork()` requires the source to be **paused**.
- Groq free tier: 8,000 tokens/minute — keep prompts small.
- Never print, log or commit `.env` values.

## Observed failures to fix (in this order)

### Fix 1 — `resume` times out after approval (highest priority)
Error seen: `Timed out after 90000ms waiting for the expected state.` (winner stays `paused`).
In `src/sandbox.mjs` → `resume()` and `src/pipeline.mjs` → `approveCase()`:
- Raise the wait to `timeoutMs: 180_000` and poll `sb.refresh()` every 3s, emitting the live status
  into the UI via the existing `onStep`-style note (so the user sees `resuming… (status: resuming)`).
- **Fallback if resume still fails:** the winner is paused, so `fork()` it into a fresh sandbox
  (`start_paused: false`), re-lock egress with `lockAndVerifyEgress`, destroy the old one, and continue
  the publish step on the fork. Emit a note like `resume slow → restored from snapshot via fork`.
  This still demonstrates pause → snapshot → restore.
- Keep the existing behaviour where a failed approve leaves `c.status = "awaiting_approval"` and the
  UI shows "Retry approve & resume".

### Fix 2 — one fork timing out kills the whole run
Seen: Fork C never reached `running` → whole run errored and cleaned up.
In `runAnalysis()` fork loop:
- Use `timeoutMs: 180_000` for `child.waitUntilRunning`.
- If a single fork fails, emit a `branch` event with `ok:false` for that letter, destroy it, and
  **continue with the branches that succeeded**. Only throw if **zero** branches succeed.

### Fix 3 — make waits visible
Anywhere we wait on sandbox state (`pause`, `fork`, `resume`), emit a `sandbox` event with a `note`
showing elapsed seconds every ~5s so the UI never looks frozen.

### Fix 4 (only if time allows) — use the Stripe-provisioned CreateOS key
`config.mjs` already falls back to `CREATEOS_PROJECT_API_KEY` (from Stripe Projects) when
`CREATEOS_SANDBOX_API_KEY` is absent. Test by temporarily commenting out `CREATEOS_SANDBOX_API_KEY`
in `.env` and running `npm run check`. If it passes, leave it commented and tell the user.

## How to verify
1. `node --check src/*.mjs` (each file) — must pass.
2. `npm run check` — 4/4 green.
3. Clear leftover sandboxes first (user runs in Ubuntu/WSL):
   `cos sandbox list --all --quiet | while read id; do cos sandbox rm "$id" --force; done`
4. `npm start` → Use sample ledger → Run agent → Approve → a live URL appears and opens.
5. Correct totals for the sample: **$493,599 · £230,028 · €131,937 outstanding, 40 invoices.**

## Do not
- Do not change validators' reconciliation logic, prompts' output schemas, or the UI palette.
- Do not add dependencies.
- Do not commit `.env`, `.projects/vault/`, `node_modules/`, `runs/`.

## After fixes — commit
```
git add .
git commit -m "Harden fork/resume lifecycle; publish live URL reliably"
git push
```
