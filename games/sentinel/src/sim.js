/**
 * The simulation.
 *
 * This module is deliberately headless: no canvas, no DOM, no timers. It owns
 * towers, enemies, projectiles and economy, and advances by a fixed `step(dt)`.
 * The renderer reads from it; the test suite drives it directly. Keeping the
 * split is what makes "does the game logic actually work" answerable without a
 * browser.
 */

import { TOWERS, ENEMIES, UPGRADE_BY_ID, waveFor, waveScaling } from './data.js';
import { buildPath, pointAt, headingAt, cellCenter, isBuildable, targetInRange } from './geometry.js';
import { clamp } from './util.js';

export const START_GOLD = 220;
export const START_LIVES = 20;
export const MAX_TOWERS = 24;

let nextId = 1;

export class Sim {
  constructor(opts = {}) {
    this.pathKey = opts.pathKey || 'meander';
    this.path = buildPath(this.pathKey);
    this.gold = opts.gold ?? START_GOLD;
    this.lives = opts.lives ?? START_LIVES;
    // Kept separately so "how much of the core is left" stays meaningful after
    // leaks. Deriving it from lives + leaked would drift if a run is restored
    // from a save or if lives are granted back.
    this.startLives = this.lives;
    this.wave = 0;
    this.kills = 0;
    this.leaked = 0;
    this.goldEarned = 0;
    this.over = false;
    this.paused = false;
    this.speed = 1;
    this.clock = 0;

    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.effects = [];

    // Wave spawn queue: flattened, time-ordered list of { type, at, scale }.
    this.spawnQueue = [];
    this.waveActive = false;
    this.waveClock = 0;

    // A plan injected by the advisor replaces the scripted wave for one round.
    this.plan = null;
    this.lastReport = null;
  }

  // ── economy ──────────────────────────────────────────────────────────────

  get occupied() {
    return new Set(this.towers.map((t) => `${t.col},${t.row}`));
  }

  canBuild(col, row) {
    if (this.towers.length >= MAX_TOWERS) return false;
    return isBuildable(this.path, col, row, this.occupied);
  }

  /**
   * Effective stats for a tower type at a given upgrade set.
   *
   * `rate` is the seconds-between-shots stat; the live countdown lives in the
   * tower's own `cooldown` field. Keeping the two apart is what makes an
   * upgrade apply cleanly to a tower that is already in the field.
   */
  statsFor(typeId, upgradeLevels = {}) {
    const base = TOWERS[typeId];
    if (!base) return null;
    const s = {
      ...base,
      rate: base.cooldown,
      range: base.range,
      damage: base.damage,
      pierce: base.pierce || 1,
      chain: base.chain || 0,
      slow: base.slow || 0,
      slowTime: base.slowTime || 0,
      splash: base.splash || 0,
      economy: 1,
    };
    for (const [uid, lvl] of Object.entries(upgradeLevels)) {
      if (lvl <= 0) continue;
      const up = UPGRADE_BY_ID[uid];
      if (!up) continue;
      for (let i = 0; i < Math.min(lvl, up.max); i++) up.apply(s);
    }
    return s;
  }

  build(typeId, col, row) {
    const def = TOWERS[typeId];
    if (!def || this.over) return null;
    if (!this.canBuild(col, row)) return null;
    if (this.gold < def.cost) return null;

    const c = cellCenter(col, row);
    const stats = this.statsFor(typeId, {});
    const tower = {
      id: nextId++,
      type: typeId,
      col,
      row,
      x: c.x,
      y: c.y,
      upgrades: {},
      totalSpent: def.cost,
      cooldown: 0,
      angle: -Math.PI / 2,
      kills: 0,
      damageDealt: 0,
      ...stats,
    };
    this.towers.push(tower);
    this.gold -= def.cost;
    return tower;
  }

  upgradeCost(tower, upgradeId) {
    const up = UPGRADE_BY_ID[upgradeId];
    if (!up) return null;
    const lvl = tower.upgrades[upgradeId] || 0;
    if (lvl >= up.max) return null;
    return up.cost(lvl);
  }

  upgrade(tower, upgradeId) {
    const cost = this.upgradeCost(tower, upgradeId);
    if (cost === null || this.gold < cost || this.over) return false;
    this.gold -= cost;
    tower.totalSpent += cost;
    tower.upgrades[upgradeId] = (tower.upgrades[upgradeId] || 0) + 1;
    // Recompute from scratch: applying deltas in place would compound wrongly
    // if an upgrade were ever re-rolled or its definition changed.
    const fresh = this.statsFor(tower.type, tower.upgrades);
    for (const k of ['rate', 'range', 'damage', 'pierce', 'chain', 'slow', 'slowTime', 'splash', 'economy']) {
      tower[k] = fresh[k];
    }
    return true;
  }

