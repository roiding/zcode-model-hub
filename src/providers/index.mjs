// Provider "dialects": endpoint candidates, auth headers and response parsing
// for OpenAI-compatible, Anthropic and Gemini style endpoints. Used by the
// CLI layer. The copy injected into the Electron main process re-implements
// the same rules inline (self-contained snippet, no imports possible).
// API keys are never logged or persisted outside the user's own config.

export function normalizeBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

export function guessDialect(baseUrl) {
  const b = normalizeBase(baseUrl).toLowerCase();
  if (b.includes("anthropic") || b.includes("claude")) return "anthropic";
  if (b.includes("generativelanguage") || b.includes("googleapis")) return "gemini";
  return "openai";
}

export function candidatesFor(dialect, baseUrl) {
  const base = normalizeBase(baseUrl);
  const endsV1 = /\/v1$/.test(base);
  if (dialect === "anthropic") {
    return endsV1 ? [`${base}/models`] : [`${base}/v1/models`];
  }
  if (dialect === "gemini") {
    const root = base.replace(/\/v1(beta)?$/, "");
    return [`${root}/v1beta/models`];
  }
  // openai-compatible: try the most common paths first
  const cands = [];
  if (endsV1) {
    cands.push(`${base}/models`);
    cands.push(`${base.replace(/\/v1$/, "")}/models`);
  } else {
    cands.push(`${base}/v1/models`);
    cands.push(`${base}/models`);
  }
  if (/\/api$/.test(base)) {
    cands.unshift(`${base}/v1/models`);
    cands.push(`${base.replace(/\/api$/, "")}/v1/models`);
  }
  return [...new Set(cands)];
}

export function authHeaders(dialect, apiKey, extraHeaders) {
  const h = { Accept: "application/json", ...(extraHeaders || {}) };
  if (dialect === "anthropic") {
    if (apiKey) {
      h["x-api-key"] = apiKey.trim();
      h["Authorization"] = `Bearer ${apiKey.trim()}`;
    }
    h["anthropic-version"] = h["anthropic-version"] || "2023-06-01";
  } else if (dialect === "gemini") {
    if (apiKey) h["x-goog-api-key"] = apiKey.trim();
  } else if (apiKey) {
    h["Authorization"] = `Bearer ${apiKey.trim()}`;
  }
  return h;
}

const VISION_RE =
  /(4o|4\.1|omni|vision|vl-|-vl|glm-4v|glm-5v|gemini|claude-[3-9]|pixtral|llava|internvl|gpt-5)/i;

export function visionGuess(id) {
  return VISION_RE.test(id || "");
}

// Accepts the response shapes seen in the wild per dialect; returns [{id}].
export function parseModelsResponse(dialect, json) {
  const out = [];
  const push = (raw) => {
    const id = typeof raw === "string" ? raw.trim() : String(raw?.id ?? raw?.name ?? "").trim();
    if (id) out.push(id.replace(/^models\//, ""));
  };
  const list = Array.isArray(json)
    ? json
    : Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : [];
  for (const item of list) push(item);
  return [...new Set(out)].sort().map((id) => ({ id, visionGuess: visionGuess(id) }));
}

export async function fetchModels(baseUrl, apiKey, { dialect = "auto", headers, timeoutMs = 10000, signal } = {}) {
  const dialects = dialect === "auto" ? ["openai", "anthropic", "gemini"] : [dialect];
  const errors = [];
  for (const d of dialects) {
    for (const url of candidatesFor(d, baseUrl)) {
      const target =
        d === "gemini" && !url.includes("key=") && apiKey
          ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey.trim())}`
          : url;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
        const res = await fetch(target, { headers: authHeaders(d, apiKey, headers), signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) {
          errors.push(`${d} ${redactUrl(target)} -> HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        const models = parseModelsResponse(d, json);
        if (models.length) return { ok: true, dialect: d, models };
        errors.push(`${d} ${redactUrl(target)} -> 0 models`);
      } catch (e) {
        errors.push(`${d} ${redactUrl(target)} -> ${e.name === "AbortError" ? "timeout" : e.message}`);
      }
    }
  }
  return { ok: false, error: errors.join("; ") };
}

export function redactUrl(url) {
  return String(url).replace(/([?&])key=[^&]*/g, "$1key=***");
}

// Empirical vision probe: send a 1x1 PNG and see whether the model accepts it.
export const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function probeVision(baseUrl, apiKey, model, { dialect = "auto", headers, timeoutMs = 15000 } = {}) {
  const base = normalizeBase(baseUrl);
  const attempts =
    dialect === "auto" ? ["openai", "anthropic"] : [dialect];
  for (const d of attempts) {
    const url =
      d === "anthropic"
        ? `${/\/v1$/.test(base) ? base : `${base}/v1`}/messages`
        : `${/\/v1$/.test(base) ? base : `${base}/v1`}/chat/completions`;
    const body =
      d === "anthropic"
        ? {
            model,
            max_tokens: 10,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Reply with one word: OK" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } },
                ],
              },
            ],
          }
        : {
            model,
            max_tokens: 10,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Reply with one word: OK" },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX}` } },
                ],
              },
            ],
          };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(d, apiKey, headers) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const text = await res.text();
      if (res.ok) return { ok: true, vision: true, dialect: d };
      if (res.status === 400 && /image|multimodal|vision|modalit/i.test(text))
        return { ok: true, vision: false, dialect: d, detail: "rejected image input" };
      if (res.status === 404) continue;
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    } catch (e) {
      if (d === attempts[attempts.length - 1])
        return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
    }
  }
  return { ok: false, error: "no endpoint accepted the probe" };
}
