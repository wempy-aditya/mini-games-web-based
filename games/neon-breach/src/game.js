import * as THREE from 'three';
import { Enemy, ENEMY_TYPES } from './enemy.js';
import { randomPoint, ARENA_HALF } from './arena.js';
import { clamp, rand, randInt, pick, TAU } from './util.js';
import { audio } from './audio.js';

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Raycaster();
_ray.far = 60;

/**
 * Wave director + combat. Owns enemy list, player shooting resolution, combo,
 * and the wave/intermission state machine.
 */
export class Game {
  constructor({ scene, camera, player, arena, fx, hud }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.arena = arena;
    this.fx = fx;
    this.hud = hud;

    this.state = 'idle'; // idle | playing | intermission | over
    this.enemies = [];
    this.wave = 0;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.waveTotal = 0;
    this.waveKilled = 0;
    this.run = this._freshRun();
    this.time = 0;
    this.recoil = 0;
    this.spread = 0;
    this.fireHeld = false;
  }

  _freshRun() {
    return {
      regen: 0,
      thorns: 0,
      dr: 1,             // damage reduction multiplier
      comboWindow: 3.2,  // seconds before combo resets
      comboBonus: 0,     // extra score multiplier per combo
      nova: 0,           // kill nova level
      taken: {},         // cardId -> stacks
      mods: [],          // cards taken this run
    };
  }

  // ── run control ──

  startRun() {
    this.enemies.forEach((e) => e.dispose(this.scene));
    this.enemies = [];
    this.player.reset();
    this.run = this._freshRun();
    this.wave = 0;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.time = 0;
    this.recoil = 0;
    this.state = 'playing';
    this.nextWave();
  }

  gameOver() {
    this.state = 'over';
    this.enemies.forEach((e) => e.dispose(this.scene));
    this.enemies = [];
  }

  // ── wave director ──

  nextWave() {
    this.wave += 1;
    this.combo = 1;
    this.comboTimer = 0;
    this.waveKilled = 0;

    const isBoss = this.wave % 5 === 0;
    const waveScale = 1 + (this.wave - 1) * 0.16;

    if (isBoss) {
      this.waveTotal = 1;
      const pos = randomPoint(14);
      const boss = new Enemy(this.scene, 'boss', pos, waveScale);
      this.enemies.push(boss);
      this.boss = boss;
      audio.bossSpawn();
      this.hud.setBoss(true, 1);
    } else {
      this.boss = null;
      // Composition ramps: more runners later, bulwarks from wave 3, etc.
      const budget = 4 + this.wave * 2;
      const roster = ['drone'];
      if (this.wave >= 2) roster.push('runner');
      if (this.wave >= 3) roster.push('bulwark');
      if (this.wave >= 6) roster.push('sentinel');

      this.waveTotal = 0;
      let spent = 0;
      let guard = 0;
      while (spent < budget && guard++ < 200) {
        const type = pick(roster);
        const cost = ENEMY_TYPES[type].hp <= 30 ? 1 : ENEMY_TYPES[type].hp <= 130 ? 2 : 3;
        if (spent + cost > budget) break;
        spent += cost;
        this.spawnEnemy(type, waveScale);
      }
    }

    this.hud.setWave(this.wave, this.waveKilled, this.waveTotal);
    audio.waveStart(this.wave);
  }

  spawnEnemy(type, waveScale) {
    // Spawn away from player so nothing pops in on top of them.
    let pos = randomPoint(6);
    for (let i = 0; i < 10; i++) {
      if (pos.distanceTo(this.player.pos) > 12) break;
      pos = randomPoint(6);
    }
    const e = new Enemy(this.scene, type, pos, waveScale);
    this.enemies.push(e);
    this.waveTotal += 1;
    return e;
  }

  // ── combat ──

