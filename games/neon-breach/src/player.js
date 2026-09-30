import * as THREE from 'three';
import { clamp, damp, TAU } from './util.js';
import { resolveStaticCollision, ARENA_HALF } from './arena.js';
import { audio } from './audio.js';

const EYE = 1.62;
const RADIUS = 0.45;
const ACCEL = 62;
const FRICTION = 11;
const MAX_SPEED = 7.4;
const JUMP_V = 5.2;
const GRAVITY = 22;
const DASH_SPEED = 22;
const DASH_TIME = 0.16;
const DASH_COOLDOWN = 1.15;

export class Player {
  constructor(scene, arena, camera) {
    this.scene = scene;
    this.arena = arena;
    this.camera = camera;

    this.pos = new THREE.Vector3(0, EYE, 12);
    this.vel = new THREE.Vector3();
    this.yaw = Math.PI;
    this.pitch = 0;
    this.onGround = true;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDir = new THREE.Vector3();

    this.hp = 100;
    this.maxHp = 100;
    this.alive = true;
    this.invuln = 0;

    // run stats (upgrades mutate these)
    this.damageMul = 1;
    this.fireRateMul = 1;
    this.magSize = 30;
    this.reserveMax = 150;
    this.mag = 30;
    this.reserve = 150;
    this.reloadTime = 1.5;
    this.reloading = false;
    this.reloadT = 0;
    this.shotCd = 0;
    this.critChance = 0.12;
    this.critMul = 2.2;
    this.pierce = 0;
    this.lifesteal = 0;
    this.extraDash = 0;
    this.dashCharges = 1;

    this.shotsFired = 0;
    this.shotsHit = 0;
    this.kills = 0;
    this.headshots = 0;
    this.dashUsed = 0;

    this._buildModel();
    this._syncCamera();
  }

