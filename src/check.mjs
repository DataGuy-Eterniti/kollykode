// Preflight: `npm run check` proves keys, EU endpoint, sandbox, egress lock and LLM all work.
import { config, describeConfig } from "./config.mjs";
import { chat, currentModel, listModels } from "./llm.mjs";
import * as box from "./sandbox.mjs";

console.table(describeConfig());
let sb;
try {
  process.stdout.write("1/4 Creating sandbox on " + config.sandbox.baseUrl + " … ");
  sb = await box.createBase(`kk-check-${Date.now().toString(36)}`);
  console.log("ok", sb.id);

  process.stdout.write("2/4 Python + pandas … ");
  const r = await sb.runCommand("python3", ["-c", "import pandas,sys;print(sys.version.split()[0], pandas.__version__)"]);
  console.log(r.result.stdout.trim() || r.result.stderr);

  process.stdout.write("3/4 Egress lock … ");
  const eg = await box.lockAndVerifyEgress(sb);
  console.log(eg.blocked ? "BLOCKED (good)" : "NOT BLOCKED (bad)", "|", eg.allowlist.join(","), "|", eg.probe);

  process.stdout.write("4/4 LLM " + config.llm.model + " … ");
  const reply = await chat([{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 300 });
  console.log(reply.trim(), "| model in use:", currentModel());
  try { console.log("   available:", (await listModels()).slice(0, 12).join(", ")); } catch {}
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  await box.destroyQuietly(sb);
  console.log("cleaned up");
}