  tryShoot() {
    const p = this.player;
    if (!p.canShoot()) {
      if (p.mag === 0) audio.reloadClick();
      return;
    }
    p.consumeShot();

    // base spread + recoil. Kept small: at 10 shots/s even 0.02 rad compounds
    // into a full miss, which reads as "my gun is broken" not "recoil".
    this.spread = Math.min(this.spread + 0.012, 0.05);
    const spreadRad = this.spread;

    p.aimDir(_dir);
    // apply spread
    _dir.x += rand(-spreadRad, spreadRad);
    _dir.y += rand(-spreadRad, spreadRad);
    _dir.z += rand(-spreadRad, spreadRad);
    _dir.normalize();

    const muzzle = p.muzzleWorld(new THREE.Vector3());
    this.fx.muzzle(muzzle, _dir, 0xfff0a8);
    audio.shoot();

    // Hitscan ray starts at the eye, not the muzzle — see player.eyePosition.
    const origin = p.eyePosition(new THREE.Vector3());

    // raycast against enemy hit spheres (manual, cheaper + forgiving)
    const crit = Math.random() < p.critChance;
    let dmg = 22 * p.damageMul * (crit ? p.critMul : 1);

    const hit = this._hitscan(origin, _dir, dmg, crit);
    if (hit) {
      this.fx.tracer(muzzle, hit.point, crit ? 0xffc24f : 0xfff0a8);
    } else {
      // tracer to far point
      _v.copy(origin).addScaledVector(_dir, 60);
      this.fx.tracer(muzzle, _v, 0x9fd8ff, 0.05);
    }

    this.recoil = Math.min(this.recoil + 0.012, 0.05);
    p.pitch += rand(0.002, 0.006);
    p.kick(1);
  }

  _hitscan(origin, dir, dmg, crit) {
    const p = this.player;
    let best = null;
    let bestT = Infinity;

    for (const e of this.enemies) {
      if (e.dead) continue;
      // sphere at enemy center
      _v.copy(e.pos);
      _v.y += e.hoverY > 0 ? e.hoverY : 0.9 * e.def.scale;
      const toE = _v.clone().sub(origin);
      const tca = toE.dot(dir);
      if (tca < 0) continue;
      const d2 = toE.lengthSq() - tca * tca;
      const r = e.def.radius * e.def.scale * 1.15;
      if (d2 > r * r) continue;
      const thc = Math.sqrt(r * r - d2);
      const t0 = tca - thc;
      const t = t0 < 0 ? tca : t0;
      if (t < bestT) { bestT = t; best = e; }
    }

    if (best) {
      p.shotsHit += 1;
      const point = origin.clone().addScaledVector(dir, bestT);
      this._damageEnemy(best, dmg, crit, point);
      this.hud.hitmark(best.dead);
      audio.hit(crit);
      return { enemy: best, point };
    }
    return null;
  }

  _damageEnemy(e, dmg, crit, point) {
    e.takeDamage(dmg);
    this.fx.impact(point, crit ? 0xffc24f : 0x8ef0ff, crit ? 1.4 : 1);
    if (crit) this.fx.sparkBurst(point, 5, 0xffc24f, 7);

    // lifesteal on kill only
    if (e.dead) {
      this._onKill(e, point);
    }
  }

  _onKill(e, point) {
    this.player.addKill();
    this.waveKilled += 1;

    // combo
    this.combo = Math.min(this.combo + 1, 99);
    this.comboTimer = this.run.comboWindow;

    // score: base * combo * bonus, crit flag for feed
    const mult = 1 + (this.combo - 1) * 0.12 + (this.combo - 1) * this.run.comboBonus;
    const gained = Math.round(e.score * mult);
    this.score += gained;

    this.fx.explode(point, e.isBoss ? 3.2 : 1.5, e.def.color);
    if (e.isBoss) {
      audio.explode();
      this.hud.setBoss(false, 0);
      this.boss = null;
    } else {
      audio.kill();
    }
    this.hud.killfeed(`<b>${e.type}</b> +${gained}${this.combo > 2 ? ` (${this.combo}×)` : ''}`);

    // lifesteal
    if (this.player.lifesteal > 0) {
      const healed = this.player.heal(this.player.lifesteal);
      if (healed > 0) this.hud.flashHeal();
    }

    // kill nova: damage nearby enemies
    if (this.run.nova > 0) {
      const radius = 2 + this.run.nova;
      for (const other of this.enemies) {
        if (other === e || other.dead) continue;
        if (other.pos.distanceTo(e.pos) < radius) {
          other.takeDamage(15 * this.run.nova);
          if (other.dead) this._onKill(other, other.pos);
        }
      }
    }

    // reactive armor thorns vs nearby
    if (this.run.thorns > 0) {
      // handled on contact damage below
    }

    e.dispose(this.scene);
    this.enemies = this.enemies.filter((x) => x !== e);
  }

