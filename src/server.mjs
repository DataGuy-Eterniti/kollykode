// KollyKode web server: serves the UI and streams agent events over SSE.
import http from "node:http";
import { readFileSync } from "node:fs";
import { config, describeConfig } from "./config.mjs";
import { auditBackend, auditTrail } from "./audit.mjs";
import { startCase, getCase, approveCase, cleanupCase } from "./pipeline.mjs";

const page = () => readFileSync(new URL("../public/index.html", import.meta.url));
const sample = () => readFileSync(new URL("../sample-data/receivables.csv", import.meta.url), "utf8");

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
    if (req.method === "GET" && url.pathname === "/api/config") return send(res, 200, { ...describeConfig(), audit: auditBackend() });
    if (req.method === "GET" && url.pathname === "/api/sample") return send(res, 200, sample(), "text/csv; charset=utf-8");

    if (parts[0] === "api" && parts[1] === "cases") {
      if (req.method === "POST" && parts.length === 2) {
        const { filename = "receivables.csv", csv } = await readJson(req);
        if (!csv || csv.split("\n").length < 2) return send(res, 400, { error: "Upload a CSV with a header and at least one row." });
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

server.listen(config.port, () => {
  console.log(`\n  KollyKode running → http://localhost:${config.port}\n`);
  console.table(describeConfig());
});
