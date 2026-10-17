// One recovery "case": upload → clean (self-fixing) → fork strategies → compare → pause for approval → resume → publish.
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { audit } from "./audit.mjs";
import { chat } from "./llm.mjs";
import { cleanTask, strategyTask, dashboardTask, DRAFT_SYSTEM, compareAndDraftTask } from "./prompts.mjs";
import { writeRunFix, VALIDATE_CLEAN, VALIDATE_STRATEGY, VALIDATE_DASHBOARD } from "./agent.mjs";
import * as box from "./sandbox.mjs";

const STRATEGIES = { A: "Largest first", B: "Oldest first", C: "Most likely to pay" };
const cases = new Map();

export const getCase = (id) => cases.get(id);

function newCase(filename) {
  const id = randomUUID().slice(0, 8);
  const c = {
    id, filename, status: "running", createdAt: new Date().toISOString(),
    history: [], listeners: new Set(), sandboxes: {}, handles: {}, result: null,
  };
  c.emit = (event) => {
    const e = { ...event, at: new Date().toISOString() };
    c.history.push(e);
    for (const fn of c.listeners) fn(e);
    const { code, ...rest } = event; // keep the audit row small; code is logged separately
    audit(id, event.type + (event.phase ? `:${event.phase}` : ""), code ? { ...rest, code_chars: code.length } : rest);
  };
  cases.set(id, c);
  return c;
}

const stage = (c, key, label, status, extra = {}) => c.emit({ type: "stage", key, label, status, ...extra });
const sbEvent = (c, role, sb, status, extra = {}) => {
  c.sandboxes[role] = { id: sb.id, status, ...(c.sandboxes[role] || {}), ...extra, status };
  c.emit({ type: "sandbox", role, id: sb.id, status, ...extra });
};

function preview(csvText) {
  const lines = csvText.replace(/\r/g, "").split("\n").filter(Boolean);
  const columns = lines[0].split(",").map((s) => s.trim());
  return { columns, sampleRows: lines.slice(0, 7).join("\n"), rows: lines.length - 1 };
}

export function startCase({ filename, csv }) {
  const c = newCase(filename);
  runAnalysis(c, csv).catch(async (err) => {
    c.status = "error";
    c.emit({ type: "error", message: err.message });
    await cleanupCase(c).catch(() => {}); // never leave orphaned sandboxes eating quota
  });
  return c;
}