  sell(tower) {
    const i = this.towers.indexOf(tower);
    if (i < 0 || this.over) return false;
    this.towers.splice(i, 1);
    this.gold += Math.floor(tower.totalSpent * 0.7);
    return true;
  }

  towerAt(col, row) {
    return this.towers.find((t) => t.col === col && t.row === row) || null;
  }

  /** Group towers by type, for the advisor's state summary. */
  composition() {
    const out = {};
    for (const t of this.towers) out[t.type] = (out[t.type] || 0) + 1;
    return out;
  }

  // ── waves ────────────────────────────────────────────────────────────────

  /** Begin wave n+1. Uses the injected plan when the advisor supplied one. */
  startWave(n = this.wave + 1) {
    this.wave = n;
    this.waveActive = true;
    this.waveClock = 0;

    const usePlan = Boolean(this.plan && this.plan.wave === n);
    const spec = usePlan ? this.plan : waveFor(n);
    // Only discard the plan once it has actually been used. Clearing it here
    // unconditionally threw away a plan the advisor had queued for a later wave.
    if (usePlan) this.plan = null;

    const scale = waveScaling(n);
    const queue = [];
    let t = 0;
    for (const g of spec.groups) {
      for (let i = 0; i < g.count; i++) {
        queue.push({ type: g.type, at: t, scale });
        t += g.gap;
      }
    }
    this.spawnQueue = queue;
    this.waveEndAt = t;
    this.lastReport = { wave: n, planned: usePlan, groups: spec.groups.map((g) => `${g.count}x ${g.type}`) };
    return this.lastReport;
  }

  /** True when the wave has fully resolved: nothing queued, nothing alive. */
  waveDone() {
    return !this.waveActive && this.spawnQueue.length === 0 && this.enemies.length === 0;
  }

  spawnEnemy(type, scale) {
    const def = ENEMIES[type];
    if (!def) return null;
    const p = pointAt(this.path, 0);
    const hp = Math.round(def.hp * scale);
    const e = {
      id: nextId++,
      type,
      hp,
      maxHp: hp,
      speed: def.speed,
      armor: def.armor,
      bounty: def.bounty,
      radius: def.radius,
      color: def.color,
      boss: Boolean(def.boss),
      progress: 0,
      x: p.x,
      y: p.y,
      angle: headingAt(this.path, 0),
      slowFactor: 1,
      slowUntil: 0,
      hitFlash: 0,
      dead: false,
    };
    this.enemies.push(e);
    return e;
  }

  // ── main step ────────────────────────────────────────────────────────────

  step(dt) {
    if (this.over || this.paused) return;
    // Clamp dt so an alt-tab or a slow first frame cannot teleport enemies
    // through the whole map in a single tick.
    const step = clamp(dt, 0, 0.05) * this.speed;
    this.clock += step;

    this.stepSpawns(step);
    this.stepEnemies(step);
    this.stepTowers(step);
    this.stepProjectiles(step);
    this.stepEffects(step);

    if (this.lives <= 0) {
      this.lives = 0;
      this.over = true;
    }
  }

  stepSpawns(dt) {
    if (!this.waveActive) return;
    this.waveClock += dt;
    while (this.spawnQueue.length && this.spawnQueue[0].at <= this.waveClock) {
      const s = this.spawnQueue.shift();
      this.spawnEnemy(s.type, s.scale);
    }
    if (this.spawnQueue.length === 0) this.waveActive = false;
  }

  stepEnemies(dt) {
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);

      const slowed = this.clock < e.slowUntil;
      e.progress += e.speed * (slowed ? e.slowFactor : 1) * dt;

      if (e.progress >= this.path.length) {
        e.dead = true;
        this.lives -= 1;
        this.leaked += 1;
        this.effects.push({ kind: 'leak', x: e.x, y: e.y, t: 0, life: 0.6, color: '#e5484d' });
        continue;
      }

