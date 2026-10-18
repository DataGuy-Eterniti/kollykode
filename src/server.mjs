// KollyKode web server: serves the UI and streams agent events over SSE.
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { config, describeConfig } from "./config.mjs";
import { auditBackend, auditTrail } from "./audit.mjs";
import { startCase, getCase, busyCase, approveCase, cleanupCase } from "./pipeline.mjs";

// Optional access code for public deploys: guards every POST (the routes that spend sandbox and LLM quota).
const PASSCODE = process.env.DEMO_PASSCODE?.trim();
const allowed = (req) => !PASSCODE || req.headers["x-kk-passcode"] === PASSCODE;

const page = () => readFileSync(new URL("../public/index.html", import.meta.url));
const SAMPLES = new URL("../sample-data/", import.meta.url);
// Only exact file names listed in sample-data/ are served — no paths, no traversal.
const sample = (name) => (readdirSync(SAMPLES).includes(name) && /^[\w-]+\.csv$/.test(name)
  ? readFileSync(new URL(name, SAMPLES), "utf8") : null);

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const readJson = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > 5_000_000) { reject(new Error("File too large (5 MB max)")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

const publicState = (c) => ({ id: c.id, filename: c.filename, status: c.status, sandboxes: c.sandboxes, result: c.result });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, page(), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok", "text/plain; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/config") return send(res, 200, { ...describeConfig(), audit: auditBackend(), passcodeRequired: Boolean(PASSCODE) });
    if (req.method === "POST" && !allowed(req)) return send(res, 401, { error: "Access code required" });
    if (req.method === "GET" && url.pathname === "/api/sample") {
      const csv = sample(url.searchParams.get("name") || "receivables.csv");
      return csv === null ? send(res, 400, { error: "Unknown sample file" }) : send(res, 200, csv, "text/csv; charset=utf-8");
    }

    if (parts[0] === "api" && parts[1] === "cases") {
      if (req.method === "POST" && parts.length === 2) {
        const { filename = "receivables.csv", csv } = await readJson(req);
        if (!csv || csv.split("\n").length < 2) return send(res, 400, { error: "Upload a CSV with a header and at least one row." });
        if (busyCase()) return send(res, 429, { error: "Another run is in progress — try again in a few minutes." });
        const c = startCase({ filename, csv });
        return send(res, 201, { id: c.id });
      }
      const c = getCase(parts[2]);
      if (!c) return send(res, 404, { error: "No such case" });

      if (req.method === "GET" && parts[3] === "events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        c.history.forEach(write);
        c.listeners.add(write);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => { c.listeners.delete(write); clearInterval(ping); });
        return;
      }
      if (req.method === "GET" && parts.length === 3) return send(res, 200, publicState(c));
      if (req.method === "GET" && parts[3] === "audit") return send(res, 200, (await auditTrail(c.id)) || c.history);
      if (req.method === "POST" && parts[3] === "approve") {
        const { drafts } = await readJson(req);
        if (!Array.isArray(drafts) || !drafts.length) return send(res, 400, { error: "Approve at least one message." });
        if (c.status !== "awaiting_approval") return send(res, 409, { error: `This run is ${c.status} and can no longer be approved.` });
        approveCase(c, drafts).catch(() => {});
        return send(res, 202, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "cleanup") {
        await cleanupCase(c);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`\n  KollyKode running → http://localhost:${config.port}\n`);
  console.table(describeConfig());
});
