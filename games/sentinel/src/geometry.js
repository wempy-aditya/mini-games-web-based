/**
 * Path geometry and the tower-placement grid.
 *
 * Enemies follow a polyline. Everything here is pure maths with no state, which
 * is what lets the test suite exercise it headlessly.
 */

import { PATHS, COLORS } from './data.js';
import { dist, clamp } from './util.js';

/** Total length of a polyline, plus a per-segment lookup for fast traversal. */
export function buildPath(key) {
  const pts = (PATHS[key] || PATHS.meander).points;
  const segs = [];
  let total = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const len = dist(x1, y1, x2, y2);
    segs.push({ x1, y1, x2, y2, len, start: total });
    total += len;
  }
  return { points: pts, segments: segs, length: total, key, name: (PATHS[key] || PATHS.meander).name };
}

/**
 * Position at a given distance along the path.
 * `t` is clamped to [0, length]; beyond the end the enemy is at the core.
 */
export function pointAt(path, t) {
  const d = clamp(t, 0, path.length);
  const segs = path.segments;
  if (segs.length === 0) return { x: path.points[0][0], y: path.points[0][1] };

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (d <= s.start + s.len || i === segs.length - 1) {
      const local = d - s.start;
      const u = s.len === 0 ? 0 : clamp(local / s.len, 0, 1);
      return { x: s.x1 + (s.x2 - s.x1) * u, y: s.y1 + (s.y2 - s.y1) * u };
    }
  }
  const last = path.points[path.points.length - 1];
  return { x: last[0], y: last[1] };
}

/** Heading (radians) at a given distance, used to orient enemies. */
export function headingAt(path, t) {
  const d = clamp(t, 0, path.length);
  for (const s of path.segments) {
    if (d <= s.start + s.len || s === path.segments[path.segments.length - 1]) {
      return Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    }
  }
  return 0;
}

// ── placement grid ─────────────────────────────────────────────────────────

export const CELL = 40;
export const GRID_COLS = 14;
export const GRID_ROWS = 7;
export const ORIGIN = { x: 0, y: 0 };

export function cellCenter(col, row) {
  return { x: ORIGIN.x + col * CELL + CELL / 2, y: ORIGIN.y + row * CELL + CELL / 2 };
}

export function toCell(x, y) {
  return {
    col: Math.floor((x - ORIGIN.x) / CELL),
    row: Math.floor((y - ORIGIN.y) / CELL),
  };
}

export function inGrid(col, row) {
  return col >= 0 && col >= 0 && row >= 0 && col < GRID_COLS && row < GRID_ROWS;
}

/**
 * Is a grid cell free for a tower?
 *
 * Rejected when it overlaps the enemy path (with a small margin so towers do
 * not visually clip the road) or when another tower already occupies it. The
 * margin is what makes the path read as a road rather than a line the player
 * can stand on.
 */
export function isBuildable(path, col, row, occupied) {
  if (!inGrid(col, row)) return false;
  const k = key(col, row);
  if (occupied.has(k)) return false;

  const c = cellCenter(col, row);
  const margin = CELL * 0.28;
  for (const s of path.segments) {
    if (segmentPointDistance(s, c.x, c.y) < margin) return false;
  }
  return true;
}

/** Squared distance from a point to a line segment. */
export function segmentPointDistance(seg, px, py) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(seg.x1, seg.y1, px, py);
  let t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return dist(seg.x1 + t * dx, seg.y1 + t * dy, px, py);
}

/**
 * Nearest-to-the-core enemy inside `tower.range`.
 *
 * Targeting the furthest along the path is deliberate: that is the enemy about
 * to leak, so it is always the most valuable one to kill. Ties break on distance
 * so the choice is stable frame to frame.
 */
export function targetInRange(tower, enemies) {
  let best = null;
  let bestProgress = -Infinity;
  let bestD2 = Infinity;
  const r2 = tower.range * tower.range;

  for (const e of enemies) {
    if (e.dead) continue;
    const d2 = (e.x - tower.x) ** 2 + (e.y - tower.y) ** 2;
    if (d2 > r2) continue;
    if (e.progress > bestProgress || (e.progress === bestProgress && d2 < bestD2)) {
      best = e;
      bestProgress = e.progress;
      bestD2 = d2;
    }
  }
  return best;
}

function key(col, row) {
  return `${col},${row}`;
}