  _buildModel() {
    // The camera must be in the scene graph for the viewmodel (a camera child)
    // to be rendered at all.
    if (!this.camera.parent) this.scene.add(this.camera);

    // A camera-parented light only illuminates the viewmodel subtree, so the
    // gun reads clearly without brightening the whole arena.
    const viewLight = new THREE.PointLight(0xcfe4ff, 6, 4, 1.6);
    viewLight.position.set(0.35, 0.55, 0.25);
    this.camera.add(viewLight);
    const viewFill = new THREE.DirectionalLight(0x9dc4ff, 1.6);
    viewFill.position.set(-0.6, 0.4, 0.5);
    this.camera.add(viewFill);
    this.camera.add(new THREE.AmbientLight(0x6b7d94, 1.4));

    this.group = new THREE.Group();
    this.group.name = 'player';
    this.scene.add(this.group);

    // metalness was 0.72 with no envMap — in three.js a metal surface with no
    // environment to reflect renders *black*, which is why the gun kept reading
    // as a silhouette. Low metalness + a slight emissive is the correct fix here.
    const body = new THREE.MeshStandardMaterial({
      color: 0x3c4c60, roughness: 0.5, metalness: 0.25,
      emissive: 0x101c2b, emissiveIntensity: 1,
    });
    const neon = new THREE.MeshBasicMaterial({ color: 0x35e6ff });
    const neonPink = new THREE.MeshBasicMaterial({ color: 0xff2e88 });

    // torso
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.78, 0.36), body);
    this.torso.position.y = 0.15;
    this.group.add(this.torso);

    // head
    this.head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.3), body);
    this.head.position.y = 0.68;
    this.group.add(this.head);

    // visor
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.03), neon);
    visor.position.set(0, 0.7, -0.16);
    this.group.add(visor);

    // legs
    this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.22), body);
    this.legL.position.set(-0.16, -0.6, 0);
    this.legR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.22), body);
    this.legR.position.set(0.16, -0.6, 0);
    this.group.add(this.legL, this.legR);

    // arms + gun
    const armMat = body;
    this.armR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.44, 0.18), armMat);
    this.armR.position.set(0.3, 0.16, -0.16);
    this.group.add(this.armR);

    // The gun is a *viewmodel*: parented to the camera, not to the world-space
    // body. Parenting it to the body put it at feet level, well below the eye,
    // so the player never saw a weapon.
    //
    // Sizing note: it sits ~0.4m from the eye, so anything above ~0.12m thick
    // eats the screen. Kept small and pushed to the corner deliberately.
    this.gun = new THREE.Group();
    this.gun.position.set(0.19, -0.155, -0.34);
    const scale = 0.62;
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.4), body);
    this.gun.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.4, 8), body);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.34;
    this.gun.add(barrel);
    // muzzle brake
    const brake = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.09), body);
    brake.position.z = -0.53;
    this.gun.add(brake);
    // cooling shroud fins
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.03), body);
      fin.position.set(0, 0.07, -0.2 - i * 0.09);
      this.gun.add(fin);
    }
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.2), body);
    shroud.position.z = -0.22;
    this.gun.add(shroud);
    this.magBox = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.17, 0.1), neonPink);
    this.magBox.position.set(0, -0.14, 0.02);
    this.gun.add(this.magBox);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.09), body);
    grip.position.set(0, -0.12, 0.15);
    grip.rotation.x = 0.28;
    this.gun.add(grip);
    // scope rail + sight
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.3), body);
    rail.position.set(0, 0.085, -0.02);
    this.gun.add(rail);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.04), neon);
    sight.position.set(0, 0.11, -0.14);
    this.gun.add(sight);
    this.glowStrip = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.3), neon);
    this.glowStrip.position.set(0.06, 0.03, -0.14);
    this.gun.add(this.glowStrip);
    // emissive power cell on the side
    const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.14, 6), neonPink);
    cell.rotation.x = Math.PI / 2;
    cell.position.set(0.06, -0.02, 0.02);
    this.gun.add(cell);

    // muzzle anchor: world-space marker at the barrel tip
    this.muzzleAnchor = new THREE.Object3D();
    this.muzzleAnchor.position.set(0, 0, -0.58);
    this.gun.add(this.muzzleAnchor);

    this.gun.scale.setScalar(scale);
    this.gun.renderOrder = 10;
    this.gun.traverse((o) => { o.frustumCulled = false; });
    this.camera.add(this.gun);

    // Gloved hands so the weapon reads as held rather than floating.
    const handMat = new THREE.MeshStandardMaterial({ color: 0x24303f, roughness: 0.75, metalness: 0.2 });
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.13), handMat);
    hand.position.set(0, -0.1, 0.2);
    this.gun.add(hand);
    const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.26), handMat);
    foreArm.position.set(0.03, -0.11, 0.36);
    this.gun.add(foreArm);
    const foreHand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.12), handMat);
    foreHand.position.set(-0.02, -0.08, -0.24);
    this.gun.add(foreHand);

    // ground shadow blob
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 18),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.02;
    this.scene.add(this.blob);
  }

  reset() {
    this.pos.set(0, EYE, 12);
    this.vel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.damageMul = 1;
    this.fireRateMul = 1;
    this.magSize = 30;
    this.mag = 30;
    this.reserveMax = 150;
    this.reserve = 150;
    this.reloadTime = 1.5;
    this.critChance = 0.12;
    this.critMul = 2.2;
    this.pierce = 0;
    this.lifesteal = 0;
    this.dashCharges = 1;
    this.extraDash = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.kills = 0;
    this.headshots = 0;
    this.dashUsed = 0;
    this.hp = this.maxHp = 100;
    this.alive = true;
    this.invuln = 0;
    this.dashCooldown = 0;
    this.dashTimer = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.shotCd = 0;
    this.recoilKick = 0;
    this.recoilRot = 0;
    this.bobAmt = 0;
    this.bobPhase = 0;
    this.group.visible = false;
    this.blob.visible = true;
    this.gun.visible = true;
  }

  look(dYaw, dPitch) {
    this.yaw -= dYaw;
    this.pitch = clamp(this.pitch - dPitch, -1.35, 1.35);
  }

  get eyeY() { return this.pos.y; }

  /**
   * Ray origin for hitscan. This must be the *eye*, not the gun mesh.
   * The viewmodel group is anchored at feet level (pos.y - EYE), so reading the
   * muzzle anchor would shoot from the floor and miss everything. The tracer
   * still starts at the muzzle visually, which is what sells it.
   */
  eyePosition(out) {
    return out.copy(this.pos);
  }

  muzzleWorld(out) {
    // Force an up-to-date world matrix: we shoot before the frame renders, so
    // the cached matrix from last frame would lag the gun position.
    this.group.updateMatrixWorld(true);
    this.muzzleAnchor.getWorldPosition(out);
    return out;
  }

  aimDir(out) {
    return out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();
  }

  update(dt, input, arena) {
    if (!this.alive) {
      this._syncCamera();
      this.blob.position.set(this.pos.x, 0.02, this.pos.z);
      this.blob.scale.setScalar(1);
      return;
    }

    this.invuln = Math.max(this.invuln - dt, 0);
    this.shotCd = Math.max(this.shotCd - dt, 0);
    this.dashCooldown = Math.max(this.dashCooldown - dt, 0);

    // ── look ──
    const look = input.lookDelta(dt);
    this.look(look.yaw, look.pitch);

    // ── move input in yaw space ──
    let ix = 0, iz = 0;
    if (input.down('fwd')) iz -= 1;
    if (input.down('back')) iz += 1;
    if (input.down('left')) ix -= 1;
    if (input.down('right')) ix += 1;
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }

    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    // forward vector is (-sinY, 0, -cosY)
    const fx = -sinY, fz = -cosY;
    const rx = cosY, rz = -sinY;
    const wishX = fx * -iz + rx * ix;
    const wishZ = fz * -iz + rz * ix;

    // ── dash ──
    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      this.vel.x = this.dashDir.x * DASH_SPEED;
      this.vel.z = this.dashDir.z * DASH_SPEED;
    } else {
      if (input.justPressed('dash') && this.dashCharges > 0) {
        this.dashCharges--;
        this.dashUsed++;
        this.dashTimer = DASH_TIME;
        const dx = len > 0 ? wishX : fx;
        const dz = len > 0 ? wishZ : fz;
        const m = Math.hypot(dx, dz) || 1;
        this.dashDir.set(dx / m, 0, dz / m);
        this.vel.x = this.dashDir.x * DASH_SPEED;
        this.vel.z = this.dashDir.z * DASH_SPEED;
        this.invuln = Math.max(this.invuln, DASH_TIME + 0.08);
        audio.dash();
      }

      // accel toward wish velocity
      const targetX = wishX * MAX_SPEED;
      const targetZ = wishZ * MAX_SPEED;
      this.vel.x = damp(this.vel.x, targetX, ACCEL / MAX_SPEED, dt);
      this.vel.z = damp(this.vel.z, targetZ, ACCEL / MAX_SPEED, dt);
      if (len === 0) {
        const f = Math.exp(-FRICTION * dt);
        this.vel.x *= f;
        this.vel.z *= f;
      }
    }

    // ── vertical ──
    if (input.justPressed('jump') && this.onGround) {
      this.vel.y = JUMP_V;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= EYE) {
      this.pos.y = EYE;
      this.vel.y = 0;
      this.onGround = true;
    }

    // ── integrate horizontal + collide ──
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const b = arena.bounds;
    this.pos.x = clamp(this.pos.x, -b, b);
    this.pos.z = clamp(this.pos.z, -b, b);
    resolveStaticCollision(this.pos, RADIUS, arena.colliders);

    // ── dash recharge ──
    if (this.dashCharges < 1 + this.extraDash && this.dashCooldown <= 0) {
      this.dashCharges++;
      this.dashCooldown = DASH_COOLDOWN;
    }

    this._syncCamera(dt);
    this._animate(dt, input);
  }

  _syncCamera(dt = 0) {
    this.camera.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;

    // subtle bob, decays to zero when still
    if (dt > 0) {
      const speed = Math.hypot(this.vel.x, this.vel.z);
      const target = this.onGround ? Math.min(speed / MAX_SPEED, 1) : 0;
      this.bobPhase = (this.bobPhase || 0) + dt * (8 + speed);
      this.bobAmt = damp(this.bobAmt || 0, target, 8, dt);
      this.camera.position.y += Math.sin(this.bobPhase) * 0.045 * this.bobAmt;
      this.camera.rotation.z = Math.cos(this.bobPhase * 0.5) * 0.012 * this.bobAmt;
    }
  }

  _animate(dt, input) {
    // First-person: the world-space body is only a shadow-caster stand-in, so
    // hide it to stop it clipping into the view. The viewmodel rides the camera.
    this.group.visible = false;
    this.group.position.set(this.pos.x, this.pos.y - EYE, this.pos.z);

    // leg swing drives viewmodel sway instead of visible legs
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = this.onGround && speed > 0.4;

    // viewmodel bob + sway
    const bobTarget = moving ? Math.min(speed / MAX_SPEED, 1) : 0;
    this.bobAmt = damp(this.bobAmt || 0, bobTarget, 8, dt);
    this.bobPhase = (this.bobPhase || 0) + dt * (8 + speed);

    // reload animation: dip and roll the gun
    const reloadK = this.reloading ? Math.sin(Math.min(this.reloadT / this.reloadTime, 1) * Math.PI) : 0;

    // recoil kick (transient, set by Game)
    this.recoilKick = damp(this.recoilKick || 0, 0, 14, dt);
    this.recoilRot = damp(this.recoilRot || 0, 0, 12, dt);

    const g = this.gun;
    g.position.set(
      0.19 + Math.cos(this.bobPhase * 0.5) * 0.01 * this.bobAmt,
      -0.155 - Math.abs(Math.sin(this.bobPhase)) * 0.012 * this.bobAmt - reloadK * 0.11,
      -0.34 + this.recoilKick * 0.07,
    );
    g.rotation.set(
      this.recoilRot * 0.35 - reloadK * 0.42,
      Math.sin(this.bobPhase * 0.5) * 0.018 * this.bobAmt,
      reloadK * 0.5,
    );

    // muzzle glow reflects ammo state
    this.magBox.material.color.setHex(this.mag > 0 ? 0xff2e88 : 0x553344);

    // shadow blob
    this.blob.position.set(this.pos.x, 0.02, this.pos.z);
    const h = this.pos.y - EYE;
    this.blob.scale.setScalar(clamp(1 + h * 0.25, 1, 2));
    this.blob.material.opacity = clamp(0.32 - h * 0.08, 0.06, 0.32);
  }

  /** Called by Game after a shot for viewmodel kick. */
  kick(amount = 1) {
    this.recoilKick = (this.recoilKick || 0) + amount;
    this.recoilRot = (this.recoilRot || 0) + amount * 0.5;
  }

  // ── weapon ──

  canShoot() {
    return this.alive && !this.reloading && this.shotCd <= 0 && this.mag > 0;
  }

  shotInterval() {
    return 0.105 / this.fireRateMul;
  }

  startReload() {
    if (this.reloading || this.mag >= this.magSize || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadT = 0;
    audio.reloadClick();
    return true;
  }

  updateWeapon(dt) {
    if (this.reloading) {
      this.reloadT += dt;
      if (this.reloadT >= this.reloadTime) {
        const need = this.magSize - this.mag;
        const take = Math.min(need, this.reserve);
        this.mag += take;
        this.reserve -= take;
        this.reloading = false;
        this.reloadT = 0;
        audio.reloadDone();
      }
    }
    if (this.mag === 0 && !this.reloading && this.reserve > 0) {
      this.startReload();
    }
  }

  consumeShot() {
    this.mag -= 1;
    this.shotsFired += 1;
    this.shotCd = this.shotInterval();
  }

  get accuracy() {
    return this.shotsFired ? this.shotsHit / this.shotsFired : 0;
  }

  // ── damage ──

  hurt(amount) {
    if (!this.alive || this.invuln > 0) return 0;
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    this.invuln = 0.35; // brief i-frames so swarms can't instakill
    if (this.hp <= 0) {
      this.alive = false;
      this.group.visible = false;
      this.blob.visible = false;
      this.gun.visible = false;
    }
    audio.hurt();
    return amount;
  }

  heal(amount) {
    const before = this.hp;
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
    return this.hp - before;
  }

  addKill() { this.kills += 1; }
}
