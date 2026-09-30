/**
 * Canvas renderer.
 *
 * Everything is drawn procedurally — no image assets. The visual language is
 * Portuguese azulejo: cobalt on cream, a quarter-rosette in every cell, and
 * borders in a slightly darker glaze. Pattern geometry is derived from the
 * tile's edge colours so a tile's pattern always visually agrees with the
 * edges that constrain placement.
 */

import { COLOR_META } from './util.js';
import { CELL } from './board.js';
import { NEUTRAL } from './tile.js';

const TAU = Math.PI * 2;

export const THEME = {
  bg: '#0d1117',
  boardBg: '#f4efe2',
  boardEdge: '#1b3a6b',
  grout: '#d8cfb8',
  emptyFill: '#e8e0cc',
  emptyEdge: '#c3b79b',
  legal: '#2e9e5b',
  legalGlow: 'rgba(46,158,91,0.42)',
  blocked: 'rgba(180,60,60,0.30)',
  wallGhost: 'rgba(27,58,107,0.20)',
  select: '#f2a93b',
  shadow: 'rgba(6,10,18,0.35)',
  text: '#e8eaf0',
  textDim: '#8a94a6',
  panel: '#151b26',
  panelEdge: '#26304a',
  accent: '#d97b3f',
  accent2: '#2f6fb5',
  hi: '#f2d49b',
};

