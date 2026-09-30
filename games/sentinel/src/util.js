/**
 * Small shared helpers. Self-contained on purpose: the monorepo forbids
 * cross-game imports, so every game keeps its own copy.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Frame-rate independent exponential approach. */
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function rand(lo = 0, hi = 1) {
  return lo + Math.random() * (hi - lo);
}

export function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** A small, fast, seeded PRNG (mulberry32) for reproducible runs. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function formatNumber(n) {
  return String(Math.round(n));
}

/** 12345 -> "12.3k" for compact HUD readouts. */
export function compact(n) {
  const v = Math.round(n);
  if (Math.abs(v) < 1000) return String(v);
  if (Math.abs(v) < 1e6) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1e6).toFixed(2)}M`;
}

export const key = (r, c) => `${r},${c}`;

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
