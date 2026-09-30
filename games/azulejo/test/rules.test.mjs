/**
 * Headless sanity harness for the rules + AI. Run with:
 *   node games/azulejo/test/rules.test.mjs
 *
 * This is not a substitute for playing the game, but it catches the class of
 * bug that is invisible in the console: illegal states, dead-end hands, and AI
 * stalls.
 */

import { Board, CELL, SIZE } from '../src/board.js';
import { buildTileSet, orientations, NEUTRAL } from '../src/tile.js';
import { Match, MODE, PHASE, HAND_SIZE } from '../src/match.js';
import { chooseMove, DIFFICULTY, fallbackMove } from '../src/ai.js';
import { makeRng } from '../src/util.js';

let pass = 0;
let fail = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

function section(name) {
  console.log(`\n${name}`);
}

// ── board basics ────────────────────────────────────────────────────────────
section('Board basics');
{
  const b = new Board(SIZE);
  ok(b.emptyCount() === 25, 'new board has 25 empty cells');
  ok(b.isFull() === false, 'new board is not full');

  b.markWall(0, 0, 1);
  ok(b.isWall(0, 0), 'markWall sets WALL state');
  ok(b.wallColor[b.idx(0, 0)] === 1, 'wall keeps its colour');
  ok(!b.markWall(0, 0, 2), 'cannot wall an occupied cell');

  // A marked-but-unfilled wall is still playable, so it does NOT consume the
  // cell: emptyCount must stay 25 until a tile is actually played.
  ok(b.emptyCount() === 25, 'a bare wall does not count as filled');
  b.place(0, 0, { id: -3, edges: [0, 5, 5, 5], kind: 'solid', variant: 0 });
  ok(b.emptyCount() === 24, 'playing onto the wall consumes the cell');
}

// ── placement legality ──────────────────────────────────────────────────────
section('Placement legality');
{
  const b = new Board(SIZE);
  const solidBlue = { id: -1, edges: [1, 1, 1, 1], kind: 'corner', variant: 0 };

  ok(b.canPlace(0, 0, solidBlue.edges), 'empty cell accepts any tile');

  // Wall colour must match the touching edge. Colour indices: 0 blue, 1 yellow.
  b.markWall(1, 0, 0); // blue wall directly south of (0,0)
  const yellow = { id: -2, edges: [1, 1, 1, 1], kind: 'corner', variant: 0 };
  ok(!b.canPlace(0, 0, yellow.edges), 'tile with the wrong colour is rejected on a wall');

  // A wall constrains the *touching* edge only: S must be blue, the rest free.
  const blueSouth = { id: -4, edges: [2, 3, 0, 4], kind: 'pattern', variant: 0 };
  ok(b.canPlace(0, 0, blueSouth.edges), 'tile matching the wall on the shared edge is accepted');
  const blueWrongSide = { id: -5, edges: [0, 3, 2, 4], kind: 'pattern', variant: 0 };
  ok(!b.canPlace(0, 0, blueWrongSide.edges), 'blue on the wrong side still fails');

  // Floor neighbour constrains the shared edge.
  const b2 = new Board(SIZE);
  b2.place(1, 1, { id: 1, edges: [0, 0, 0, 0], kind: 'corner', variant: 0 });
  // A tile with blue on the N edge should NOT fit south of a blue-topped floor
  // tile, because the shared edge is the floor's S edge (blue) vs our N.
  const b2south = { id: 2, edges: [1, 0, 0, 0], kind: 'pattern', variant: 0 };
  ok(!b2.canPlace(2, 1, b2south.edges), 'floor neighbour colour is enforced');

  // A NEUTRAL edge is a wildcard.
  const wild = { id: 3, edges: [NEUTRAL, 0, 0, 0], kind: 'pattern', variant: 0 };
  ok(b2.canPlace(2, 1, wild.edges), 'NEUTRAL edge bypasses a colour constraint');
}

// ── wall colour locking ─────────────────────────────────────────────────────
section('Wall colour locking');
{
  const b = new Board(SIZE);
  b.markWall(0, 0, 3); // black wall
  const black = { id: 10, edges: [3, NEUTRAL, NEUTRAL, NEUTRAL], kind: 'solid', variant: 0 };
  b.place(0, 0, black);
  ok(b.wallColor[b.idx(0, 0)] === 3, 'wall colour is locked to the matching edge');
  ok(b.isWall(0, 0), 'cell stays a WALL after being filled');
  ok(b.filledCount === 1, 'filling a wall increments filledCount');
}

// ── scoring ─────────────────────────────────────────────────────────────────
section('Scoring');
{
  const b = new Board(SIZE);
  // Complete a blue row: blue = 1 point.
  for (let c = 0; c < 5; c++) {
    b.markWall(2, c, 0);
    b.place(2, c, { id: 100 + c, edges: [0, NEUTRAL, NEUTRAL, NEUTRAL], kind: 'solid', variant: 0 });
  }
  const s = b.score(0);
  ok(s.completed.length >= 1, 'a completed blue line is detected');
  ok(s.completed.some((x) => x.color === 0), 'the completed line is blue');

  const white = new Board(SIZE);
  for (let c = 0; c < 5; c++) {
    white.markWall(0, c, 4);
    white.place(0, c, { id: 200 + c, edges: [4, NEUTRAL, NEUTRAL, NEUTRAL], kind: 'solid', variant: 0 });
  }
  const sw = white.score(0);
  ok(sw.total > s.total, 'a white line scores more than a blue line');
}