async function runAnalysis(c, csv) {
  const meta = preview(csv);
  c.emit({ type: "case", id: c.id, filename: c.filename, rows: meta.rows, columns: meta.columns, config: config.llm.model });

  // 1. Base sandbox, locked down from the start
  stage(c, "base", "Create locked-down CreateOS sandbox", "active");
  const base = await box.createBase(`kk-${c.id}-base`);
  c.handles.base = base;
  sbEvent(c, "base", base, "running", { shape: config.sandbox.shape });
  const eg = await box.lockAndVerifyEgress(base);
  c.emit({ type: "egress", role: "base", ...eg });
  if (!eg.blocked) throw new Error("Egress lock did not block outbound traffic — refusing to load financial data.");
  await box.upload(base, "/work/input.csv", csv);
  await box.upload(base, "/work/asof.txt", config.asOf);
  stage(c, "base", "Create locked-down CreateOS sandbox", "done");

  // 2. Agent writes, runs and fixes the cleaning script
  stage(c, "clean", "Agent writes & fixes clean.py", "active");
  const clean = await writeRunFix({
    sb: base, name: "clean.py", validator: VALIDATE_CLEAN, emit: c.emit,
    task: cleanTask({ asOf: config.asOf, columns: meta.columns, sampleRows: meta.sampleRows, filename: "input.csv" }),
  });
  const summary = JSON.parse(await box.download(base, "/work/clean_summary.json"));
  c.result = { summary };
  c.emit({ type: "summary", summary, attempts: clean.attempts });
  stage(c, "clean", "Agent writes & fixes clean.py", "done", { attempts: clean.attempts });

  // 3. Agent writes the strategy engine once, tested on branch A inside the base
  stage(c, "strategy", "Agent writes & tests strategy.py", "active");
  const strat = await writeRunFix({
    sb: base, name: "strategy.py", args: ["A"], validator: VALIDATE_STRATEGY, emit: c.emit, task: strategyTask(),
  });
  stage(c, "strategy", "Agent writes & tests strategy.py", "done", { attempts: strat.attempts });

  // 4. Snapshot the base and fork three isolated branches
  stage(c, "fork", "Pause base → fork 3 strategy branches", "active");
  await box.pause(base);
  sbEvent(c, "base", base, "paused");

  const results = {};
  // Forks are cloned one at a time (the parent snapshot is busy while forking)…
  for (const [letter, name] of Object.entries(STRATEGIES)) {
    const child = await box.fork(base);
    c.handles[`fork-${letter}`] = child;
    sbEvent(c, `fork-${letter}`, child, "running", { strategy: `${letter} · ${name}` });
  }
  // The snapshot has done its job — free its slot before the branches run.
  await box.destroyQuietly(base);
  sbEvent(c, "base", base, "destroyed", { note: "snapshot forked ×3, then destroyed" });

  // …then all three branches lock down and run in parallel.
  await Promise.all(Object.entries(STRATEGIES).map(async ([letter, name]) => {
    const role = `fork-${letter}`;
    const child = c.handles[role];
    const lock = await box.lockAndVerifyEgress(child);
    c.emit({ type: "egress", role, ...lock });
    if (!lock.blocked) throw new Error(`Fork ${letter} could reach the internet — aborting.`);
    const run = await box.runPython(child, "/work/strategy.py", [letter]);
    if (!run.ok) {
      sbEvent(c, role, child, "failed");
      c.emit({ type: "branch", letter, name, ok: false, error: run.stderr.slice(-800) });
      return;
    }
    results[letter] = JSON.parse(await box.download(child, `/work/strategy_${letter}.json`));
    c.emit({ type: "branch", letter, name, ok: true, result: results[letter], ms: run.ms });
  }));
  if (!Object.keys(results).length) throw new Error("All strategy branches failed.");
  stage(c, "fork", "Pause base → fork 3 strategy branches", "done");

  // 5. Compare and draft (LLM sees only the ranked summaries, not the raw ledger)
  stage(c, "compare", "Compare strategies & draft messages", "active");
  const decision = await chat(
    [{ role: "system", content: DRAFT_SYSTEM }, { role: "user", content: compareAndDraftTask({ results, asOf: config.asOf }) }],
    { json: true, maxTokens: 3000 },
  );
  const winner = results[decision.winner] ? decision.winner : Object.keys(results)[0];
  c.result = { ...c.result, results, winner, reasoning: decision.reasoning, drafts: decision.drafts || [] };
  c.emit({ type: "decision", winner, name: STRATEGIES[winner], reasoning: decision.reasoning, drafts: c.result.drafts });
  stage(c, "compare", "Compare strategies & draft messages", "done");

  // 6. Keep only the winner; pause it while the human decides
  await Promise.all(Object.keys(STRATEGIES).filter((l) => l !== winner).map(async (l) => {
    const h = c.handles[`fork-${l}`];
    if (h) { await box.destroyQuietly(h); sbEvent(c, `fork-${l}`, h, "destroyed"); }
  }));
  const win = c.handles[`fork-${winner}`];
  await box.pause(win);
  sbEvent(c, `fork-${winner}`, win, "paused", { note: "waiting for your approval — compute billing stopped" });
  c.status = "awaiting_approval";
  stage(c, "approve", "Waiting for your approval", "active");
}

export async function approveCase(c, drafts) {
  if (c.status !== "awaiting_approval") throw new Error(`Case is ${c.status}, not awaiting approval`);
  c.status = "publishing";
  const winner = c.result.winner;
  const win = c.handles[`fork-${winner}`];
  c.result.approvedDrafts = drafts;
  c.emit({ type: "approved", count: drafts.length });
  stage(c, "approve", "Waiting for your approval", "done");

  try {
    stage(c, "publish", "Resume → build dashboard → live URL", "active");
    await box.resume(win);
    sbEvent(c, `fork-${winner}`, win, "running", { note: "resumed exactly where it paused" });
    await win.sh(`cp /work/strategy_${winner}.json /work/winner.json`);
    await box.upload(win, "/work/drafts.json", JSON.stringify(drafts, null, 2));

    const dash = await writeRunFix({
      sb: win, name: "build_dashboard.py", validator: VALIDATE_DASHBOARD, emit: c.emit,
      task: dashboardTask({ title: `KollyKode recovery plan · ${STRATEGIES[winner]}` }),
    });
    const url = await box.publishSite(win);
    c.result.url = url;
    c.status = "done";
    c.emit({ type: "published", url, attempts: dash.attempts });
    stage(c, "publish", "Resume → build dashboard → live URL", "done");
  } catch (err) {
    c.status = "awaiting_approval"; // keep the paused sandbox; the owner can click Approve again
    c.emit({ type: "error", message: `${err.message} — the sandbox is still paused, click Approve to retry.`, retryable: true });
    return;
    c.emit({ type: "error", message: err.message });
  }
}

export async function cleanupCase(c) {
  for (const [role, h] of Object.entries(c.handles)) {
    if (c.sandboxes[role]?.status === "destroyed") continue;
    await box.destroyQuietly(h);
    sbEvent(c, role, h, "destroyed");
  }
  c.status = c.status === "done" ? "done" : "closed";
}
