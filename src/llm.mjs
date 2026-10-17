// Minimal OpenAI-compatible chat client (works for Groq and OpenRouter).
// If the configured model is retired, it asks the provider which models exist and picks a good one.
import { config } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let activeModel = config.llm.model;
let resolving = null;

// Preference order for auto-picking a model (first pattern that matches wins).
const PREFS = [/gpt-oss-120b/i, /llama-4-maverick/i, /kimi-k2/i, /qwen3?-.*(235|32)b/i, /llama-3\.3-70b/i, /deepseek/i, /llama-4-scout/i, /70b/i, /gpt-oss-20b/i, /llama/i];
const SKIP = /whisper|tts|guard|embed|vision-only|audio|playai|compound|moderation|rerank/i;

export const currentModel = () => activeModel;

export async function listModels() {
  const { baseUrl, apiKey } = config.llm;
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Could not list models (${res.status})`);
  const data = await res.json();
  let ids = (data.data || []).map((m) => m.id).filter((id) => !SKIP.test(id));
  if (config.llm.provider === "openrouter") ids = ids.filter((id) => id.endsWith(":free"));
  return ids;
}

async function pickModel() {
  const ids = await listModels();
  for (const p of PREFS) {
    const hit = ids.find((id) => p.test(id));
    if (hit) return hit;
  }
  if (ids.length) return ids[0];
  throw new Error("No usable chat models available for this key.");
}

async function call(messages, { json, temperature, maxTokens, model }) {
  const { baseUrl, apiKey } = config.llm;
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-Title": "KollyKode" },
    body: JSON.stringify({
      model: model || activeModel, messages, temperature, max_tokens: maxTokens,
      // gpt-oss "thinks" before answering; keep that short so we stay inside free-tier token limits.
      ...(/gpt-oss/.test(model || activeModel) ? { reasoning_effort: "low" } : {}),
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
}

export async function chat(messages, { json = false, temperature = 0.2, maxTokens = 3000, model } = {}) {
  if (!config.llm.apiKey) throw new Error(`No API key for LLM provider "${config.llm.provider}". Check .env.`);
  let useJsonMode = json;
  let swapped = false;

  for (let attempt = 1; attempt <= 7; attempt++) {
    const res = await call(messages, { json: useJsonMode, temperature, maxTokens, model });

    if (res.status === 429 || res.status === 413 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after")) || attempt * 5;
      await sleep(Math.min(retryAfter, 30) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      // Retired / unavailable model → discover a current one once.
      // A per-call override that doesn't exist → just use the main model.
      if (model && (res.status === 404 || /model_not_found|does not exist/i.test(body))) { model = undefined; continue; }
      if (!swapped && (res.status === 404 || /model_not_found|does not exist|decommissioned|not a valid model/i.test(body))) {
        resolving ||= pickModel().finally(() => { resolving = null; });
        const old = activeModel;
        activeModel = await resolving;
        swapped = true;
        console.warn(`LLM model "${old}" unavailable → using "${activeModel}"`);
        continue;
      }
      // Some models reject JSON mode → retry without it.
      if (useJsonMode && res.status === 400 && /response_format|json/i.test(body)) {
        useJsonMode = false;
        continue;
      }
      throw new Error(`LLM error ${res.status}: ${body.slice(0, 400)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!json) return text;
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error("LLM did not return valid JSON");
    }
  }
  throw new Error("LLM rate-limited too many times. Wait a minute and retry.");
}

// Pull the Python out of a fenced reply; fall back to the whole reply.
export function extractPython(text) {
  const fenced = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim() + "\n";
}
