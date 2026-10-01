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
  // 'auto' tries a direct call and falls back to the dev-server relay only when
  // the browser refuses the request itself. 'direct' and 'proxy' skip the other.
  transport: 'auto',
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

/** Path of the dev-server relay. Same-origin, so no preflight is involved. */
export const PROXY_PATH = '/api/proxy';

/**
 * Send one request, either straight to the API or through the dev-server relay.
 *
 * Why the relay exists. A browser preflight is deliberately sent WITHOUT the
 * Authorization header, because revealing credentials to a cross-origin
 * preflight is exactly what preflight is meant to prevent. An API that
 * authenticates the preflight itself answers 401 and, with no key to echo, no
 * CORS headers either. The browser then rejects the call without ever sending
 * the real request, and the console shows only a generic CORS message. The
 * API's CORS configuration can be perfect and still be unreachable this way.
 *
 * Routing through a same-origin path removes the preflight entirely, and lets
 * the server also speak to endpoints that are plain HTTP on a private network.
 */
async function postJson(url, body, cfg) {
  const mode = cfg.transport || 'auto';

  if (mode === 'proxy') return postOnce(PROXY_PATH, url, body, cfg, true);

  const first = await postOnce(url, url, body, cfg, false);
  if (first.ok || mode !== 'auto') return first;
  if (!isTransportLevel(first.error)) return first;

  // The browser refused the request before the API saw it. Almost always the
  // preflight problem, which the relay removes entirely, so retry once.
  const relayed = await postOnce(PROXY_PATH, url, body, cfg, true);
  if (relayed.ok) return { ...relayed, viaRelay: true };
  return { ...first, relayError: relayed.error };
}

function isTransportLevel(message) {
  return /CORS|ditolak koneksi|Relay|jaringan|Waktu habis/i.test(String(message || ''));
}

/**
 * One attempt. Never throws: the caller compares `ok` to decide whether a retry
 * is worth it, and a thrown error there would lose the transport-level detail
 * that tells "browser said no" apart from "API said no".
 */
async function postOnce(target, url, body, cfg, viaProxy) {
  const headers = { 'Content-Type': 'application/json' };
  // Only the direct path needs the key in a header. Via the relay it goes in
  // the body, so it is not attached to a request the browser logs as a
  // cross-origin attempt.
  if (!viaProxy) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const payload = viaProxy
    ? JSON.stringify({ url, body, apiKey: cfg.apiKey })
    : JSON.stringify(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 15000);

  let res;
  let text;
  try {
    res = await fetch(target, { method: 'POST', headers, body: payload, signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    const wrapped = describeTransportError(err, url, viaProxy);
    return { ok: false, error: wrapped.message, viaProxy, transport: true };
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || text.slice(0, 200) || res.statusText;
    return { ok: false, error: `HTTP ${res.status}: ${msg}`, status: res.status, data, viaProxy };
  }
  if (!data) {
    return { ok: false, error: 'Server returned a non-JSON body', status: res.status, viaProxy };
  }

  // The relay wraps the upstream answer so it can report upstream failures as
  // data instead of dying on the socket.
  if (viaProxy && !data.ok) {
    return {
      ok: false,
      error: `Relay: ${data.error || `upstream HTTP ${data.status}`}`,
      status: data.status,
      data,
      viaProxy,
    };
  }

  const payloadOut = viaProxy ? data.data : data;
  return { ok: true, data: payloadOut, viaRelay: viaProxy };
}

/** Turn a fetch rejection into something a settings screen can explain. */
function describeTransportError(err, url, viaProxy) {
  const isAbort = err?.name === 'AbortError';
  const message = isAbort
    ? 'Waktu habis. Perbagi batas waktu atau periksa alamat API.'
    : (viaProxy
      ? 'Relay tidak bisa menjangkau API. Pastikan alamatnya benar dan bisa dibuka dari server.'
      : 'Browser menolak koneksi (CORS atau jaringan).');

  const error = new Error(message);
  error.cause = err;
  error.url = url;
  error.isAbort = isAbort;
  return error;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Ask a System One (Jev) model a set of typed questions.
 * Returns `{ ok, answers, model, usage, ms, error }`.
 */
export async function askSystemOne(state, questions, cfg = loadConfig()) {
  const t0 = performance.now();
  const res = await postJson(endpointFor(cfg), buildSystemOneRequest(state, questions, cfg), cfg);
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    return { ok: false, answers: {}, error: res.error, status: res.status, ms, viaRelay: res.viaRelay, relayError: res.relayError };
  }
  const data = res.data || {};
  return {
    ok: true,
    answers: data.answers || {},
    model: data.model || cfg.model,
    escalate: Boolean(data.escalate),
    usage: data.usage || null,
    viaRelay: res.viaRelay,
    ms,
  };
}

/**
 * Ask an OpenAI-compatible model to answer with JSON matching `shapeHint`.
 * The caller parses the result; this function only handles transport + extraction.
 */
export async function askChat(system, user, cfg = loadConfig()) {
  const t0 = performance.now();
  const res = await postJson(endpointFor(cfg), buildChatRequest(system, user, cfg), cfg);
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    return { ok: false, text: '', json: null, error: res.error, status: res.status, ms, viaRelay: res.viaRelay, relayError: res.relayError };
  }
  const text = extractChatText(res.data);
  return {
    ok: true,
    text,
    json: extractJson(text),
    usage: res.data?.usage || null,
    viaRelay: res.viaRelay,
    ms,
  };
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
 *
 * When a direct call fails at the transport level, it retries once through the
 * dev-server relay. A browser refusing a direct call is almost always the
 * preflight problem described above, and the relay fixes exactly that, so the
 * user should not have to know which mode to pick.
 */
export async function testConnection(cfg = loadConfig()) {
  if (!cfg.baseUrl) return { ok: false, error: 'API URL is empty' };
  if (!cfg.apiKey) return { ok: false, error: 'API key is empty' };
  if (!cfg.model) return { ok: false, error: 'Model name is empty' };

  const res = cfg.dialect === DIALECT.SYSTEMONE
    ? await askSystemOne('ping', { ping: { type: 'noul', instructions: 'Is this a connectivity test?' } }, cfg)
    : await askChat('Reply with the single word: ok', 'ping', cfg);

  if (!res.ok) {
    // Two failures means the relay could not reach it either, so naming both
    // is more useful than showing the browser's generic complaint alone.
    return res.relayError
      ? { ok: false, error: `${res.error} — relay juga gagal: ${res.relayError}`, ms: res.ms }
      : { ok: false, error: res.error, ms: res.ms, viaRelay: res.viaRelay };
  }

  const where = res.viaRelay ? ' (lewat relay)' : '';
  return res.model
    ? { ok: true, detail: `answered in ${res.ms}ms via ${res.model}${where}`, ms: res.ms, model: res.model, viaRelay: res.viaRelay }
    : { ok: true, detail: `answered in ${res.ms}ms${where}`, ms: res.ms, text: (res.text || '').slice(0, 40), viaRelay: res.viaRelay };
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