// ── tile set ────────────────────────────────────────────────────────────────
section('Tile set');
{
  const tiles = buildTileSet(100);
  ok(tiles.length === 100, 'tile pool has exactly 100 tiles');
  ok(new Set(tiles.map((t) => t.id)).size === 100, 'tile ids are unique');
  ok(tiles.every((t) => t.edges.length === 4), 'every tile has 4 edges');
  ok(tiles.every((t) => t.edges.every((e) => e >= 0 && e <= NEUTRAL)), 'edges are in range');

  const withWild = tiles.filter((t) => t.edges.includes(NEUTRAL)).length;
  ok(withWild > 20, 'a healthy share of tiles have wild edges');
}

// ── orientations ────────────────────────────────────────────────────────────
section('Rotations');
{
  const t = { id: -1, edges: [0, 1, 2, 3], kind: 'pattern', variant: 0 };
  const r1 = orientations(t);
  ok(r1.length === 4, 'an asymmetric tile has 4 orientations');
  const symmetric = { id: -2, edges: [1, 1, 1, 1], kind: 'corner', variant: 0 };
  ok(orientations(symmetric).length === 1, 'a uniform tile has 1 orientation');
}

// ── AI: never returns an illegal move ───────────────────────────────────────
section('AI legality');
{
  const m = new Match({ mode: MODE.AI_VS_AI, difficulty: 'normal' });
  let legalCount = 0;
  for (let turn = 0; turn < 60 && !m.over; turn++) {
    const move = chooseMove(m.board, m.currentHand, DIFFICULTY.normal) || fallbackMove(m.board, m.currentHand);
    if (!move) {
      // No legal move for either side: the match is genuinely decided.
      ok(m.over || !m.hasAnyLegalMove(), `turn ${turn}: no move available and the match is correctly marked over`);
      m.advanceTurn();
      continue;
    }
    if (move.kind === 'wall') {
      m.markWall(move.r, move.c, move.color);
    }
    // Find the matching hand index and placement.
    let done = false;
    for (let i = 0; i < m.currentHand.length && !done; i++) {
      for (const mv of m.legalMovesFor(i)) {
        if (mv.r === move.r && mv.c === move.c) {
          const before = m.board.filledCount;
          ok(m.playTile(i, mv.r, mv.c, mv.edges, mv.variant),
            `turn ${turn}: placement at ${mv.r},${mv.c} was accepted`);
          ok(m.board.filledCount === before + 1, `turn ${turn}: placement advanced the board`);
          // Invariant: the counter must always match the tiles actually on the
          // board. A mismatch means a tile left the hand without filling a cell.
          const onBoard = m.board.tile.filter(Boolean).length;
          ok(m.board.filledCount === onBoard,
            `turn ${turn}: filledCount ${m.board.filledCount} must equal ${onBoard} tiles on board`);
          legalCount++;
          done = true;
          break;
        }
      }
    }
    if (!done) { ok(false, `turn ${turn}: AI proposed an unplayable cell`); break; }
  }
  ok(legalCount > 10, `AI completed ${legalCount} placements without a stall`);
  ok(m.over, 'AI vs AI reaches a finished board');
  ok(m.result.fullBoard || m.result.dead.length < 25, 'the match ended on a full board or a real deadlock, not a hang');
  if (m.result.completedCount !== undefined) ok(m.result.completedCount >= 0, 'result carries line detail');
  console.log(`  info AI vs AI: ${m.result.scores[0]}-${m.result.scores[1]}, ` +
    `${m.result.detail.completed.length} lines, ${m.result.dead.length} dead cells, full=${m.result.fullBoard}`);
}

// ── difficulty separation ───────────────────────────────────────────────────
section('Difficulty');
{
  // Difficulty is a noisy measurement: a single match can swing by 40+ points,
  // so a 6-game sample produced flaky pass/fail runs. Twenty matches with a
  // seeded RNG makes this deterministic AND tight enough to be a real check.
  const GAMES = 20;
  const runs = {};
  for (const diff of ['easy', 'normal', 'hard']) {
    let total = 0;
    for (let g = 0; g < GAMES; g++) {
      const seed = g * 7919 + 13;
      // The Match seed fixes the deal; the rng fixes the AI's jitter. Seeding
      // only one of the two left the benchmark swinging by 40+ points run to run.
      const rng = makeRng(seed * 31 + diff.length);
      const m = new Match({ mode: MODE.AI_VS_AI, difficulty: diff, seed });
      let guard = 0;
      while (!m.over && guard++ < 200) {
        const move = chooseMove(m.board, m.currentHand, DIFFICULTY[diff], rng)
          || fallbackMove(m.board, m.currentHand);
        if (!move) break;
        if (move.kind === 'wall') m.markWall(move.r, move.c, move.color);
        let done = false;
        for (let i = 0; i < m.currentHand.length && !done; i++) {
          for (const mv of m.legalMovesFor(i)) {
            if (mv.r === move.r && mv.c === move.c) {
              m.playTile(i, mv.r, mv.c, mv.edges, mv.variant);
              done = true; break;
            }
          }
        }
        if (!done) break;
      }
      total += m.over ? m.result.scores[0] : 0;
    }
    runs[diff] = total / GAMES;
    console.log(`  info ${diff}: avg ${runs[diff].toFixed(1)} over ${GAMES} matches`);
  }
  ok(runs.hard > runs.easy + 5,
    `hard (${runs.hard.toFixed(1)}) must clearly outscore easy (${runs.easy.toFixed(1)})`);
  ok(runs.normal > runs.easy,
    `normal (${runs.normal.toFixed(1)}) must outscore easy (${runs.easy.toFixed(1)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
