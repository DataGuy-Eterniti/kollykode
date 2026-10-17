// Thin wrapper over the CreateOS Sandbox SDK: every lifecycle step the agent uses.
import { Sandbox } from "@nodeops-createos/sandbox";
import { config } from "./config.mjs";

const clientOpts = () => ({
  apiKey: config.sandbox.apiKey,
  baseUrl: config.sandbox.baseUrl, // EU endpoint, set explicitly
});

export const WORKDIR = "/work";

// Retry transient network failures (flaky connections happen; a lost request shouldn't kill a run).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = /network|ECONNRESET|ETIMEDOUT|fetch failed|socket|EAI_AGAIN|timeout/i.test(`${e.name} ${e.message}`);
      if (!transient || i >= tries) throw e;
      await sleep(1500 * i);
    }
  }
}

export async function createBase(name) {
  const sb = await Sandbox.create(
    {
      shape: config.sandbox.shape,
      rootfs: config.sandbox.rootfs,
      name,
      egress: config.sandbox.lockedEgress, // no internet from the first second
      auto_pause_after_seconds: 900,
    },
    clientOpts(),
  );
  await sb.waitUntilRunning();
  await sb.sh(`mkdir -p ${WORKDIR}/site`);
  return sb;
}

export async function connect(id) {
  return Sandbox.connect(id, clientOpts());
}

export async function upload(sb, path, content) {
  await withRetry(() => sb.files.upload(path, content));
}

export async function download(sb, path) {
  const buf = await withRetry(() => sb.files.download(path));
  return new TextDecoder().decode(buf);
}

export async function runPython(sb, scriptPath, args = []) {
  const { result, exec_ms } = await withRetry(() => sb.runCommand("python3", [scriptPath, ...args], { timeoutMs: 180_000 }));
  return {
    ok: result.exit_code === 0 && !result.error,
    exitCode: result.exit_code,
    stdout: (result.stdout || "").slice(-6000),
    stderr: ((result.stderr || "") + (result.error ? `\n${result.error}` : "")).slice(-6000),
    ms: exec_ms,
  };
}

// Force the allowlist to loopback-only and prove it with a real request.
export async function lockAndVerifyEgress(sb) {
  await sb.setEgress(config.sandbox.lockedEgress);
  const { egress } = await sb.getEgress();
  const probe = await sb.runCommand("bash", [
    "-lc",
    "curl -s -m 5 -o /dev/null -w '%{http_code}' https://pypi.org; echo \" exit=$?\"",
  ]);
  const out = (probe.result.stdout || "").trim();
  const blocked = !/^2\d\d/.test(out) && !/exit=0$/.test(out);
  return { allowlist: egress, probe: `curl https://pypi.org → ${out || "no response"}`, blocked };
}

export async function pause(sb) {
  await sb.refresh().catch(() => {});
  if (sb.status !== "paused") await withRetry(() => sb.pause());
  await sb.waitUntilPaused({ timeoutMs: 90_000 });
}

export async function resume(sb) {
  await sb.refresh().catch(() => {});
  if (sb.status === "paused" || sb.status === "pausing") await withRetry(() => sb.resume(), 2);
  await sb.waitUntilRunning({ timeoutMs: 90_000 });
}

export async function fork(parent) {
  const child = await withRetry(() => parent.fork({ start_paused: false }), 1);
  await child.waitUntilRunning({ timeoutMs: 90_000 });
  return child;
}

export async function publishSite(sb, port = 8080, onStep = () => {}) {
  onStep("starting web server inside the sandbox");
  // A managed background process — runCommand would wait on a backgrounded server.
  await withRetry(() => sb.processes.create({ cmd: "python3", args: ["-m", "http.server", String(port), "--bind", "0.0.0.0"], cwd: `${WORKDIR}/site` }));
  await sb.waitForPortReady(port, { timeoutMs: 30_000 });
  onStep("opening the public live URL (ingress)");
  await withRetry(() => sb.setIngress(true));
  return sb.previewUrl(port);
}

export async function destroyQuietly(sb) {
  if (!sb) return;
  try { await sb.destroy(); } catch { /* already gone */ }
}
