/**
 * Board state and rules.
 *
 * A 5x5 grid. Placing a tile on an empty cell is always legal. Placing on a
 * WALL is optional and only legal when the tile's edge matches that wall's
 * colour — that is the tension of the game: walls are efficient but restrict
 * what you can play, and a wall's colour is locked the moment it is filled.
 *
 * Two phases per turn, matching the physical game:
 *   1. (optional) mark one empty cell as a wall of any colour
 *   2. play one tile from hand onto any legal cell
 */

import { COLOR_META } from './util.js';
import { NEUTRAL } from './tile.js';

export const SIZE = 5;

/**
 * Offsets per edge, in EDGE order (N, E, S, W).
 *   N = up one row, E = right one column, S = down one row, W = left one column.
 * Getting this pair wrong silently breaks every adjacency rule, so it is
 * written as an explicit table rather than a clever formula.
 */
const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];
const OPPOSITE = [2, 3, 0, 1];

export const CELL = { EMPTY: 0, FLOOR: 1, WALL: 2 };

export class Board {
  constructor(size = SIZE) {
    this.size = size;
    this.cells = new Array(size * size).fill(CELL.EMPTY);
    /** For walls: the locked colour. For floors: the tile played. */
    this.wallColor = new Array(size * size).fill(-1);
    this.tile = new Array(size * size).fill(null);
    this.filledCount = 0;
  }

  idx(r, c) { return r * this.size + c; }
  inBounds(r, c) { return r >= 0 && c >= 0 && r < this.size && c < this.size; }
  get(r, c) { return this.cells[this.idx(r, c)]; }
  isEmpty(r, c) { return this.inBounds(r, c) && this.get(r, c) === CELL.EMPTY; }
  isWall(r, c) { return this.get(r, c) === CELL.WALL; }
  isFloor(r, c) { return this.get(r, c) === CELL.FLOOR; }

  /**
   * Colour constraints imposed by already-placed neighbours.
   * For a floor neighbour: the colour of the edge touching us.
   * For a wall neighbour: the wall's locked colour.
   */
  constraints(r, c) {
    const out = [];
    for (let e = 0; e < 4; e++) {
      const nr = r + DR[e];
      const nc = c + DC[e];
      if (!this.inBounds(nr, nc)) continue;
      const state = this.get(nr, nc);
      if (state === CELL.FLOOR) {
        const t = this.tile[this.idx(nr, nc)];
        out.push({ edge: e, value: t ? t.edges[OPPOSITE[e]] : NEUTRAL });
      } else if (state === CELL.WALL) {
        out.push({ edge: e, value: this.wallColor[this.idx(nr, nc)] });
      }
    }
    return out;
  }

  /** Can this tile legally be played at (r,c) in its current orientation? */
  canPlace(r, c, edges) {
    const state = this.get(r, c);
    // A wall cell is playable, but only while it is still bare. Once a tile sits
    // on it the cell stays CELL.WALL, so the state alone cannot tell the two
    // apart — the tile slot has to be consulted too.
    if (state === CELL.WALL) {
      if (this.tile[this.idx(r, c)] !== null) return false;
    } else if (state !== CELL.EMPTY) {
      return false;
    }
    return this.constraints(r, c).every((n) => {
      const mine = edges[n.edge];
      if (mine === NEUTRAL || n.value === NEUTRAL) return true;
      return mine === n.value;
    });
  }