  // ── per-frame ──

  update(dt) {
    this.time += dt;

    if (this.state === 'playing') {
      this._updateRegen(dt);
      this._updateEnemies(dt);
      this._updateProjectiles(dt);
      this._updateCombo(dt);
      this._updateRecoil(dt);
      if (this.fireHeld) this.tryShoot();
      this._checkWaveEnd();
    }
  }

  _updateRegen(dt) {
    if (this.run.regen > 0 && this.player.alive) {
      this.player.hp = clamp(this.player.hp + this.run.regen * dt, 0, this.player.maxHp);
    }
  }

  _updateEnemies(dt) {
    const fire = (origin, dir, speed, damage, color) => {
      this.fx.fireball(origin, dir, speed, damage, color);
    };
    const onHit = (dmg, fromPos) => {
      if (!this.player.alive) return;
      const dmgReduced = dmg * this.run.dr;
      this.player.hurt(dmgReduced);
      this.hud.flashDamage(1);
      if (this.run.thorns > 0) {
        // nearest enemy takes thorns
        let near = null, nd = Infinity;
        for (const e of this.enemies) {
          if (e.dead) continue;
          const dd = e.pos.distanceTo(fromPos);
          if (dd < nd) { nd = dd; near = e; }
        }
        if (near && nd < 3) {
          near.takeDamage(this.run.thorns);
          if (near.dead) this._onKill(near, near.pos);
        }
      }
      if (!this.player.alive) this._onPlayerDeath();
    };

    for (const e of this.enemies.slice()) {
      e.update(dt, this.time, this.player, this.arena, fire, onHit);
    }
  }

  _updateProjectiles(dt) {
    // The player is registered as a soft sphere target so orbs can't tunnel
    // through them; fx resolves the collision and hands us the target back.
    const targets = [{ pos: this.player.pos, radius: 0.72, active: this.player.alive }];

    this.fx.stepProjectiles(dt, this.arena.colliders, this.arena.bounds, targets, (p, hitTarget) => {
      if (hitTarget !== targets[0]) return; // scenery hit, no damage

      this.player.hurt(p.damage * this.run.dr);
      this.hud.flashDamage(0.7);
      if (this.run.thorns > 0) {
        let near = null, nd = Infinity;
        for (const e of this.enemies) {
          if (e.dead) continue;
          const dd = e.pos.distanceTo(p.mesh.position);
          if (dd < nd) { nd = dd; near = e; }
        }
        if (near && nd < 3) {
          near.takeDamage(this.run.thorns);
          if (near.dead) this._onKill(near, near.pos);
        }
      }
      if (!this.player.alive) this._onPlayerDeath();
    });
  }

  _updateCombo(dt) {
    if (this.combo > 1) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 1;
      }
    }
  }

  _updateRecoil(dt) {
    this.recoil = Math.max(this.recoil - dt * 0.3, 0);
    this.spread = Math.max(this.spread - dt * 0.12, 0.006);
    // pull view back down toward resting
    this.player.pitch -= this.recoil * 0.5;
    this.hud.setCrosshairSpread(6 + this.recoil * 120);
  }

  _checkWaveEnd() {
    if (this.enemies.length === 0 && this.state === 'playing') {
      this.state = 'intermission';
      audio.waveClear();
    }
  }

  _onPlayerDeath() {
    if (this.state === 'over') return;
    this.state = 'over';
    this.fx.explode(this.player.pos, 2.4, 0xff2e88);
    audio.gameOver();
  }

  // called when intermission ends (card chosen) to resume
  resumeFromIntermission() {
    this.state = 'playing';
    this.nextWave();
  }

  get comboMult() {
    return 1 + (this.combo - 1) * 0.12 + (this.combo - 1) * this.run.comboBonus;
  }
}
