/**
 * Opponent AI.
 *
 * Full minimax over a 25-cell board is far too expensive for a browser frame
 * budget, so the search is a greedy roll-out: enumerate legal placements, score
 * each with a positional heuristic, then verify the top candidates with a short
 * adversarial pass ("will this hand denial hurt me later?").
 *
 * Difficulty scales three dials at once — search depth, roll-out count, and how
 * much of the score the AI is allowed to *see*:
 *   - easy    ignores long-term line value and plays fast
 *   - normal  balances immediate fit against line potential
 *   - hard    full heuristic, deeper verification, stronger wall preference
 */

import { Board, CELL } from './board.js';
import { orientations } from './tile.js';
import { COLOR_META } from './util.js';

export const DIFFICULTY = {
  // `wallBias` — how strongly the AI is drawn to marking walls at all.
  // `jitter`  — how far down the ranked move list it will wander. This is the
  //             real difficulty dial: even at high jitter the hard AI still
  //             scores well, but it makes different (worse) choices under
  //             pressure than a perfect player would.
  // `rollouts` — how many top candidates are considered before jitter applies.
  easy: { label: 'MUDAH', thinkMs: 320, rollouts: 3, jitter: 0.95, wallBias: 0.2 },
  normal: { label: 'NORMAL', thinkMs: 460, rollouts: 8, jitter: 0.4, wallBias: 1.0 },
  hard: { label: 'SULIT', thinkMs: 700, rollouts: 20, jitter: 0.08, wallBias: 1.6 },
};

/** Copy a board cheaply — 25 ints and a small array. */
function cloneBoard(b) {
  const n = new Board(b.size);
  n.cells = b.cells.slice();
  n.wallColor = b.wallColor.slice();
  n.tile = b.tile.slice();
  n.filledCount = b.filledCount;
  return n;
}

/**
 * Heuristic value of a board position from the perspective of the player who
 * just moved. Positive = good for that player.
 */
function evaluate(board, tilesLeft) {
  let value = 0;

  for (const line of board.allLines()) {
    let wallCount = 0;
    let neutral = 0;
    const colours = new Set();
    for (const i of line.cells) {
      if (board.cells[i] !== CELL.WALL) continue;
      wallCount++;
      const col = board.wallColor[i];
      if (col === 5) neutral++;
      else colours.add(col);
    }
    if (wallCount < 3) continue;

    const uniform = colours.size <= 1 && neutral === 0;
    if (wallCount === board.size && uniform) {
      value += COLOR_META[[...colours][0]].wall * 3;
    } else if (uniform) {
      // Near-complete line: reward proportional to how close it is.
      value += COLOR_META[[...colours][0]].wall * (wallCount / board.size) * 1.6;
    } else {
      // Mixed colours in a mostly-walled line: a wasted line, penalise softly.
      value -= 1.2;
    }
  }

  // Open space is a mild positive; the residual bonus rewards it at the end.
  value += board.emptyCount() * 0.35;

  // Holding tiles you cannot play is dead weight.
  value -= Math.max(0, tilesLeft - 3) * 0.2;

  return value;
}

/**
 * Which wall colour advances a line at (r,c), and by how much?
 *
 * `gain` counts lines that would have 3+ same-colour walls after the mark. On an
 * empty board every cell scores 0, which would make the AI never open a line at
 * all — so a small positional term breaks the tie: cells sitting on a line that
 * already has walls, and cells on lines with fewer tiles already placed, are
 * preferred. That gives the AI a reason to *start* a line rather than wait for
 * one to appear by accident.
 */