  /** Every legal placement for this tile, with the wall flag resolved. */
  legalMoves(edges) {
    const out = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.canPlace(r, c, edges)) continue;
        out.push({ r, c, onWall: this.get(r, c) === CELL.WALL });
      }
    }
    return out;
  }

  /**
   * Place a tile. When playing onto a wall, the wall's colour is fixed by the
   * first tile that matches it (and can never change afterwards).
   *
   * Returns `{ ok, onWall }` rather than a bare boolean: a successful floor
   * placement has `onWall === false`, so returning `onWall` directly would make
   * "placed on the floor" indistinguishable from "rejected".
   */
  place(r, c, tile) {
    const i = this.idx(r, c);
    const onWall = this.cells[i] === CELL.WALL;

    // A cell that already holds a tile must never be written again. Note the
    // state check is NOT enough: a wall cell keeps its CELL.WALL state after
    // being filled, so `cells[i]` still reads as WALL and a second placement
    // would slip through, double-count and silently overwrite the first tile.
    if (this.tile[i] !== null) return { ok: false, onWall: false };

    this.tile[i] = tile;
    this.filledCount++;

    if (onWall && this.wallColor[i] === -1) {
      // Lock from a touching edge that already carries a known wall colour;
      // otherwise fall back to the tile's most meaningful edge.
      let locked = -1;
      for (const n of this.constraints(r, c)) {
        if (n.value !== -1 && n.value !== NEUTRAL && tile.edges[n.edge] === n.value) {
          locked = n.value;
          break;
        }
      }
      if (locked === -1) {
        for (let e = 0; e < 4; e++) {
          if (tile.edges[e] !== NEUTRAL) { locked = tile.edges[e]; break; }
        }
      }
      this.wallColor[i] = locked === -1 ? NEUTRAL : locked;
    }

    this.cells[i] = onWall ? CELL.WALL : CELL.FLOOR;
    return { ok: true, onWall };
  }

  /** Mark an empty cell as a wall carrying `color`. */
  markWall(r, c, color) {
    if (!this.isEmpty(r, c)) return false;
    const i = this.idx(r, c);
    this.cells[i] = CELL.WALL;
    this.wallColor[i] = color;
    return true;
  }

  /**
   * Cells still available: EMPTY cells plus marked-but-unfilled WALL cells.
   * A wall with no tile on it can still be played, so it is not consumed.
   */
  emptyCount() {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL.EMPTY) n++;
      else if (this.cells[i] === CELL.WALL && !this.tile[i]) n++;
    }
    return n;
  }
  /** Full means every cell carries a tile — a bare wall is still playable. */
  isFull() {
    for (let i = 0; i < this.cells.length; i++) {
      if (!this.tile[i]) return false;
    }
    return true;
  }

  /** All 12 lines (5 rows + 5 columns + 2 diagonals). */
  allLines() {
    const n = this.size;
    const lines = [];
    for (let r = 0; r < n; r++) {
      lines.push({ kind: 'row', index: r, cells: Array.from({ length: n }, (_, c) => this.idx(r, c)) });
    }
    for (let c = 0; c < n; c++) {
      lines.push({ kind: 'col', index: c, cells: Array.from({ length: n }, (_, r) => this.idx(r, c)) });
    }
    lines.push({
      kind: 'diag', index: 0,
      cells: Array.from({ length: n }, (_, i) => this.idx(i, i)),
    });
    lines.push({
      kind: 'diag', index: 1,
      cells: Array.from({ length: n }, (_, i) => this.idx(i, n - 1 - i)),
    });
    return lines;
  }

  /**
   * Final score.
   *  - completed line of 5 walls = COLOR_META[color].wall (1 blue .. 10 white)
   *  - +1 per unused tile left in hand
   *  - +1 per wall that never became part of a completed line
   *
   * There is deliberately NO bonus for leftover empty cells. Both players see
   * the same board, so such a bonus is identical for everyone and only adds a
   * constant to the final number, which makes the running score during play
   * meaningless. Effort credit for unfinished walls is kept instead, so
   * committing to a line is never worthless.
   */
  score(tilesInHand = 0) {
    let total = 0;
    const completed = [];
    const partial = [];

    for (const line of this.allLines()) {
      const colours = line.cells.map((i) => ({
        wall: this.cells[i] === CELL.WALL,
        color: this.wallColor[i],
      }));
      const wallCount = colours.filter((c) => c.wall).length;
      if (wallCount < this.size) continue;

      const unique = new Set(colours.map((c) => c.color));
      const isLine = unique.size === 1 && !unique.has(NEUTRAL);
      if (isLine) {
        const color = colours[0].color;
        total += COLOR_META[color].wall;
        completed.push({ line, color, points: COLOR_META[color].wall });
      } else {
        partial.push({ line, wallCount });
      }
    }

    total += tilesInHand;
    // Effort credit: count marked walls that did not finish a line.
    const inPartial = new Set();
    for (const p of partial) for (const i of p.line.cells) inPartial.add(i);
    let residual = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === CELL.WALL && !inPartial.has(i)) residual++;
    }
    total += residual;

    return { total, completed, partial, residual, tilesInHand };
  }

  toJSON() {
    return {
      size: this.size,
      cells: this.cells.slice(),
      wallColor: this.wallColor.slice(),
      tiles: this.tile.map((t) => (t ? [t.id, t.variant] : null)),
      filledCount: this.filledCount,
    };
  }

  static fromJSON(data, tilePool) {
    const b = new Board(data.size);
    b.cells = data.cells.slice();
    b.wallColor = data.wallColor.slice();
    b.filledCount = data.filledCount;
    b.tile = data.tiles.map((entry) => {
      if (!entry) return null;
      const [id, variant] = entry;
      const base = tilePool.find((t) => t.id === id);
      return base ? { ...base, variant } : null;
    });
    return b;
  }
}
