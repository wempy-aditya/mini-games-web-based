/**
 * LLM / decision-model client.
 *
 * The user supplies an API URL, API key and model name by hand, so this client
 * deliberately speaks TWO dialects and lets the settings screen choose:
 *
 *  - `systemone` — TypeSafe's Jev. NOT a chat model. It takes a `state` plus a
 *    map of typed questions and returns typed answers with calibrated confidence:
 *      noul   -> { noul: 0..1, confidence? }
 *      choice -> { choice: "<key>", confidence?, probabilities: {k: p} }
 *      score  -> { score: <index>, confidence?, legend, probabilities }
 *    Endpoint: POST {base}/v1/systemone  (e.g. base = https://api.typesafe.ai)
 *
 *  - `openai` — any OpenAI-compatible /chat/completions endpoint. Used for
 *    plain text models. Parsed defensively: we ask for JSON and accept both
 *    raw JSON and JSON embedded in a fenced code block.
 *
 * Why a client at all, rather than calling fetch from the game? Because every
 * game needs the same thing — and the monorepo forbids cross-game imports, so
 * each game carries its own copy. This copy is the reference implementation.
 *
 * Security note: the API key lives in localStorage because a static browser game
 * has nowhere else to put it. It is never logged, never sent anywhere except the
 * URL the user typed, and the settings UI masks it.
 */

const STORAGE_KEY = 'minigames.llm.config.v1';

export const DIALECT = {
  SYSTEMONE: 'systemone',
  OPENAI: 'openai',
};

export const DEFAULT_CONFIG = {
  dialect: DIALECT.SYSTEMONE,
  baseUrl: 'https://api.typesafe.ai',
  apiKey: '',
  model: 'jev-latest',
  temperature: 0.7,
  maxTokens: 400,
  timeoutMs: 15000,
  enabled: false,
};

// ── config persistence ─────────────────────────────────────────────────────

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

export function clearConfig() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function isConfigured(cfg = loadConfig()) {
  return Boolean(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model);
}

// ── url helpers ───────────────────────────────────────────────────────────

/** Strip trailing slashes and a trailing /v1 so callers can paste either. */
export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function endpointFor(cfg) {
  const base = normalizeBase(cfg.baseUrl);
  return cfg.dialect === DIALECT.SYSTEMONE
    ? `${base}/v1/systemone`
    : `${base}/v1/chat/completions`;
}

// ── request builders ───────────────────────────────────────────────────────

/**
 * Build a Jev System One request.
 * `questions` maps a key to `{ type, instructions, criteria }`, where criteria is
 * required for `choice` (object of option -> description) and `score` (array).
 */
export function buildSystemOneRequest(state, questions, cfg) {
  const q = {};
  for (const [key, spec] of Object.entries(questions)) {
    const entry = { type: spec.type, instructions: spec.instructions };
    if (spec.criteria) entry.criteria = spec.criteria;
    q[key] = entry;
  }
  return {
    state: typeof state === 'string' ? state : JSON.stringify(state),
    model: cfg.model,
    questions: q,
  };
}

/** Build an OpenAI chat request asking for a strict JSON object back. */
export function buildChatRequest(system, user, cfg) {
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

// ── response parsing ───────────────────────────────────────────────────────

/**
 * Pull a JSON object out of a model reply. Handles a bare object, a fenced
 * ```json block, and an object embedded in surrounding prose. Returns null when
 * nothing parses, so callers can fall back rather than crash.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();

  try { return JSON.parse(trimmed); } catch { /* keep trying */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* keep trying */ }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

/** Pull the first user-visible text out of an OpenAI-compatible response. */
export function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return '';
}

// ── transport ──────────────────────────────────────────────────────────────

async function postJson(url, body, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }

    if (!res.ok) {
      const msg = data?.error?.message || data?.message || text.slice(0, 200) || res.statusText;
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (!data) {
      const err = new Error('Server returned a non-JSON body');
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Ask a System One (Jev) model a set of typed questions.
 * Returns `{ ok, answers, model, usage, ms, error }`.
 */
export async function askSystemOne(state, questions, cfg = loadConfig()) {
  const t0 = performance.now();
  try {
    const body = buildSystemOneRequest(state, questions, cfg);
    const data = await postJson(endpointFor(cfg), body, cfg);
    return {
      ok: true,
      answers: data.answers || {},
      model: data.model || cfg.model,
      escalate: Boolean(data.escalate),
      usage: data.usage || null,
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    return {
      ok: false,
      answers: {},
      error: err.name === 'AbortError' ? `Timed out after ${cfg.timeoutMs}ms` : err.message,
      status: err.status,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/**
 * Ask an OpenAI-compatible model to answer with JSON matching `shapeHint`.
 * The caller parses the result; this function only handles transport + extraction.
 */
export async function askChat(system, user, cfg = loadConfig()) {
  const t0 = performance.now();
  try {
    const body = buildChatRequest(system, user, cfg);
    const data = await postJson(endpointFor(cfg), body, cfg);
    const text = extractChatText(data);
    return {
      ok: true,
      text,
      json: extractJson(text),
      usage: data.usage || null,
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      json: null,
      error: err.name === 'AbortError' ? `Timed out after ${cfg.timeoutMs}ms` : err.message,
      status: err.status,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/**
 * Dispatch to whichever dialect the config selects. For System One, `questions`
 * is required; for chat, `system`/`user` are required.
 */
export async function ask(payload, cfg = loadConfig()) {
  return cfg.dialect === DIALECT.SYSTEMONE
    ? askSystemOne(payload.state, payload.questions, cfg)
    : askChat(payload.system, payload.user, cfg);
}

/**
 * A cheap connectivity check for the settings screen. Sends the smallest useful
 * request for the dialect and reports what came back.
 */
export async function testConnection(cfg = loadConfig()) {
  if (!cfg.baseUrl) return { ok: false, error: 'API URL is empty' };
  if (!cfg.apiKey) return { ok: false, error: 'API key is empty' };
  if (!cfg.model) return { ok: false, error: 'Model name is empty' };

  if (cfg.dialect === DIALECT.SYSTEMONE) {
    const res = await askSystemOne('ping', {
      ping: { type: 'noul', instructions: 'Is this a connectivity test?' },
    }, cfg);
    return res.ok
      ? { ok: true, detail: `answered in ${res.ms}ms via ${res.model}`, ms: res.ms, model: res.model }
      : { ok: false, error: res.error, ms: res.ms };
  }

  const res = await askChat('Reply with the single word: ok', 'ping', cfg);
  return res.ok
    ? { ok: true, detail: `answered in ${res.ms}ms`, ms: res.ms, text: res.text.slice(0, 40) }
    : { ok: false, error: res.error, ms: res.ms };
}

/**
 * Run an LLM-backed decision with a deterministic local fallback.
 *
 * The game never blocks on the network: `fallback` is always called when the
 * model is disabled, misconfigured, slow or wrong. This is the whole reason the
 * LLM layer is optional — the game must be fully playable offline.
 */
export async function decideOrFallback(payload, fallback, cfg = loadConfig()) {
  if (!isConfigured(cfg)) return { source: 'local', result: fallback() };
  const res = await ask(payload, cfg);
  if (!res.ok) return { source: 'local', result: fallback(), error: res.error };
  return { source: cfg.dialect, result: res, raw: res };
}