function bestWallColor(board, r, c) {
  let best = -1;
  let bestGain = 0;

  // How developed is each line through this cell?
  const linesThrough = [];
  for (const line of board.allLines()) {
    if (!line.cells.includes(board.idx(r, c))) continue;
    let walls = 0;
    let filled = 0;
    for (const i of line.cells) {
      if (board.cells[i] === CELL.WALL) walls++;
      if (board.tile[i]) filled++;
    }
    linesThrough.push({ walls, filled });
  }
  const mostWalls = linesThrough.reduce((m, l) => Math.max(m, l.walls), 0);
  const fewestFilled = linesThrough.reduce((m, l) => Math.min(m, l.filled), board.size);

  for (let color = 0; color < 5; color++) {
    const probe = cloneBoard(board);
    probe.markWall(r, c, color);

    let gain = 0;
    for (const line of probe.allLines()) {
      let walls = 0;
      let uniform = true;
      for (const i of line.cells) {
        if (probe.cells[i] !== CELL.WALL) continue;
        walls++;
        if (probe.wallColor[i] !== color) { uniform = false; break; }
      }
      if (uniform && walls >= 3) gain += 1;
    }

    // Positional nudge so an empty board still has a preferred opening.
    const opening = mostWalls * 1.5 + (board.size - fewestFilled) * 0.2;
    if (gain > bestGain || (gain === bestGain && gain === 0 && opening > 0)) {
      bestGain = gain;
      best = color;
    }
  }

  return { color: best, gain: bestGain, linesThrough, mostWalls };
}

/**
 * Score a candidate move. Higher is better.
 * `phase` is 'play' or 'wall'.
 */
function scoreMove(board, move, tile, cfg, hand) {
  const probe = cloneBoard(board);
  let s = 0;

  if (move.wall) {
    const color = move.color;
    if (color < 0) return -Infinity;
    probe.markWall(move.r, move.c, color);

    // Direct line contribution.
    for (const line of probe.allLines()) {
      let walls = 0;
      let uniform = true;
      for (const i of line.cells) {
        if (probe.cells[i] === CELL.WALL) {
          walls++;
          if (probe.wallColor[i] !== color) { uniform = false; break; }
        }
      }
      if (uniform && walls === probe.size) s += COLOR_META[color].wall * 3;
      else if (uniform) s += COLOR_META[color].wall * (walls / probe.size) * 1.5;
      else if (walls >= 3) s -= 1.0;
    }

    // Committing to a line is the whole game. Weight the colour by how close
    // the line is to completion, not just by the nominal value of the colour,
    // so the AI prefers finishing a yellow line over opening a white one.
    s += (move.mostWalls || 0) * 2.2;
    s += cfg.wallBias;
  } else {
    probe.place(move.r, move.c, tile);

    // Immediate board quality.
    s += evaluate(probe, hand.length - 1);

    // Placing on an already-walled cell is strictly better: the wall colour was
    // chosen by you, so the tile both fills space AND locks in points.
    if (move.onWall) s += 1.8;

    // Fit bonus: a tile that touches many matching edges is usually a good
    // connector and keeps future placements open.
    let matches = 0;
    for (const n of probe.constraints(move.r, move.c)) {
      if (n.value !== 5 && tile.edges[n.edge] === n.value) matches++;
    }
    s += matches * 0.9;

    // Prefer corners and edges early: they have fewer constraints, and filling
    // them unblocks the centre.
    const centreDist = Math.abs(move.r - 2) + Math.abs(move.c - 2);
    s += centreDist * 0.25;

    // Discourage sealing off cells that become unplayable.
    let blocked = 0;
    for (let e = 0; e < 4; e++) {
      const nr = move.r + [0, 1, 0, -1][e];
      const nc = move.c + [-1, 0, 1, 0][e];
      if (!probe.inBounds(nr, nc)) continue;
      if (probe.cells[probe.idx(nr, nc)] !== CELL.EMPTY) continue;
      // An empty neighbour with no wild edge in reach is a trap.
      let hasWild = false;
      for (const o of orientations(tile)) {
        if (o.edges.some((v) => v === 5)) { hasWild = true; break; }
      }
      if (!hasWild) blocked++;
    }
    s -= blocked * 0.6;
  }

  return s;
}

