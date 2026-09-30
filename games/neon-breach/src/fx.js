import * as THREE from 'three';
import { rand, TAU } from './util.js';

const POOL_MAX = 400;

/**
 * Pooled effects. Everything is preallocated; nothing allocates during a firefight
 * except VFX vector math, which reuses scratch objects.
 */
export class Fx {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.impacts = [];
    this.explosions = [];
    this.projectiles = [];
    this.sparks = [];
    this.muzzles = [];
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._buildPools();
  }

  _buildPools() {
    // Tracers: thin stretched box, additive, fade fast.
    const tracerGeo = new THREE.BoxGeometry(0.045, 0.045, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xfff0a8, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this.tracers.push({ mesh: m, life: 0, max: 0.07 });
    }

    // Impact flash: small additive sphere, scaled out.
    const impactGeo = new THREE.SphereGeometry(0.14, 8, 6);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(impactGeo, new THREE.MeshBasicMaterial({
        color: 0xaef, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.impacts.push({ mesh: m, life: 0, max: 0.14, base: 0.3 });
    }

    // Explosions: expanding additive sphere + ring.
    const boomGeo = new THREE.SphereGeometry(1, 14, 10);
    const ringGeo = new THREE.RingGeometry(0.5, 0.62, 20);
    for (let i = 0; i < 12; i++) {
      const sphere = new THREE.Mesh(boomGeo, new THREE.MeshBasicMaterial({
        color: 0xffb066, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      sphere.visible = false;
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xff5a3c, transparent: true, opacity: 1, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.scene.add(sphere, ring);
      this.explosions.push({ sphere, ring, life: 0, max: 0.5, size: 2 });
    }

    // Projectiles (enemy orbs) — instanced pool.
    const orbGeo = new THREE.SphereGeometry(0.14, 10, 8);
    for (let i = 0; i < 120; i++) {
      const m = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({
        color: 0xff2e88, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.projectiles.push({
        mesh: m, active: false, vel: new THREE.Vector3(),
        life: 0, damage: 8, radius: 0.35, color: 0xff2e88,
      });
    }

    // Sparks: small line segments that fly out and fade (crit / kill feel).
    const sparkGeo = new THREE.BoxGeometry(0.03, 0.03, 0.36);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({
        color: 0xffe08a, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.sparks.push({ mesh: m, life: 0, max: 0.3, vel: new THREE.Vector3() });
    }

    // Muzzle flash quads at the barrel.
    const muzzleGeo = new THREE.ConeGeometry(0.11, 0.4, 6);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(muzzleGeo, new THREE.MeshBasicMaterial({
        color: 0xfff0a8, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.muzzles.push({ mesh: m, life: 0, max: 0.05 });
    }
  }

  _take(pool) {
    for (const item of pool) {
      if (item.life <= 0) return item;
    }
    return null;
  }

  /** A stretched beam from muzzle to hit point. */
  tracer(from, to, color = 0xfff0a8, life = 0.07) {
    const t = this._take(this.tracers);
    if (!t) return;
    const dist = from.distanceTo(to);
    this._v.subVectors(to, from);
    t.mesh.position.copy(from).addScaledVector(this._v, 0.5);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, Math.max(dist, 0.01));
    t.mesh.material.color.setHex(color);
    t.mesh.material.opacity = 1;
    t.mesh.visible = true;
    t.life = t.max = life;
  }

  /** Small flash where a bullet landed. */
  impact(pos, color = 0x8ef0ff, scale = 1) {
    const it = this._take(this.impacts);
    if (!it) return;
    it.mesh.position.copy(pos);
    it.mesh.material.color.setHex(color);
    it.mesh.scale.setScalar(scale);
    it.mesh.material.opacity = 1;
    it.mesh.visible = true;
    it.life = it.max = 0.14;
    it.base = 0.4 * scale;
  }

  /** Cone of sparks for crits and heavy hits. */
  sparkBurst(pos, count = 6, color = 0xffe08a, speed = 6) {
    for (let i = 0; i < count; i++) {
      const s = this._take(this.sparks);
      if (!s) return;
      s.mesh.position.copy(pos);
      s.mesh.material.color.setHex(color);
      s.mesh.material.opacity = 1;
      s.mesh.visible = true;
      s.life = s.max = rand(0.2, 0.4);
      const theta = rand(0, TAU);
      const phi = rand(0.2, Math.PI - 0.2);
      s.vel.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed * 0.6,
        Math.sin(phi) * Math.sin(theta) * speed,
      );
    }
  }

  /** Death blast: expanding sphere + ground ring. */
  explode(pos, size = 1.6, color = 0xff9a4f) {
    const e = this._take(this.explosions);
    if (!e) return;
    e.sphere.position.copy(pos);
    e.sphere.material.color.setHex(color);
    e.sphere.material.opacity = 0.95;
    e.sphere.scale.setScalar(0.2);
    e.sphere.visible = true;
    e.ring.position.set(pos.x, 0.05, pos.z);
    e.ring.material.opacity = 0.9;
    e.ring.scale.setScalar(0.2);
    e.ring.visible = true;
    e.life = e.max = 0.5;
    e.size = size;
  }

  /** Muzzle flash at a barrel tip, oriented along `dir`. */
  muzzle(pos, dir, color = 0xfff0a8) {
    const m = this._take(this.muzzles);
    if (!m) return;
    m.mesh.position.copy(pos);
    m.mesh.lookAt(pos.clone().add(dir));
    m.mesh.material.color.setHex(color);
    m.mesh.material.opacity = 1;
    m.mesh.scale.setScalar(rand(0.8, 1.3));
    m.mesh.visible = true;
    m.life = m.max = 0.05;
  }

  /** Spawn a travelling enemy orb. Returns the handle (for homing moves). */
  fireball(from, dir, speed, damage, color = 0xff2e88, radius = 0.35) {
    for (const p of this.projectiles) {
      if (p.active) continue;
      p.active = true;
      p.life = 4;
      p.damage = damage;
      p.radius = radius;
      p.color = color;
      p.mesh.position.copy(from);
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.mesh.scale.setScalar(radius / 0.14);
      p.mesh.visible = true;
      p.vel.copy(dir).normalize().multiplyScalar(speed);
      return p;
    }
    return null;
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(t.life / t.max, 0);
      if (t.life <= 0) t.mesh.visible = false;
    }

    for (const it of this.impacts) {
      if (it.life <= 0) continue;
      it.life -= dt;
      const k = 1 - it.life / it.max;
      it.mesh.scale.setScalar(it.base * (0.4 + k * 1.6));
      it.mesh.material.opacity = Math.max(1 - k, 0);
      if (it.life <= 0) it.mesh.visible = false;
    }

    for (const e of this.explosions) {
      if (e.life <= 0) continue;
      e.life -= dt;
      const k = 1 - e.life / e.max;
      e.sphere.scale.setScalar(0.2 + k * e.size);
      e.sphere.material.opacity = Math.max(0.95 * (1 - k), 0);
      e.ring.scale.setScalar(0.2 + k * e.size * 1.6);
      e.ring.material.opacity = Math.max(0.9 * (1 - k) , 0);
      if (e.life <= 0) { e.sphere.visible = false; e.ring.visible = false; }
    }

    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 14 * dt; // gravity
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.mesh.position.y < 0.03) { s.mesh.position.y = 0.03; s.vel.multiplyScalar(0); }
      this._v.copy(s.mesh.position).add(s.vel);
      s.mesh.lookAt(this._v);
      s.mesh.material.opacity = Math.max(s.life / s.max, 0);
      if (s.life <= 0) s.mesh.visible = false;
    }

    for (const m of this.muzzles) {
      if (m.life <= 0) continue;
      m.life -= dt;
      m.mesh.material.opacity = Math.max(m.life / m.max, 0);
      if (m.life <= 0) m.mesh.visible = false;
    }

    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.material.opacity = p.life < 0.5 ? Math.max(p.life / 0.5, 0) : 1;
      if (p.life <= 0) { p.active = false; p.mesh.visible = false; }
    }
  }

  /**
   * Advance projectiles and report hits.
   *
   * `targets` are sphere colliders that must be able to absorb a projectile
   * (currently the player). This MUST be checked here, not only in the `onHit`
   * callback — the callback only fires on geometry/bounds hits, so an enemy orb
   * flying across open ground would pass straight through the player.
   */
  stepProjectiles(dt, colliders, bounds, targets, onHit) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      let hit = false;
      let hitTarget = null;

      // soft targets first (player) so it wins over scenery at the same spot
      if (targets) {
        for (const tg of targets) {
          if (!tg.active) continue;
          const dx = p.mesh.position.x - tg.pos.x;
          const dy = p.mesh.position.y - tg.pos.y;
          const dz = p.mesh.position.z - tg.pos.z;
          if (dx * dx + dy * dy + dz * dz < tg.radius * tg.radius) {
            hit = true;
            hitTarget = tg;
            break;
          }
        }
      }

      // world bounds
      if (!hit && (Math.abs(p.mesh.position.x) > bounds || Math.abs(p.mesh.position.z) > bounds)) {
        hit = true;
      }

      // pillars / core
      if (!hit) {
        for (const c of colliders) {
          const cd = c.userData.collide;
          if (!cd || !cd.pos) continue;
          const dx = p.mesh.position.x - cd.pos.x;
          const dz = p.mesh.position.z - cd.pos.z;
          if (dx * dx + dz * dz < cd.r * cd.r && p.mesh.position.y < cd.y) {
            hit = true;
            break;
          }
        }
      }

      if (hit) {
        this.impact(p.mesh.position, p.color, 1.2);
        onHit(p, hitTarget);
        p.active = false;
        p.mesh.visible = false;
      } else if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
      }
    }
  }
}