const PATTERNS = ['rosette', 'wave', 'star', 'cross', 'diamond'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = 0;
    this.origin = { x: 0, y: 0 };
    this.cell = 0;
    this.anim = new Map();   // cellKey -> { t, kind, color }
    this.resize();
  }

  /**
   * Fit the board to the space the layout actually gives it.
   *
   * The size is measured from the CANVAS element, and the canvas is sized by CSS
   * from its stage. Two traps this has to avoid:
   *
   *  1. Measuring the canvas and then letting CSS size the canvas from the
   *     canvas is circular — once the canvas is too big it stays too big.
   *  2. A `Math.max(320, ...)` floor silently breaks any viewport shorter than
   *     320px, producing a board taller than its container and a clipped last
   *     row. There is no minimum here on purpose: a small board beats a hidden
   *     one.
   */
  resize() {
    // Prefer the parent stage: it is the box the grid row gave us, and it does
    // not depend on the canvas we are about to resize.
    const host = this.canvas.parentElement || this.canvas;
    const box = host.getBoundingClientRect();

    const availW = Math.floor(box.width) - 24;   // stage padding
    const availH = Math.floor(box.height) - 24;
    const side = Math.max(120, Math.min(availW, availH));

    // Pin the canvas to the computed square so CSS cannot override it.
    this.canvas.style.width = `${side}px`;
    this.canvas.style.height = `${side}px`;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(side * this.dpr);
    this.canvas.height = Math.floor(side * this.dpr);
    this.cssW = side;
    this.cssH = side;

    // Board is square, centred, sized to fit with a margin.
    const margin = Math.min(side, side) * 0.055;
    this.cell = Math.max(8, Math.floor((side - margin * 2) / 5));
    const boardPx = this.cell * 5;
    this.origin = {
      x: Math.round((side - boardPx) / 2),
      y: Math.round((side - boardPx) / 2),
    };
    this.size = boardPx;
  }

  /** Canvas coords for a board cell's top-left corner. */
  cellRect(r, c) {
    return {
      x: this.origin.x + c * this.cell,
      y: this.origin.y + r * this.cell,
      s: this.cell,
    };
  }

  /** Which board cell is under a pointer position? */
  hit(px, py) {
    const c = Math.floor((px - this.origin.x) / this.cell);
    const r = Math.floor((py - this.origin.y) / this.cell);
    if (r < 0 || c < 0 || r >= 5 || c >= 5) return null;
    return { r, c };
  }

  animate(r, c, kind, color) {
    this.anim.set(`${r},${c}`, { t: performance.now(), kind, color });
  }

  // ── main draw ────────────────────────────────────────────────────────────

  draw(state) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this._drawBackdrop(ctx);
    this._drawBoardFrame(ctx);

    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        this._drawCell(ctx, state, r, c);
      }
    }

    this._drawLines(ctx, state);
  }

  _drawBackdrop(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, this.cssH);
    g.addColorStop(0, '#101725');
    g.addColorStop(1, THEME.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // faint radial glow behind the board
    const rg = ctx.createRadialGradient(
      this.cssW / 2, this.cssH / 2, this.cell * 0.5,
      this.cssW / 2, this.cssH / 2, this.cell * 4.2,
    );
    rg.addColorStop(0, 'rgba(47,111,181,0.14)');
    rg.addColorStop(1, 'rgba(47,111,181,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }

  _drawBoardFrame(ctx) {
    const { x, y, s } = this.origin;
    const pad = Math.round(this.cell * 0.16);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = THEME.boardBg;
    roundRect(ctx, x - pad, y - pad, s + pad * 2, s + pad * 2, this.cell * 0.1);
    ctx.fill();
    ctx.restore();

    // outer cobalt border with a thin inner keyline
    ctx.strokeStyle = THEME.boardEdge;
    ctx.lineWidth = Math.max(3, this.cell * 0.055);
    roundRect(ctx, x - pad, y - pad, s + pad * 2, s + pad * 2, this.cell * 0.1);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(27,58,107,0.45)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x - pad * 0.45, y - pad * 0.45, s + pad * 0.9, s + pad * 0.9, this.cell * 0.05);
    ctx.stroke();
  }

  _drawCell(ctx, state, r, c) {
    const { x, y, s } = this.cellRect(r, c);
    const board = state.board;
    const idx = r * 5 + c;
    const cellState = board.cells[idx];
    const tile = board.tile[idx];
    const anim = this.anim.get(`${r},${c}`);

    // base
    ctx.fillStyle = cellState === CELL.EMPTY ? THEME.emptyFill : THEME.boardBg;
    roundRect(ctx, x + 1.5, y + 1.5, s - 3, s - 3, this.cell * 0.05);
    ctx.fill();

    // grout lines between cells
    ctx.strokeStyle = THEME.grout;
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1.5, y + 1.5, s - 3, s - 3, this.cell * 0.05);
    ctx.stroke();

    if (cellState === CELL.EMPTY) {
      this._drawEmptyCell(ctx, state, r, c, x, y, s);
      return;
    }

    if (cellState === CELL.WALL) {
      this._drawWallBase(ctx, board.wallColor[idx], x, y, s);
    }

    if (tile) {
      const t = anim ? Math.min(1, (performance.now() - anim.t) / 260) : 1;
      const scale = anim ? 0.82 + 0.18 * ease(t) : 1;
      this._drawTile(ctx, tile, x, y, s, scale, anim);
    }
  }

  _drawEmptyCell(ctx, state, r, c, x, y, s) {
    const move = state.hoverMove;
    const isLegal = state.legalCells.has(`${r},${c}`);

    // Placeholder rosette so an empty board still reads as a board. Alpha is
    // deliberately higher than the first pass: at 0.13 the motif was
    // effectively invisible against the cream, leaving the board looking blank
    // rather than empty.
    ctx.save();
    ctx.globalAlpha = 0.26;
    ctx.strokeStyle = THEME.boardEdge;
    ctx.lineWidth = Math.max(1.5, s * 0.016);
    this._rosette(ctx, x + s / 2, y + s / 2, s * 0.31, 8);
    ctx.stroke();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s / 2, s * 0.10, 0, TAU);
    ctx.stroke();
    ctx.restore();

    if (isLegal) {
      ctx.save();
      ctx.fillStyle = THEME.legalGlow;
      roundRect(ctx, x + 3, y + 3, s - 6, s - 6, this.cell * 0.05);
      ctx.fill();
      ctx.strokeStyle = THEME.legal;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      roundRect(ctx, x + 3, y + 3, s - 6, s - 6, this.cell * 0.05);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (state.wallColorPick !== null && state.phase === 'wall' && state.canMarkWall) {
      ctx.save();
      ctx.fillStyle = hexA(COLOR_META[state.wallColorPick].hex, 0.16);
      roundRect(ctx, x + 3, y + 3, s - 6, s - 6, this.cell * 0.05);
      ctx.fill();
      ctx.restore();
    }

    if (move && move.r === r && move.c === c) {
      ctx.save();
      ctx.strokeStyle = THEME.select;
      ctx.lineWidth = 3.5;
      roundRect(ctx, x + 2, y + 2, s - 4, s - 4, this.cell * 0.05);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawWallBase(ctx, colorIdx, x, y, s) {
    const meta = colorIdx >= 0 && colorIdx < 5 ? COLOR_META[colorIdx] : null;
    ctx.save();
    ctx.fillStyle = meta ? hexA(meta.hex, 0.14) : THEME.wallGhost;
    roundRect(ctx, x + 2, y + 2, s - 4, s - 4, this.cell * 0.05);
    ctx.fill();

    // a wall reads as a slab: inner border in the wall colour
    if (meta) {
      ctx.strokeStyle = hexA(meta.hex, 0.75);
      ctx.lineWidth = Math.max(2.5, s * 0.035);
      roundRect(ctx, x + s * 0.09, y + s * 0.09, s * 0.82, s * 0.82, this.cell * 0.04);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draw a tile: cream base, coloured border band, and a pattern motif. */
  _drawTile(ctx, tile, x, y, s, scale = 1, anim = null) {
    const inset = s * (1 - scale) * 0.5;
    const bx = x + inset;
    const by = y + inset;
    const bs = s - inset * 2;

    ctx.save();

    if (anim && scale < 1) {
      ctx.globalAlpha = 0.6 + 0.4 * scale;
    }

    // base glaze
    ctx.fillStyle = THEME.boardBg;
    roundRect(ctx, bx + 2, by + 2, bs - 4, bs - 4, this.cell * 0.045);
    ctx.fill();

    // edge bands: each side painted in its own colour. This is the read that
    // makes the matching rules legible at a glance.
    const bandW = bs * 0.15;
    const edges = tile.edges;
    for (let e = 0; e < 4; e++) {
      const col = edges[e] === NEUTRAL ? null : COLOR_META[edges[e]];
      if (!col) continue;
      ctx.fillStyle = col.hex;
      const t = 3;
      if (e === 0) ctx.fillRect(bx + t, by + t, bs - t * 2, bandW);
      if (e === 1) ctx.fillRect(bx + bs - bandW - t, by + t, bandW, bs - t * 2);
      if (e === 2) ctx.fillRect(bx + t, by + bs - bandW - t, bs - t * 2, bandW);
      if (e === 3) ctx.fillRect(bx + t, by + t, bandW, bs - t * 2);
    }

    // inner field
    ctx.fillStyle = '#fbf7ec';
    ctx.fillRect(bx + bandW + 1, by + bandW + 1, bs - (bandW + 1) * 2, bs - (bandW + 1) * 2);

    // motif colour = the tile's dominant non-neutral edge
    const motif = motifColor(edges);
    this._drawPattern(ctx, tile, bx + bandW, by + bandW, bs - bandW * 2, motif);

    // outline
    ctx.strokeStyle = 'rgba(27,58,107,0.55)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, bx + 2, by + 2, bs - 4, bs - 4, this.cell * 0.045);
    ctx.stroke();

    ctx.restore();
  }

  _drawPattern(ctx, tile, px, py, ps, color) {
    const cx = px + ps / 2;
    const cy = py + ps / 2;
    const name = PATTERNS[tile.variant % PATTERNS.length];
    const deep = shade(color, -0.28);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = hexA(color, 0.2);
    ctx.lineWidth = Math.max(1.5, ps * 0.032);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (name) {
      case 'rosette':
        // Outer ring, then the petal rosette, then a centre boss: the classic
        // three-tier azulejo motif.
        ctx.strokeStyle = hexA(color, 0.55);
        ctx.lineWidth = Math.max(1, ps * 0.018);
        ctx.beginPath();
        ctx.arc(cx, cy, ps * 0.44, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, ps * 0.032);
        this._rosette(ctx, cx, cy, ps * 0.36, 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, ps * 0.115, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
        break;

      case 'wave':
        // Three offset wave bands plus small corner commas.
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          const yy = py + ps * (0.3 + i * 0.21);
          ctx.moveTo(px, yy);
          ctx.bezierCurveTo(px + ps * 0.28, yy - ps * 0.15, px + ps * 0.72, yy + ps * 0.15, px + ps, yy);
          ctx.stroke();
        }
        ctx.fillStyle = deep;
        for (const [dx, dy] of [[0.5, 0.5]]) {
          ctx.beginPath();
          ctx.arc(px + ps * dx, py + ps * dy, ps * 0.07, 0, TAU);
          ctx.fill();
        }
        break;

      case 'star': {
        // Eight-point star built from a star polygon, with an inner counter-form.
        const pts = 8;
        const outer = [];
        const inner = [];
        for (let i = 0; i < pts * 2; i++) {
          const a = (i / (pts * 2)) * TAU - Math.PI / 2;
          const rr = i % 2 === 0 ? ps * 0.40 : ps * 0.165;
          (i % 2 === 0 ? outer : inner).push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
        }
        ctx.beginPath();
        outer.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = deep;
        ctx.lineWidth = Math.max(1, ps * 0.022);
        ctx.stroke();

        ctx.beginPath();
        inner.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = hexA('#ffffff', 0.5);
        ctx.fill();
        break;
      }

      case 'cross': {
        // Cross with tapered arms plus four corner rosettes.
        ctx.beginPath();
        ctx.moveTo(cx, py + ps * 0.14);
        ctx.lineTo(cx, py + ps * 0.86);
        ctx.moveTo(px + ps * 0.14, cy);
        ctx.lineTo(px + ps * 0.86, cy);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, ps * 0.036);
        ctx.stroke();
        ctx.fillStyle = deep;
        for (const [dx, dy] of [[0.22, 0.22], [0.78, 0.22], [0.22, 0.78], [0.78, 0.78]]) {
          ctx.beginPath();
          ctx.arc(px + ps * dx, py + ps * dy, ps * 0.055, 0, TAU);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, ps * 0.1, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
        break;
      }

      default: {
        // Nested diamonds, the simplest of the set.
        ctx.beginPath();
        ctx.moveTo(cx, py + ps * 0.12);
        ctx.lineTo(px + ps * 0.88, cy);
        ctx.lineTo(cx, py + ps * 0.88);
        ctx.lineTo(px + ps * 0.12, cy);
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, ps * 0.034);
        ctx.stroke();
        ctx.fillStyle = hexA(color, 0.26);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx, py + ps * 0.33);
        ctx.lineTo(px + ps * 0.67, cy);
        ctx.lineTo(cx, py + ps * 0.67);
        ctx.lineTo(px + ps * 0.33, cy);
        ctx.closePath();
        ctx.fillStyle = deep;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _rosette(ctx, cx, cy, r, petals) {
    ctx.beginPath();
    for (let i = 0; i <= petals; i++) {
      const a0 = (i / petals) * TAU - Math.PI / 2;
      const a1 = ((i + 0.5) / petals) * TAU - Math.PI / 2;
      const a2 = ((i + 1) / petals) * TAU - Math.PI / 2;
      if (i === 0) ctx.moveTo(cx + Math.cos(a0) * r * 0.4, cy + Math.sin(a0) * r * 0.4);
      ctx.quadraticCurveTo(
        cx + Math.cos(a1) * r, cy + Math.sin(a1) * r,
        cx + Math.cos(a2) * r * 0.4, cy + Math.sin(a2) * r * 0.4,
      );
    }
  }

  /** Overlay showing which lines are still viable — the strategic read. */
  _drawLines(ctx, state) {
    if (!state.lineHints) return;
    for (const line of state.lineHints) {
      if (line.viable && line.walls === 0) continue;
      const cells = line.cells.map((i) => ({
        x: this.origin.x + (i % 5) * this.cell,
        y: this.origin.y + Math.floor(i / 5) * this.cell,
        s: this.cell,
      }));
      const pts = cells.map((p) => [p.x + p.s / 2, p.y + p.s / 2]);
      ctx.save();
      if (line.walls === 5 && line.viable) {
        ctx.strokeStyle = hexA(COLOR_META[line.color].hex, 0.9);
        ctx.lineWidth = Math.max(3, this.cell * 0.05);
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = line.viable ? 'rgba(46,158,91,0.42)' : 'rgba(200,90,90,0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 6]);
      }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function ease(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Lighten (t>0) or darken (t<0) a hex colour. `t` is a fraction. */
function shade(hex, t) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = ch.map((v) => {
    const next = t < 0 ? v * (1 + t) : v + (255 - v) * t;
    return Math.max(0, Math.min(255, Math.round(next)));
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

function motifColor(edges) {
  const counts = new Map();
  for (const e of edges) {
    if (e === NEUTRAL) continue;
    counts.set(e, (counts.get(e) || 0) + 1);
  }
  if (counts.size === 0) return THEME.boardEdge;
  let best = 0;
  let bestN = -1;
  for (const [k, v] of counts) {
    if (v > bestN) { bestN = v; best = k; }
  }
  return COLOR_META[best].hex;
}

export { hexA, PATTERNS };
