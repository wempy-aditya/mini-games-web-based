/**
 * Match state machine.
 *
 * A match owns: the board, both players' hands, whose turn it is, and the
 * two-phase turn (mark wall -> play tile). Undo is implemented as a stack of
 * full snapshots, which is cheap here (a few KB) and completely avoids
 * inverse-operation bugs.
 */

import { Board, CELL } from './board.js';
import { buildTileSet, rotated, orientations } from './tile.js';
import { chooseMove, DIFFICULTY, fallbackMove } from './ai.js';
import { shuffle, makeRng, COLOR_META } from './util.js';

export const PHASE = { WALL: 'wall', PLAY: 'play' };

export const MODE = {
  HUMAN_VS_AI: 'human-ai',
  AI_VS_AI: 'ai-ai',
};

const HAND_SIZE = 4;
const STORAGE_KEY = 'minigames.azulejo.save.v1';
const PREFS_KEY = 'minigames.azulejo.prefs.v1';

export class Match {
  constructor({ mode = MODE.HUMAN_VS_AI, difficulty = 'normal', seed = null } = {}) {
    this.mode = mode;
    this.difficulty = difficulty;
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.seed = seed;

    this.rng = seed !== null ? makeRng(seed) : Math.random;
    this.tilePool = buildTileSet(100, this.rng);

    this.board = new Board(5);
    this.hands = [[], []];
    this.turn = 0;          // 0 = human, 1 = AI
    this.phase = PHASE.WALL;
    this.pendingWall = null; // { r, c, color } marked this turn
    this.over = false;
    this.result = null;
    this.moveLog = [];
    this.undoStack = [];

    this.deal();
  }

  // ── setup ──

  /**
   * Shuffle the deck and deal both hands. Uses `this.rng`, so a Match built with
   * a `seed` deals identically every time — which is what makes the difficulty
   * benchmark in the test suite reproducible instead of a coin flip.
   */
  deal() {
    this.deck = shuffle(this.tilePool.slice(), this.rng);
    this.hands = [[], []];
    for (let i = 0; i < HAND_SIZE; i++) {
      this.hands[0].push(this.deck.pop());
      this.hands[1].push(this.deck.pop());
    }
  }

  newMatch(opts = {}) {
    Object.assign(this, new Match({ ...opts, mode: this.mode, difficulty: this.difficulty }));
  }

  // ── queries ──

  get currentHand() { return this.hands[this.turn]; }
  get isHumanTurn() { return this.mode === MODE.HUMAN_VS_AI && this.turn === 0; }
  get emptyCount() { return this.board.emptyCount(); }

  /** Lines that are still in play, for the HUD progress strip. */
  lineProgress() {
    const out = [];
    for (const line of this.board.allLines()) {
      let walls = 0;
      const colours = new Set();
      let blocked = false;
      for (const i of line.cells) {
        if (this.board.cells[i] === CELL.WALL) {
          walls++;
          const c = this.board.wallColor[i];
          if (c === 5) blocked = true;
          else colours.add(c);
        }
      }
      const uniform = colours.size <= 1 && !blocked;
      out.push({
        kind: line.kind, index: line.index, walls,
        color: uniform && colours.size === 1 ? [...colours][0] : -1,
        viable: uniform && !blocked,
      });
    }
    return out;
  }

  legalMovesFor(tileIndex) {
    const tile = this.currentHand[tileIndex];
    if (!tile) return [];
    const out = [];
    for (const rot of orientations(tile)) {
      for (const mv of this.board.legalMoves(rot.edges)) {
        out.push({ ...mv, tileIndex, edges: rot.edges, variant: rot.variant });
      }
    }
    return out;
  }

  // ── mutation ──

  snapshot() {
    return {
      board: this.board.toJSON(),
      hands: this.hands.map((h) => h.map((t) => [t.id, t.variant])),
      turn: this.turn,
      phase: this.phase,
      pendingWall: this.pendingWall ? { ...this.pendingWall } : null,
      deck: this.deck.map((t) => t.id),
    };
  }

