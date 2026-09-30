/**
 * Canvas 2D renderer.
 *
 * Pure presentation: it reads the simulation and draws it, and it never mutates
 * game state. The one exception is the placement preview, which is a read of
 * pointer position and is reported back through a callback rather than applied.
 */

import { COLORS, TOWERS, ENEMIES } from './data.js';
import { CELL, GRID_COLS, GRID_ROWS, cellCenter, inGrid } from './geometry.js';
import { roundRect, TAU, clamp } from './util.js';

export const VIEW_W = CELL * GRID_COLS;   // 560
export const VIEW_H = CELL * GRID_ROWS;   // 280

export class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.hover = null;        // { col, row }
    this.selected = null;     // tower under inspection
    this.ghost = null;        // { type } when a build tool is armed
    this.shake = 0;
    this.time = 0;
    this.resize();
  }

  /**
   * Size the canvas from its own box.
   *
   * The width and height attributes are the drawing buffer; the CSS box is what
   * the layout gives us. Both are set explicitly here because a canvas with an
   * intrinsic 300x150 size otherwise fights the stylesheet.
   */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(240, Math.round(rect.width || VIEW_W));
    const h = Math.max(120, Math.round(rect.height || VIEW_H));
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.viewW = w;
    this.viewH = h;
    // One world unit maps to this many CSS pixels.
    this.scale = Math.min(w / VIEW_W, h / VIEW_H);
    this.offX = (w - VIEW_W * this.scale) / 2;
    this.offY = (h - VIEW_H * this.scale) / 2;
  }

  /** Convert a client point into world coordinates. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offX) / this.scale,
      y: (clientY - rect.top - this.offY) / this.scale,
    };
  }

  /** Convert a client point into a grid cell, or null when off-grid. */
  cellAt(clientX, clientY) {
    const w = this.toWorld(clientX, clientY);
    const col = Math.floor(w.x / CELL);
    const row = Math.floor(w.y / CELL);
    return inGrid(col, row) ? { col, row } : null;
  }

  addShake(amount) {
    this.shake = Math.min(14, this.shake + amount);
  }

  draw(dt = 0) {
    const { ctx } = this;
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 26);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.viewW, this.viewH);

    // Screen shake from a leak or a boss death.
    if (this.shake > 0.2) {
      const a = this.shake;
      ctx.translate(
        (Math.random() - 0.5) * a,
        (Math.random() - 0.5) * a,
      );
    }

    ctx.translate(this.offX, this.offY);
    ctx.scale(this.scale, this.scale);

    this.drawGround();
    this.drawPath();
    this.drawGrid();
    this.drawPlacement();
    this.drawTowers();
    this.drawEnemies();
    this.drawProjectiles();
    this.drawEffects();

    if (this.selected) this.drawTowerPanel(this.selected);

    ctx.restore();
  }

  // ── layers ───────────────────────────────────────────────────────────────

  drawGround() {
    const { ctx } = this;
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // A subtle checker so the field reads as a place, not a void.
    ctx.fillStyle = COLORS.grassAlt;
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        if ((col + row) % 2 === 0) ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
      }
    }
  }

  drawPath() {
    const { ctx } = this;
    const pts = this.sim.path.points;

    // Wide dark casing, then a lighter road on top: the two-tone read is what
    // makes the route legible against the grass.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.pathEdge;
    ctx.lineWidth = 30;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();

    ctx.strokeStyle = COLORS.path;
    ctx.lineWidth = 24;
    ctx.stroke();

    // Dashed centre line, animated so the road reads as directional.
    ctx.save();
    ctx.setLineDash([6, 12]);
    ctx.lineDashOffset = -this.time * 18;
    ctx.strokeStyle = 'rgba(240,180,41,0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Spawn marker and core.
    const start = pts[0];
    const end = pts[pts.length - 1];
    ctx.fillStyle = COLORS.hp;
    ctx.beginPath();
    ctx.arc(start[0], start[1], 9, 0, TAU);
    ctx.fill();

    const pulse = 1 + Math.sin(this.time * 2.4) * 0.08;
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath();
    ctx.arc(end[0], end[1], 11 * pulse, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.font = 'bold 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', end[0], end[1]);
  }

  drawGrid() {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 0; col <= GRID_COLS; col++) {
      ctx.moveTo(col * CELL + 0.5, 0);
      ctx.lineTo(col * CELL + 0.5, VIEW_H);
    }
    for (let row = 0; row <= GRID_ROWS; row++) {
      ctx.moveTo(0, row * CELL + 0.5);
      ctx.lineTo(VIEW_W, row * CELL + 0.5);
    }
    ctx.stroke();
  }

  /** Hover highlight, build ghost, and the blocked-cell feedback. */
  drawPlacement() {
    const { ctx } = this;
    const sim = this.sim;

    if (this.hover) {
      const { col, row } = this.hover;
      const x = col * CELL;
      const y = row * CELL;
      const tower = sim.towerAt(col, row);
      const buildable = this.ghost ? sim.canBuild(col, row) : false;

      if (this.ghost && !tower) {
        ctx.fillStyle = buildable ? 'rgba(96,165,250,0.16)' : 'rgba(229,72,77,0.18)';
        ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
        ctx.strokeStyle = buildable ? COLORS.rangeEdge : 'rgba(229,72,77,0.7)';
        ctx.lineWidth = 2;
        roundRect(ctx, x + 3, y + 3, CELL - 6, CELL - 6, 6);
        ctx.stroke();

        if (buildable) {
          const def = TOWERS[this.ghost];
          // Show the reach of what is about to be placed, so range is a visible
          // part of the decision rather than something discovered after buying.
          const c = cellCenter(col, row);
          ctx.fillStyle = 'rgba(96,165,250,0.10)';
          ctx.beginPath();
          ctx.arc(c.x, c.y, def.range, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = COLORS.rangeEdge;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      } else if (tower) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x + 3, y + 3, CELL - 6, CELL - 6, 6);
        ctx.stroke();
      }
    }
  }

  drawTowers() {
    const { ctx } = this;
    for (const t of this.sim.towers) {
      const def = TOWERS[t.type];
      const r = CELL * 0.34;

      // Base pad.
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.arc(t.x, t.y + 2, r + 3, 0, TAU);
      ctx.fill();

      ctx.fillStyle = COLORS.panel2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r + 3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Turret barrel, pointing where the tower is aiming.
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.angle);
      ctx.fillStyle = def.color;
      roundRect(ctx, 0, -2.6, r + 5, 5.2, 2.4);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = def.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.52, 0, TAU);
      ctx.fill();
      ctx.fillStyle = COLORS.ink;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.22, 0, TAU);
      ctx.fill();

      // Level pips: a glanceable read of how upgraded this tower is.
      const total = Object.values(t.upgrades).reduce((a, b) => a + b, 0);
      if (total > 0) {
        ctx.fillStyle = COLORS.gold;
        const n = Math.min(6, total);
        for (let i = 0; i < n; i++) {
          ctx.fillRect(t.x - (n * 3) / 2 + i * 3, t.y + r + 4, 2, 2);
        }
      }
    }
  }

  drawEnemies() {
    const { ctx } = this;
    for (const e of this.sim.enemies) {
      const flash = e.hitFlash;
      const slowed = this.sim.clock < e.slowUntil;

      // Body.
      ctx.fillStyle = flash > 0.15 ? '#ffffff' : e.color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius, 0, TAU);
      ctx.fill();

      // A frozen enemy gets a visible frost ring, so a slow reads at a glance.
      if (slowed) {
        ctx.strokeStyle = '#a5b4fc';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius + 3, 0, TAU);
        ctx.stroke();
      }

      // Heading nub.
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + Math.cos(e.angle) * e.radius, e.y + Math.sin(e.angle) * e.radius);
      ctx.stroke();

      // Boss aura.
      if (e.boss) {
        ctx.strokeStyle = 'rgba(232,121,249,0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius + 6 + Math.sin(this.time * 3) * 2, 0, TAU);
        ctx.stroke();
      }

      // Health bar, but only when damaged: a full bar on everything is noise.
      if (e.hp < e.maxHp) {
        const w = e.radius * 2.2;
        const h = 3;
        const x = e.x - w / 2;
        const y = e.y - e.radius - 7;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        ctx.fillStyle = COLORS.hp;
        ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), h);
      }
    }
  }

  drawProjectiles() {
    const { ctx } = this;
    for (const p of this.sim.projectiles) {
      if (p.kind === 'frost') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, TAU);
        ctx.fill();
        continue;
      }
      // A short tail makes the travel direction readable at speed.
      const len = p.kind === 'shell' ? 7 : 10;
      const a = Math.atan2(p.ty - p.y, p.tx - p.x);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.kind === 'shell' ? 3.4 : 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.kind === 'shell' ? 3 : 1.8, 0, TAU);
      ctx.fill();
    }
  }

  drawEffects() {
    const { ctx } = this;
    for (const fx of this.sim.effects) {
      const u = fx.t / fx.life;
      const fade = 1 - u;

      switch (fx.kind) {
        case 'beam':
        case 'rail': {
          ctx.strokeStyle = fx.color;
          ctx.globalAlpha = fade;
          ctx.lineWidth = fx.kind === 'rail' ? 3 * fade : 2.4 * fade;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(fx.x1, fx.y1);
          ctx.lineTo(fx.x2, fx.y2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'boom': {
          ctx.globalAlpha = fade * 0.7;
          ctx.fillStyle = fx.color;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, fx.radius * (0.4 + u * 0.6), 0, TAU);
          ctx.fill();
          ctx.globalAlpha = fade;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'death': {
          const n = fx.big ? 12 : 6;
          ctx.fillStyle = fx.color;
          ctx.globalAlpha = fade;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU + u * 1.4;
            const d = (fx.big ? 30 : 16) * u;
            ctx.beginPath();
            ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, (fx.big ? 3.5 : 2.4) * fade, 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'leak': {
          ctx.globalAlpha = fade;
          ctx.strokeStyle = COLORS.hp;
          ctx.lineWidth = 3 * fade;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, 8 + u * 26, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'frostpop':
        case 'spark': {
          ctx.globalAlpha = fade;
          ctx.fillStyle = fx.color;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, (fx.kind === 'spark' ? 6 : 12) * (0.4 + u * 0.8), 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Range ring and level badge for the tower under inspection. */
  drawTowerPanel(tower) {
    const { ctx } = this;
    const def = TOWERS[tower.type];

    ctx.fillStyle = 'rgba(96,165,250,0.09)';
    ctx.beginPath();
    ctx.arc(tower.x, tower.y, tower.range, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = COLORS.rangeEdge;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    const total = Object.values(tower.upgrades).reduce((a, b) => a + b, 0);
    if (total === 0) return;

    ctx.fillStyle = COLORS.ink;
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), tower.x, tower.y);
  }
}