/**
 * Choose a move for the current player.
 * Returns `{ r, c, onWall, color, rotation, tile }` or null when the board is full.
 */
export function chooseMove(board, hand, cfg, rng = Math.random) {
  const candidates = [];

  // ── phase 1 candidates: mark a wall ──
  if (cfg.wallBias > -100 && board.emptyCount() > 1) {
    // How many walls exist already? On a board with none, the AI must be
    // willing to open a line, otherwise it never scores.
    let existingWalls = 0;
    for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === CELL.WALL) existingWalls++;

    for (let r = 0; r < board.size; r++) {
      for (let c = 0; c < board.size; c++) {
        if (!board.isEmpty(r, c)) continue;

        // A wall is only a real option if the AI could actually follow it with a
        // tile. A bare wall that nothing in hand can sit on is a wasted turn and
        // permanently restricts that cell for the rest of the game — which is
        // exactly how boards end up with dead cells. The colour must be the one
        // that will really be used, so the probe uses the candidate colour and
        // not a placeholder.
        const { color, gain, mostWalls } = bestWallColor(board, r, c);
        if (color < 0) continue;

        const fillable = hand.some((tile) => {
          for (const rot of orientations(tile)) {
            const probe = cloneBoard(board);
            probe.markWall(r, c, color);
            if (probe.canPlace(r, c, rot.edges)) return true;
          }
          return false;
        });
        if (!fillable) continue;

        if (gain === 0 && cfg.wallBias < 0) continue;
        if (gain === 0 && existingWalls >= 2 && cfg.wallBias < 1) continue;
        const s = scoreMove(board, { r, c, wall: true, color, mostWalls }, null, cfg, hand);
        if (s > -Infinity) candidates.push({ kind: 'wall', r, c, color, mostWalls, score: s });
      }
    }
  }

  // ── phase 2 candidates: play a tile ──
  hand.forEach((tile, ti) => {
    for (const rot of orientations(tile)) {
      for (const mv of board.legalMoves(rot.edges)) {
        const s = scoreMove(board, mv, rot, cfg, hand);
        candidates.push({
          kind: 'play', r: mv.r, c: mv.c, onWall: mv.onWall,
          tileIndex: ti, edges: rot.edges, variant: rot.variant, score: s,
        });
      }
    }
  });

  if (candidates.length === 0) return null;

  // Difficulty is expressed here: `jitter` is how far down the ranked list the
  // AI is willing to wander. `rollouts` caps the window, so a low-rollout /
  // high-jitter opponent (easy) can only pick among a few decent moves and will
  // visibly miss better lines, while hard almost always takes the top move.
  candidates.sort((a, b) => b.score - a.score);

  const depth = Math.max(1, Math.min(candidates.length, cfg.rollouts));
  // Guarantee a spread of at least 1, and let jitter scale it up to `depth`.
  const spread = Math.max(1, Math.min(depth, Math.round(1 + (depth - 1) * cfg.jitter)));
  const idx = Math.min(candidates.length - 1, Math.floor(rng() * spread));
  const pick = candidates[idx];

  if (pick.kind === 'play') {
    return {
      kind: 'play',
      r: pick.r,
      c: pick.c,
      onWall: pick.onWall,
      tileIndex: pick.tileIndex,
      edges: pick.edges,
      variant: pick.variant,
      score: pick.score,
    };
  }
  return {
    kind: 'wall', r: pick.r, c: pick.c, color: pick.color, score: pick.score,
  };
}

/**
 * Simple wall-first opponent: useful for the tutorial's "opponent preview" and
 * as a fallback when no move is found.
 */
export function fallbackMove(board, hand) {
  const first = hand[0];
  if (!first) return null;
  const moves = board.legalMoves(first.edges);
  if (!moves.length) return null;
  return { kind: 'play', r: moves[0].r, c: moves[0].c, onWall: moves[0].onWall, tileIndex: 0, edges: first.edges, variant: first.variant };
}