      const p = pointAt(this.path, e.progress);
      e.x = p.x;
      e.y = p.y;
      e.angle = headingAt(this.path, e.progress);
    }
    if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
  }

  stepTowers(dt) {
    for (const t of this.towers) {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;

      const target = targetInRange(t, this.enemies);
      // No target: leave the cooldown at or below zero so the tower fires the
      // instant something walks into range rather than waiting out a full cycle.
      if (!target) continue;

      t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      t.cooldown = t.rate;
      this.fire(t, target);
    }
  }

  fire(tower, target) {
    switch (tower.projectile) {
      case 'shell':
        this.projectiles.push({
          kind: 'shell', x: tower.x, y: tower.y,
          targetId: target.id, tx: target.x, ty: target.y,
          speed: 300, damage: tower.damage, splash: tower.splash,
          color: tower.color, tower,
        });
        break;
      case 'frost':
        this.projectiles.push({
          kind: 'frost', x: tower.x, y: tower.y,
          targetId: target.id, tx: target.x, ty: target.y,
          speed: 260, damage: tower.damage,
          slow: tower.slow, slowTime: tower.slowTime, color: tower.color, tower,
        });
        break;
      case 'beam':
      case 'rail':
        this.fireInstant(tower, target);
        break;
      default:
        this.projectiles.push({
          kind: 'bolt', x: tower.x, y: tower.y,
          targetId: target.id, tx: target.x, ty: target.y,
          speed: 520, damage: tower.damage, pierce: tower.pierce || 1,
          hit: new Set(), color: tower.color, tower,
        });
    }
  }

  /** Hitscan weapons: beam chains, rail pierces a line. */
  fireInstant(tower, target) {
    if (tower.projectile === 'beam') {
      const hit = new Set();
      let cur = target;
      const max = Math.max(1, tower.chain);
      for (let i = 0; i < max && cur; i++) {
        this.damage(cur, tower.damage, tower);
        hit.add(cur);
        this.effects.push({
          kind: 'beam', x1: tower.x, y1: tower.y, x2: cur.x, y2: cur.y,
          t: 0, life: 0.16, color: tower.color,
        });
        let next = null;
        let bestD = Infinity;
        for (const e of this.enemies) {
          if (e.dead || hit.has(e.id)) continue;
          const d = (e.x - cur.x) ** 2 + (e.y - cur.y) ** 2;
          if (d < bestD && d < tower.range * tower.range) { bestD = d; next = e; }
        }
        cur = next;
      }
      return;
    }

    // Rail: everything on the line within range, nearest first.
    const dirX = Math.cos(tower.angle);
    const dirY = Math.sin(tower.angle);
    const onLine = [];
    for (const e of this.enemies) {
      const dx = e.x - tower.x;
      const dy = e.y - tower.y;
      const along = dx * dirX + dy * dirY;
      const perp = Math.abs(dx * dirY - dy * dirX);
      if (along > 0 && along < tower.range && perp < 16) onLine.push({ e, along });
    }
    onLine.sort((a, b) => a.along - b.along);
    for (const c of onLine.slice(0, Math.max(1, tower.pierce))) {
      this.damage(c.e, tower.damage, tower);
      this.effects.push({
        kind: 'rail', x1: tower.x, y1: tower.y, x2: c.e.x, y2: c.e.y,
        t: 0, life: 0.22, color: tower.color,
      });
    }
  }

  stepProjectiles(dt) {
    for (const p of this.projectiles) {
      // Re-acquire the target by id: a homing shell should keep chasing even if
      // the tower object it captured has since been sold.
      const t = this.enemies.find((e) => e.id === p.targetId && !e.dead);
      if (t) { p.tx = t.x; p.ty = t.y; }

      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const travel = p.speed * dt;

      if (d <= travel) {
        // Arrived: resolve the impact at the target's current position.
        p.x = p.tx;
        p.y = p.ty;
        this.impact(p);
        p.dead = true;
        continue;
      }

      p.x += (dx / d) * travel;
      p.y += (dy / d) * travel;
    }
    if (this.projectiles.some((p) => p.dead)) {
      this.projectiles = this.projectiles.filter((p) => !p.dead);
    }
  }

  impact(p) {
    if (p.kind === 'shell') {
      this.effects.push({ kind: 'boom', x: p.x, y: p.y, t: 0, life: 0.34, radius: p.splash, color: p.color });
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d > p.splash) continue;
        // Full damage at the centre, half at the rim.
        const falloff = 1 - 0.5 * (d / p.splash);
        this.damage(e, p.damage * falloff, p.tower);
      }
      return;
    }

    if (p.kind === 'frost') {
      this.effects.push({ kind: 'frostpop', x: p.x, y: p.y, t: 0, life: 0.3, color: p.color });
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) > 26) continue;
        this.applySlow(e, p.slow, p.slowTime);
        this.damage(e, p.damage, p.tower);
      }
      return;
    }

    // Bolt: pierce, and never hit the same enemy twice.
    this.effects.push({ kind: 'spark', x: p.x, y: p.y, t: 0, life: 0.2, color: p.color });
    for (const e of this.enemies) {
      if (e.dead || p.hit.has(e.id)) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) > e.radius + 6) continue;
      p.hit.add(e.id);
      this.damage(e, p.damage, p.tower);
      if (p.hit.size >= p.pierce) { p.dead = true; break; }
    }
  }

  stepEffects(dt) {
    for (const fx of this.effects) fx.t += dt;
    if (this.effects.some((fx) => fx.t >= fx.life)) {
      this.effects = this.effects.filter((fx) => fx.t < fx.life);
    }
  }

  // ── damage ───────────────────────────────────────────────────────────────

  damage(enemy, amount, tower = null) {
    if (!enemy || enemy.dead) return 0;
    // Armour subtracts flat damage, floored at a fifth of the raw hit so a
    // heavily armoured enemy can never become immune to chip damage.
    const dealt = Math.max(amount * 0.2, amount - enemy.armor);
    enemy.hp -= dealt;
    enemy.hitFlash = 1;
    if (tower) tower.damageDealt += dealt;

    if (enemy.hp <= 0) {
      enemy.dead = true;
      this.kills += 1;
      if (tower) tower.kills += 1;
      const econ = tower ? this.statsFor(tower.type, tower.upgrades).economy : 1;
      const bounty = Math.round(enemy.bounty * econ);
      this.gold += bounty;
      this.goldEarned += bounty;
      this.effects.push({
        kind: 'death', x: enemy.x, y: enemy.y, t: 0, life: enemy.boss ? 0.7 : 0.4,
        color: enemy.color, big: enemy.boss,
      });
    }
    return dealt;
  }

  applySlow(enemy, factor, time) {
    if (!enemy || enemy.dead) return;
    // Strongest and longest wins rather than stacking multiplicatively, so a
    // wall of frost towers cannot freeze a wave solid.
    const active = this.clock < enemy.slowUntil;
    if (active && factor >= enemy.slowFactor) return;
    enemy.slowFactor = active ? Math.min(enemy.slowFactor, factor) : factor;
    enemy.slowUntil = Math.max(enemy.slowUntil, this.clock + time);
  }

  // ── serialisation ────────────────────────────────────────────────────────

  toJSON() {
    return {
      pathKey: this.pathKey,
      gold: this.gold,
      lives: this.lives,
      startLives: this.startLives,
      wave: this.wave,
      kills: this.kills,
      leaked: this.leaked,
      goldEarned: this.goldEarned,
      clock: this.clock,
      towers: this.towers.map((t) => ({
        type: t.type, col: t.col, row: t.row,
        upgrades: { ...t.upgrades }, totalSpent: t.totalSpent,
        kills: t.kills, damageDealt: t.damageDealt,
      })),
    };
  }

  static fromJSON(data) {
    const sim = new Sim({
      pathKey: data.pathKey,
      gold: data.gold,
      lives: data.lives,
    });
    sim.wave = data.wave || 0;
    // A save written before startLives existed falls back to current lives,
    // which reports a damaged core as untouched. Not fatal, only less honest.
    sim.startLives = data.startLives || sim.lives;
    sim.kills = data.kills || 0;
    sim.leaked = data.leaked || 0;
    sim.goldEarned = data.goldEarned || 0;
    sim.clock = data.clock || 0;
    for (const t of data.towers || []) {
      const tower = sim.build(t.type, t.col, t.row);
      if (!tower) continue;
      tower.upgrades = { ...t.upgrades };
      tower.totalSpent = t.totalSpent;
      tower.kills = t.kills || 0;
      tower.damageDealt = t.damageDealt || 0;
      const fresh = sim.statsFor(t.type, tower.upgrades);
      for (const k of ['rate', 'range', 'damage', 'pierce', 'chain', 'slow', 'slowTime', 'splash', 'economy']) {
        tower[k] = fresh[k];
      }
    }
    // build() charged the player for every tower; a restore must not.
    sim.gold = data.gold;
    return sim;
  }
}
