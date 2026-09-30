import * as THREE from 'three';
import { rand, randInt, clamp, damp, TAU } from './util.js';
import { resolveStaticCollision, ARENA_HALF } from './arena.js';

/**
 * Enemy archetypes. Stats scale with wave via the director, so the table below
 * is the *base* — `applyWave` multiplies.
 *
 * `scale` is deliberately chunky: a 0.45m drone at 30m is a handful of pixels,
 * and the player has to be able to read and track threats across the arena.
 */
export const ENEMY_TYPES = {
  drone: {
    name: 'drone', hp: 30, speed: 3.0, damage: 7, attackRange: 11, attackCd: 1.5,
    projectile: true, projectileSpeed: 13, score: 100, color: 0xff2e88, scale: 1.5,
    behavior: 'kite', radius: 0.55,
  },
  runner: {
    name: 'runner', hp: 22, speed: 6.4, damage: 11, attackRange: 1.5, attackCd: 0.9,
    projectile: false, score: 120, color: 0x9dff4f, scale: 1.25,
    behavior: 'charge', radius: 0.45,
  },
  bulwark: {
    name: 'bulwark', hp: 120, speed: 1.5, damage: 16, attackRange: 16, attackCd: 1.1,
    projectile: true, projectileSpeed: 9, score: 250, color: 0xffc24f, scale: 1.7,
    behavior: 'siege', radius: 0.9,
  },
  sentinel: {
    name: 'sentinel', hp: 200, speed: 2.4, damage: 12, attackRange: 18, attackCd: 1.3,
    projectile: true, projectileSpeed: 15, score: 400, color: 0x9d6bff, scale: 1.55,
    behavior: 'strafe', radius: 0.7,
  },
  boss: {
    name: 'boss', hp: 900, speed: 2.6, damage: 22, attackRange: 22, attackCd: 1.0,
    projectile: true, projectileSpeed: 12, score: 2500, color: 0xff2e88, scale: 2.4,
    behavior: 'boss', radius: 1.6,
  },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _rayDirs = [];

let nextId = 1;

export class Enemy {
  constructor(scene, typeName, pos, waveScale = 1) {
    this.id = nextId++;
    this.def = ENEMY_TYPES[typeName];
    this.type = typeName;
    this.scene = scene;
    this.waveScale = waveScale;

    this.maxHp = Math.round(this.def.hp * waveScale);
    this.hp = this.maxHp;
    this.speed = this.def.speed * (1 + (waveScale - 1) * 0.12);
    this.damage = this.def.damage * (1 + (waveScale - 1) * 0.08);
    this.score = Math.round(this.def.score * (1 + (waveScale - 1) * 0.15));

    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.attackTimer = rand(0.3, this.def.attackCd);
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = rand(1, 3);
    this.hitFlash = 0;
    this.dead = false;
    this.isBoss = typeName === 'boss';
    this.bossPhase = 0;
    this.spawnAnim = 0;

    this._build();
  }

  _build() {
    const d = this.def;
    const g = new THREE.Group();
    g.position.copy(this.pos);
    g.userData.enemyId = this.id;
    this.group = g;
    this.scene.add(g);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x1c2634,
      emissive: new THREE.Color(d.color).multiplyScalar(0.42),
      roughness: 0.45,
      metalness: 0.55,
    });
    this.mat = mat;
    const glowMat = new THREE.MeshBasicMaterial({ color: d.color });

    const s = d.scale;

    if (this.type === 'drone') {
      this.body = new THREE.Mesh(new THREE.OctahedronGeometry(0.5 * s, 0), mat);
      this.body.position.y = 0.9;
      g.add(this.body);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62 * s, 0.05, 6, 18), glowMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.9;
      g.add(ring);
      this.ring = ring;
      // hover
      this.hoverY = 1.4;
    } else if (this.type === 'runner') {
      this.body = new THREE.Mesh(new THREE.ConeGeometry(0.34 * s, 0.8 * s, 4), mat);
      this.body.position.y = 0.7;
      this.body.rotation.x = Math.PI / 2;
      g.add(this.body);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12 * s, 8, 6), glowMat);
      eye.position.set(0, 0.7, -0.4 * s);
      g.add(eye);
      this.hoverY = 0;
    } else if (this.type === 'bulwark') {
      this.body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 * s, 0), mat);
      this.body.position.y = 0.85;
      g.add(this.body);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.2 * s, 0.7 * s, 0.2 * s), glowMat);
      plate.position.set(0, 0.85, -0.7 * s);
      g.add(plate);
      this.plate = plate;
      this.hoverY = 0;
    } else if (this.type === 'sentinel') {
      this.body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 * s, 0), mat);
      this.body.position.y = 1.1;
      g.add(this.body);
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08 * s, 0.08 * s, 0.9 * s), glowMat);
        blade.position.y = 1.1;
        blade.rotation.y = (i / 3) * Math.PI;
        blade.rotation.x = 0.4;
        g.add(blade);
        (this.blades ||= []).push(blade);
      }
      this.hoverY = 1.5;
    } else if (this.type === 'boss') {
      this.body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0 * s, 1), mat);
      this.body.position.y = 1.8;
      g.add(this.body);
      const shellMat = new THREE.MeshBasicMaterial({ color: 0xff2e88, transparent: true, opacity: 0.6 });
      this.shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5 * s, 1), shellMat);
      this.shell.position.y = 1.8;
      g.add(this.shell);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        const turret = new THREE.Mesh(new THREE.ConeGeometry(0.22 * s, 0.7 * s, 6), glowMat);
        turret.position.set(Math.cos(a) * 1.3 * s, 1.6, Math.sin(a) * 1.3 * s);
        turret.rotation.x = -Math.PI / 2;
        g.add(turret);
        (this.turrets ||= []).push(turret);
      }
      this.hoverY = 0.2;
    }

    // A soft additive halo + a real point light: at 25m+ a 0.7m body is a few
    // pixels, so the glow is what actually makes a threat readable.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.85 * s, 12, 8),
      new THREE.MeshBasicMaterial({
        color: d.color, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    halo.position.y = 0.9;
    this.halo = halo;
    g.add(halo);

    const light = new THREE.PointLight(d.color, this.isBoss ? 14 : 3.2, this.isBoss ? 22 : 8, 2);
    light.position.y = 1.0;
    g.add(light);
    this.light = light;

    // health pip above (only for non-drones, keeps screen clean)
    if (!this.isBoss) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.09),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthTest: false }),
      );
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.06),
        new THREE.MeshBasicMaterial({ color: d.color, depthTest: false }),
      );
      fg.position.z = 0.001;
      bg.renderOrder = 900;
      fg.renderOrder = 901;
      this.hpBg = bg;
      this.hpFg = fg;
      this.hpGroup = new THREE.Group();
      this.hpGroup.add(bg, fg);
      g.add(this.hpGroup);
    }
  }

  update(dt, t, player, arena, fire, onPlayerHit) {
    if (this.dead) return;
    this.spawnAnim = Math.min(this.spawnAnim + dt * 3, 1);

    _v.subVectors(player.pos, this.pos);
    _v.y = 0;
    const dist = _v.length();
    const dirToPlayer = dist > 0.001 ? _v.clone().divideScalar(dist) : new THREE.Vector3(0, 0, 1);
    this.yaw = Math.atan2(-dirToPlayer.x, -dirToPlayer.z);

    const d = this.def;
    this.attackTimer -= dt;

    switch (d.behavior) {
      case 'kite': this._kite(dt, dist, dirToPlayer, player, arena, fire); break;
      case 'charge': this._charge(dt, dist, dirToPlayer, player, arena, onPlayerHit); break;
      case 'siege': this._siege(dt, dist, dirToPlayer, player, arena, fire); break;
      case 'strafe': this._strafe(dt, dist, dirToPlayer, player, arena, fire); break;
      case 'boss': this._boss(dt, t, dist, dirToPlayer, player, arena, fire, onPlayerHit); break;
    }

    // integrate + collide
    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = this.hoverY;
    const b = arena.bounds;
    this.pos.x = clamp(this.pos.x, -b, b);
    this.pos.z = clamp(this.pos.z, -b, b);
    resolveStaticCollision(this.pos, d.radius, arena.colliders);

    this.vel.multiplyScalar(Math.exp(-3.5 * dt));
    this._animate(dt, t);
  }

  _kite(dt, dist, dir, player, arena, fire) {
    // Drone: drift to mid range, strafe, fire orbs.
    const d = this.def;
    const want = d.attackRange * 0.7;
    let mvx = dir.x, mvz = dir.z;
    if (dist < want) { mvx = -dir.x; mvz = -dir.z; }        // back off
    else if (dist > want + 3) { /* approach */ }
    else { mvx = -dir.z * this.strafeDir; mvz = dir.x * this.strafeDir; }
    this.vel.x = damp(this.vel.x, mvx * this.speed, 6, dt);
    this.vel.z = damp(this.vel.z, mvz * this.speed, 6, dt);

    if (this.attackTimer <= 0 && dist < d.attackRange) {
      this.attackTimer = d.attackCd;
      this._shoot(player, fire);
    }
  }

  _charge(dt, dist, dir, player, arena, onPlayerHit) {
    // Runner: charge straight, contact damage.
    const d = this.def;
    this.vel.x = damp(this.vel.x, dir.x * this.speed, 9, dt);
    this.vel.z = damp(this.vel.z, dir.z * this.speed, 9, dt);
    if (dist < d.attackRange) {
      if (this.attackTimer <= 0) {
        this.attackTimer = d.attackCd;
        onPlayerHit(this.damage, this.pos);
      }
    }
  }

  _siege(dt, dist, dir, player, arena, fire) {
    const d = this.def;
    // Bulwark: slow advance, fires heavy slow orbs, front plate flashes on hit.
    const stopRange = 12;
    let mvx = 0, mvz = 0;
    if (dist > stopRange) { mvx = dir.x; mvz = dir.z; }
    else { mvx = -dir.z * this.strafeDir * 0.4; mvz = dir.x * this.strafeDir * 0.4; }
    this.vel.x = damp(this.vel.x, mvx * this.speed, 5, dt);
    this.vel.z = damp(this.vel.z, mvz * this.speed, 5, dt);
    if (this.attackTimer <= 0 && dist < d.attackRange) {
      this.attackTimer = d.attackCd;
      this._shoot(player, fire, d.projectileSpeed, 1.5);
    }
  }

  _strafe(dt, dist, dir, player, arena, fire) {
    const d = this.def;
    // Sentinel: keep mid distance, orbit, burst fire.
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = rand(1.5, 3.5); }
    const want = 10;
    let mvx = 0, mvz = 0;
    if (dist > want + 2) { mvx = dir.x; mvz = dir.z; }
    else if (dist < want - 2) { mvx = -dir.x; mvz = -dir.z; }
    mvx += -dir.z * this.strafeDir;
    mvz += dir.x * this.strafeDir;
    this.vel.x = damp(this.vel.x, mvx * this.speed, 5, dt);
    this.vel.z = damp(this.vel.z, mvz * this.speed, 5, dt);
    if (this.attackTimer <= 0 && dist < d.attackRange) {
      this.attackTimer = d.attackCd;
      this._shoot(player, fire);
      // second orb shortly after, for a burst feel
      this.burstPending = 0.12;
    }
    if (this.burstPending > 0) {
      this.burstPending -= dt;
      if (this.burstPending <= 0) this._shoot(player, fire, d.projectileSpeed, 0.85);
    }
  }

  _boss(dt, t, dist, dir, player, arena, fire, onPlayerHit) {
    const d = this.def;
    // Phase change at 50% hp: faster, more aggressive.
    const phase2 = this.hp / this.maxHp < 0.5;
    if (phase2 && this.bossPhase === 0) {
      this.bossPhase = 1;
      this.speed *= 1.35;
    }
    // Move toward player but keep some range, orbit.
    const want = 8;
    let mvx = 0, mvz = 0;
    if (dist > want) { mvx = dir.x; mvz = dir.z; }
    else { mvx = -dir.z * this.strafeDir; mvz = dir.x * this.strafeDir; }
    this.vel.x = damp(this.vel.x, mvx * this.speed, 4, dt);
    this.vel.z = damp(this.vel.z, mvz * this.speed, 4, dt);

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = rand(2, 4); }

    if (this.attackTimer <= 0) {
      this.attackTimer = phase2 ? d.attackCd * 0.6 : d.attackCd;
      // radial spread of orbs
      const n = phase2 ? 9 : 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + t;
        this._shootDir(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), fire, d.projectileSpeed, phase2 ? 1.15 : 0.95);
      }
      // plus a targeted orb
      this._shoot(player, fire, d.projectileSpeed, 1.2);
    }
  }

  _shoot(player, fire, speed = this.def.projectileSpeed, scale = 1) {
    // Aim from muzzle height toward the player's eye so orbs actually connect.
    const origin = _v2.copy(this.pos);
    origin.y += 0.9 * this.def.scale;
    const dir = _v.set(player.pos.x - origin.x, player.pos.y - origin.y, player.pos.z - origin.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    fire(origin, dir, speed * scale, this.damage, this.def.color);
  }

  /** Fire along an arbitrary direction (boss radial spread). */
  _shootDir(dir, fire, speed = this.def.projectileSpeed, scale = 1) {
    const origin = _v2.copy(this.pos);
    origin.y += 0.9 * this.def.scale;
    fire(origin, dir, speed * scale, this.damage, this.def.color);
  }

  _animate(dt, t) {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;

    const bob = Math.sin(t * 2.2 + this.id) * 0.08;
    if (this.hoverY > 0 && this.body) this.body.position.y = (this.type === 'drone' ? 0.9 : this.hoverY) + bob;
    if (this.halo) {
      // halo stays centred on the body and pulses gently so threats breathe
      this.halo.position.y = this.body ? this.body.position.y : 0.9;
      this.halo.material.opacity = 0.18 + Math.sin(t * 3 + this.id) * 0.06;
    }
    if (this.ring) this.ring.rotation.z += dt * 3;
    if (this.body && (this.type === 'runner' || this.type === 'bulwark' || this.type === 'sentinel' || this.type === 'boss')) {
      this.body.rotation.y += dt * 1.2;
    }
    if (this.blades) for (const b of this.blades) b.rotation.y += dt * 4;
    if (this.turrets) for (const tt of this.turrets) tt.rotation.y += dt * 2;
    if (this.shell) {
      this.shell.rotation.y -= dt * 0.5;
      this.shell.rotation.x += dt * 0.3;
    }

    // hit flash
    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const k = clamp(this.hitFlash / 0.12, 0, 1);
      this.mat.emissive.setRGB(k, k * 0.4, k * 0.4);
    }

    // health pip
    if (this.hpGroup) {
      const frac = clamp(this.hp / this.maxHp, 0, 1);
      this.hpFg.scale.x = Math.max(frac, 0.001);
      this.hpFg.position.x = -(1 - frac) * 0.5;
      this.hpGroup.position.y = (this.hoverY > 0 ? this.hoverY + 0.9 : 1.6) * this.def.scale;
      this.hpGroup.lookAt(0, 0, 0); // billboard handled by renderer copy in manager
    }

    // spawn pop-in scale
    const s = this.def.scale * (0.5 + 0.5 * this.spawnAnim);
    this.group.scale.setScalar(s);
  }

  takeDamage(amount) {
    if (this.dead) return 0;
    this.hp -= amount;
    this.hitFlash = 0.12;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
    return amount;
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material.dispose?.();
      }
    });
  }
}
