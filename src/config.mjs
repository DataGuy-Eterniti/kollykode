// Loads .env (written by `stripe projects env --pull`) and resolves settings.
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  try { process.loadEnvFile(".env"); } catch (e) { console.warn("Could not read .env:", e.message); }
}

const env = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
};

// Find a variable whose NAME contains all the given fragments (Stripe Projects
// may prefix names by provider, e.g. OPENROUTER_..._API_KEY).
const envLike = (...fragments) => {
  const key = Object.keys(process.env).find((k) =>
    fragments.every((f) => k.toUpperCase().includes(f)) && process.env[k]?.trim());
  return key ? process.env[key].trim() : undefined;
};

const groqKey = env("GROQ_API_KEY");
const openrouterKey = env("OPENROUTER_API_KEY", "OPENROUTER_KEY") || envLike("OPENROUTER", "KEY");
const provider = (env("LLM_PROVIDER") || (groqKey ? "groq" : "openrouter")).toLowerCase();

const PROVIDERS = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: groqKey,
    model: env("LLM_MODEL") || "openai/gpt-oss-120b",
    fastModel: env("LLM_FAST_MODEL") || "openai/gpt-oss-20b",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: openrouterKey,
    model: env("LLM_MODEL") || "meta-llama/llama-3.3-70b-instruct:free",
    fastModel: env("LLM_FAST_MODEL") || "",
  },
};

export const config = {
  port: Number(env("PORT") || 3000),
  asOf: env("AS_OF_DATE") || new Date().toISOString().slice(0, 10),
  sandbox: {
    // Prefer an explicit sandbox key; otherwise use the key Stripe Projects provisioned for CreateOS.
    apiKey: env("CREATEOS_SANDBOX_API_KEY", "CREATEOS_PROJECT_API_KEY", "CREATEOS_PLAN_API_KEY", "CREATEOS_API_KEY"),
    keySource: ["CREATEOS_SANDBOX_API_KEY", "CREATEOS_PROJECT_API_KEY", "CREATEOS_PLAN_API_KEY", "CREATEOS_API_KEY"]
      .find((n) => process.env[n]?.trim()),
    baseUrl: env("CREATEOS_SANDBOX_BASE_URL") || "https://api-eu.sb.createos.sh",
    shape: env("SANDBOX_SHAPE") || "s-1vcpu-1gb",
    rootfs: "devbox:1",
    // CreateOS treats an EMPTY allowlist as "allow all". A single loopback
    // entry is how we say "no internet at all".
    lockedEgress: ["127.0.0.1"],
  },
  llm: { provider, ...(PROVIDERS[provider] || PROVIDERS.groq) },
  databaseUrl: env("NEON_POSTGRES_CONNECTION_STRING", "DATABASE_URL", "POSTGRES_URL") || envLike("POSTGRES", "CONNECTION"),
  maxFixAttempts: 4,
};

export function describeConfig() {
  return {
    sandboxEndpoint: config.sandbox.baseUrl,
    sandboxKey: config.sandbox.apiKey ? `set (${config.sandbox.keySource})` : "MISSING",
    llm: `${config.llm.provider} · ${config.llm.model}`,
    llmKey: config.llm.apiKey ? "set" : "MISSING",
    database: config.databaseUrl ? "Postgres" : "local file (runs/audit.jsonl)",
    asOf: config.asOf,
  };
}