  restore(s) {
    this.board = Board.fromJSON(s.board, this.tilePool);
    this.hands = s.hands.map((h) => h.map(([id, variant]) => {
      const base = this.tilePool.find((t) => t.id === id);
      return base ? { ...base, variant } : null;
    }));
    this.turn = s.turn;
    this.phase = s.phase;
    this.pendingWall = s.pendingWall;
    this.deck = s.deck.map((id) => this.tilePool.find((t) => t.id === id)).filter(Boolean);
  }

  pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.restore(s);
    this.over = false;
    this.result = null;
    return true;
  }

  /** Phase 1: mark a wall. Optional — a turn may be a bare tile placement. */
  markWall(r, c, color) {
    if (this.over || this.phase !== PHASE.WALL) return false;
    if (this.pendingWall) return false; // one wall per turn
    if (!this.board.isEmpty(r, c)) return false;
    if (!this.board.markWall(r, c, color)) return false;
    this.pendingWall = { r, c, color };
    return true;
  }

  cancelWall() {
    if (!this.pendingWall) return false;
    const { r, c } = this.pendingWall;
    const i = this.board.idx(r, c);
    // Only revert if still empty of a tile (a wall with no tile is undoable).
    if (this.board.cells[i] === CELL.WALL && !this.board.tile[i]) {
      this.board.cells[i] = CELL.EMPTY;
      this.board.wallColor[i] = -1;
    }
    this.pendingWall = null;
    return true;
  }

  /**
   * Phase 2: play a tile. This is always permitted, whether or not a wall was
   * marked — marking a wall is optional, so the WALL phase never blocks play.
   * Completes the turn.
   */
  playTile(tileIndex, r, c, edges, variant) {
    if (this.over) return false;
    const tile = this.currentHand[tileIndex];
    if (!tile) return false;
    if (!this.board.canPlace(r, c, edges)) return false;

    const played = { ...tile, variant: variant ?? tile.variant, edges: edges.slice() };

    // `place` is the authority on whether the board actually changed. Checking
    // `canPlace` alone is not enough: a stale caller can hand us a cell that got
    // filled between the two calls, and silently consuming a tile from the hand
    // without filling anything is the worst possible failure here.
    if (!this.board.place(r, c, played).ok) return false;

    this.pushUndo();
    this.hands[this.turn].splice(tileIndex, 1);
    this.pendingWall = null;
    this.moveLog.push({ turn: this.turn, kind: 'play', r, c, color: edges[0] });

    this.advanceTurn();
    return true;
  }

  /** Skip: keep the hand size but draw a replacement, costing nothing but tempo. */
  passTurn() {
    if (this.over) return false;
    this.pushUndo();
    this.hands[this.turn].push(this.deck.pop() || this.hands[this.turn][0]);
    this.pendingWall = null;
    this.moveLog.push({ turn: this.turn, kind: 'pass' });
    this.advanceTurn();
    return true;
  }

  drawTile() {
    if (this.over) return null;
    if (!this.deck.length) return null;
    const t = this.deck.pop();
    this.hands[this.turn].push(t);
    return t;
  }

  /**
   * Is anyone still able to move?
   *
   * A 5x5 board can deadlock: a marked wall whose colour no remaining tile can
   * match becomes permanently unplayable, and if it is the last free cell the
   * game can never end. Detecting that explicitly is what stops the match from
   * hanging on the final turn.
   */
  hasAnyLegalMove() {
    for (let ti = 0; ti < this.hands[0].length; ti++) {
      if (this.legalMovesFor(ti).length > 0) return true;
    }
    // Either hand being able to move is enough; the turn can pass.
    for (let ti = 0; ti < this.hands[1].length; ti++) {
      if (this.legalMovesFor(ti).length > 0) return true;
    }
    return false;
  }

  /** Every cell no remaining tile can ever be played on. */
  deadCells() {
    const out = [];
    for (let r = 0; r < this.board.size; r++) {
      for (let c = 0; c < this.board.size; c++) {
        if (this.board.tile[this.board.idx(r, c)]) continue;
        const playable = this.hands.some((_, ti) => this.legalMovesFor(ti)
          .some((mv) => mv.r === r && mv.c === c));
        if (!playable) out.push({ r, c });
      }
    }
    return out;
  }

  advanceTurn() {
    // Full, or nothing left anyone can legally play: the match is decided.
    if (this.board.isFull() || !this.hasAnyLegalMove()) {
      this.finish();
      return;
    }
    this.turn = 1 - this.turn;
    this.phase = PHASE.WALL;
    // Refill hand if a player dropped below target through odd states.
    while (this.hands[this.turn].length < HAND_SIZE) {
      const t = this.deck.pop();
      if (!t) break;
      this.hands[this.turn].push(t);
    }
  }

  finish() {
    this.over = true;
    const a = this.board.score(this.hands[0].length).total;
    const b = this.board.score(this.hands[1].length).total;
    this.result = {
      scores: [a, b],
      winner: a === b ? -1 : (a > b ? 0 : 1),
      detail: this.board.score(0),
      dead: this.board.isFull() ? [] : this.deadCells(),
      fullBoard: this.board.isFull(),
    };
  }

  // ── AI ──

  /** Run one AI turn. Returns a description of what it did, for the UI. */
  async aiTurn(rng = this.rng) {
    const cfg = this.cfg;
    await new Promise((res) => setTimeout(res, cfg.thinkMs));

    const move = chooseMove(this.board, this.currentHand, cfg, rng) || fallbackMove(this.board, this.currentHand);
    if (!move) {
      this.finish();
      return null;
    }

    if (move.kind === 'wall') {
      this.markWall(move.r, move.c, move.color);
    }

    // The AI marks a wall and then places a tile, matching the two-phase turn.
    const hand = this.currentHand;
    let best = null;
    for (let i = 0; i < hand.length; i++) {
      const forTile = this.legalMovesFor(i);
      for (const mv of forTile) {
        if (mv.r === move.r && mv.c === move.c) {
          const s = move.score - Math.abs(i - move.tileIndex) * 0.01;
          if (!best || s > best.s) best = { i, mv, s };
        }
      }
    }

    if (!best) {
      // The preferred cell went away; take the best available placement.
      let fallback = null;
      for (let i = 0; i < hand.length; i++) {
        for (const mv of this.legalMovesFor(i)) {
          if (!fallback) fallback = { i, mv };
        }
      }
      if (!fallback) {
        this.finish();
        return null;
      }
      best = fallback;
    }

    this.pushUndo();
    this.playTile(best.i, best.mv.r, best.mv.c, best.mv.edges, best.mv.variant);
    return { kind: move.kind, r: move.r, c: move.c, onWall: best.mv.onWall };
  }

  // ── persistence ──

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 1,
        mode: this.mode,
        difficulty: this.difficulty,
        snap: this.snapshot(),
        moveLog: this.moveLog.slice(-60),
      }));
      return true;
    } catch {
      return false;
    }
  }

  static hasSave() {
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  }

  static loadInto(match) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.v !== 1) return false;
      match.mode = data.mode;
      match.difficulty = data.difficulty;
      match.cfg = DIFFICULTY[data.difficulty] || DIFFICULTY.normal;
      match.restore(data.snap);
      match.moveLog = data.moveLog || [];
      match.over = match.board.isFull();
      if (match.over) match.finish();
      return true;
    } catch {
      return false;
    }
  }

  static clearSave() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  static loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return { mode: MODE.HUMAN_VS_AI, difficulty: 'normal', sound: true };
      return { mode: MODE.HUMAN_VS_AI, difficulty: 'normal', sound: true, ...JSON.parse(raw) };
    } catch {
      return { mode: MODE.HUMAN_VS_AI, difficulty: 'normal', sound: true };
    }
  }

  static savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }
}

export { HAND_SIZE, STORAGE_KEY, PREFS_KEY, COLOR_META };
