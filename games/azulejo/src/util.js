/**
 * Shared helpers. Deliberately dependency-free and self-contained: the monorepo
 * forbids cross-game imports, so every game keeps its own copy of these.
 */

export const COLORS = {
  BLUE: 0,
  YELLOW: 1,
  RED: 2,
  BLACK: 3,
  WHITE: 4,
};

/**
 * Colour identity.
 * `wall` is the raw value of one completed wall line (before depth multiplier),
 * and doubles as the sort order for the display palette.
 */
export const COLOR_META = [
  { name: 'BIRU', hex: '#2f7bd6', dark: '#12324f', wall: 1 },
  { name: 'KUNING', hex: '#e8b53a', dark: '#5c4212', wall: 3 },
  { name: 'MERAH', hex: '#d94a3d', dark: '#5c1a14', wall: 5 },
  { name: 'HITAM', hex: '#3a3f4b', dark: '#14161c', wall: 7 },
  { name: 'PUTIH', hex: '#e6e9ef', dark: '#6a7080', wall: 10 },
];

export const WALL_SIZE = 5;
export const FLOOR_SIZE = 5;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function randInt(lo, hi) {
  // inclusive both ends
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * A small, fast, seeded PRNG (mulberry32). Used to make matches reproducible:
 * without it every deal differs, and a benchmark that averages six games is
 * measuring shuffle luck as much as AI quality.
 */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with an injectable rng so games can be replayed deterministically. */
export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function formatNumber(n) {
  return String(n);
}

export const key = (r, c) => `${r},${c}`;

export function parseKey(k) {
  const [r, c] = k.split(',').map(Number);
  return { r, c };
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
