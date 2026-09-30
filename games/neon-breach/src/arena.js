import * as THREE from 'three';
import { rand, randInt, TAU } from './util.js';

export const ARENA_HALF = 34;   // playfield is ARENA_HALF*2 square, centred on origin
export const WALL_H = 7;
const GRID_STEP = 4;
const PILLAR_R = 1.7;

/**
 * Builds the arena once and reuses it. Light fog + emissive grid gives the
 * neon look; bloom in main.js does the rest.
 */
export function buildArena(scene, renderer) {
  scene.background = new THREE.Color(0x04060b);
  // Fog was tuned before the material pass and crushed everything to black at
  // arena distance. 0.014 keeps depth cueing without eating the neon.
  scene.fog = new THREE.FogExp2(0x070b14, 0.014);

  const group = new THREE.Group();
  group.name = 'arena';
  scene.add(group);

  // ── floor ──
  // Near-black albedo + weak lights renders as pure black under ACES. The floor
  // needs a lighter base plus a faint emissive so the grid always reads.
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x1a2434,
    emissive: 0x0a1622,
    emissiveIntensity: 1,
    roughness: 0.62,
    metalness: 0.35,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    floorMat,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = false;
  group.add(floor);

  // ── grid lines (thin emissive quads, cheaper than a shader) ──
  group.add(buildGridLines(0x35e6ff, 0.5, 0.055));
  group.add(buildGridLines(0x9d6bff, 0.24, 0.09, GRID_STEP * 2));

  // ── boundary walls ──
  group.add(buildWalls());

  // ── cover pillars ──
  const pillars = buildPillars();
  group.add(pillars);

  // ── centre core (visual anchor + landmark) ──
  const core = buildCore();
  group.add(core);

  // ── spawn pads (visual telegraph of enemy entry) ──
  const pads = buildSpawnPads();
  group.add(pads);

  // ── ceiling rig lights ──
  addLights(scene, group, renderer);

  // ── overhead truss ──
  // Without something up there the arena reads as an open void: the fog swallows
  // the wall tops and the player looks into pure black above the horizon.
  group.add(buildOverheadRig());

  // ── ambient dust ──
  const dust = buildDust();
  scene.add(dust);

  return {
    group,
    core,
    pillars: pillars.children,
    // Only meshes flagged `userData.collide` block movement (pillars + core).
    colliders: [...pillars.children, core].filter((o) => o.userData.collide),
    spawnPads: pads.children,
    dust,
    bounds: ARENA_HALF - 0.9,
  };
}

function buildGridLines(color, opacity, thickness, step = GRID_STEP) {
  const geoH = new THREE.PlaneGeometry(ARENA_HALF * 2, thickness);
  const geoV = new THREE.PlaneGeometry(thickness, ARENA_HALF * 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Rotated -PI/2 makes the quad face downward; without DoubleSide the grid
    // is invisible from above, which is the only place the player ever is.
    side: THREE.DoubleSide,
    // The floor sits 0.05 below, which is inside depth-buffer precision at
    // near=0.1/far=300 — without this the grid z-fights and vanishes.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  const g = new THREE.Group();
  for (let i = -ARENA_HALF; i <= ARENA_HALF; i += step) {
    const h = new THREE.Mesh(geoH, mat);
    h.rotation.x = -Math.PI / 2;
    h.position.set(0, 0.05, i);
    const v = new THREE.Mesh(geoV, mat);
    v.rotation.x = -Math.PI / 2;
    v.position.set(i, 0.05, 0);
    g.add(h, v);
  }
  return g;
}

function buildWalls() {
  const g = new THREE.Group();
  const span = ARENA_HALF * 2;

  // solid base slab
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1e2836, roughness: 0.8, metalness: 0.3 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(span, WALL_H, span), baseMat);
  base.position.y = WALL_H / 2;
  g.add(base);

  // glowing inner rim — four thin boxes slightly inside the slab faces
  const rimMat = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.85 });
  const rimGeoLong = new THREE.BoxGeometry(span, 0.16, 0.1);
  const rimGeoShort = new THREE.BoxGeometry(0.1, 0.16, span);
  const y = 0.5;
  for (const s of [-1, 1]) {
    const a = new THREE.Mesh(rimGeoLong, rimMat);
    a.position.set(0, y, s * (ARENA_HALF - 0.05));
    const b = new THREE.Mesh(rimGeoShort, rimMat);
    b.position.set(s * (ARENA_HALF - 0.05), y, 0);
    g.add(a, b);
  }

  // taller pillars at corners for verticality
  const postMat = new THREE.MeshStandardMaterial({ color: 0x27333f, roughness: 0.7, metalness: 0.4 });
  const postGeo = new THREE.BoxGeometry(2.2, WALL_H * 1.35, 2.2);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xff2e88, transparent: true, opacity: 0.9 });
  const capGeo = new THREE.BoxGeometry(2.5, 0.18, 2.5);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx * (ARENA_HALF - 1.2), (WALL_H * 1.35) / 2, sz * (ARENA_HALF - 1.2));
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(post.position.x, WALL_H * 1.35, post.position.z);
      g.add(post, cap);
    }
  }

  // side console blocks, purely decorative depth
  const conMat = new THREE.MeshStandardMaterial({ color: 0x212d3b, roughness: 0.75, metalness: 0.35 });
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    const h = rand(1.2, 3.4);
    const w = rand(1.6, 3.2);
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, rand(1.2, 2.4)), conMat);
    const along = rand(-ARENA_HALF + 5, ARENA_HALF - 5);
    box.position.set(side * (ARENA_HALF - rand(0.7, 1.6)), h / 2, along);
    g.add(box);
  }

  return g;
}

function buildPillars() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2c3a4d, roughness: 0.55, metalness: 0.5 });
  const bandMat = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.9 });

  // Ring layout keeps the centre open and spawn angles fair.
  const spots = [];
  const ringR = 15;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    spots.push([Math.cos(a) * ringR, Math.sin(a) * ringR]);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    spots.push([Math.cos(a) * 25, Math.sin(a) * 25]);
  }

  for (const [x, z] of spots) {
    const jitterX = x + rand(-1.2, 1.2);
    const jitterZ = z + rand(-1.2, 1.2);
    const h = rand(2.4, 4.6);

    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(PILLAR_R, PILLAR_R * 1.15, h, 8), mat);
    pillar.position.set(jitterX, h / 2, jitterZ);
    pillar.userData.collide = { r: PILLAR_R * 1.2, y: h };
    g.add(pillar);

    // glowing band
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(PILLAR_R * 1.03, PILLAR_R * 1.03, 0.13, 8, 1, true),
      bandMat,
    );
    band.position.set(jitterX, h * 0.72, jitterZ);
    g.add(band);

    // Vertical light strips. Pillars were reading as flat unlit silhouettes;
    // these give them an edge that reads at any distance and any angle.
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.75 });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(0.09, h * 0.85),
        stripMat,
      );
      strip.position.set(
        jitterX + Math.cos(a) * PILLAR_R * 1.01,
        h * 0.44,
        jitterZ + Math.sin(a) * PILLAR_R * 1.01,
      );
      strip.lookAt(strip.position.x * 3, strip.position.y, strip.position.z * 3);
      g.add(strip);
    }

    // base plinth
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(PILLAR_R * 1.35, PILLAR_R * 1.45, 0.2, 8),
      mat,
    );
    plinth.position.set(jitterX, 0.1, jitterZ);
    g.add(plinth);
  }

  g.children.forEach((c) => { if (c.userData.collide) c.userData.collide.pos = c.position; });
  return g;
}

function buildCore() {
  const g = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1c2c40, roughness: 0.4, metalness: 0.6,
    emissive: 0x0e3244, emissiveIntensity: 1,
  });

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.9, 0.5, 12), baseMat);
  plinth.position.y = 0.25;
  g.add(plinth);

  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.95, 4.2, 8), baseMat);
  column.position.y = 2.4;
  g.add(column);

  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.95, 1),
    new THREE.MeshStandardMaterial({
      color: 0x1a3d52, emissive: 0x35e6ff, emissiveIntensity: 3.2, roughness: 0.3,
    }),
  );
  orb.position.y = 5.1;
  orb.name = 'coreOrb';
  g.add(orb);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.05, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0x9d6bff, transparent: true, opacity: 0.7 }),
  );
  halo.position.y = 5.1;
  halo.rotation.x = Math.PI / 2.4;
  halo.name = 'coreHalo';
  g.add(halo);

  g.userData.collide = { r: 2.4, y: 5.5 };
  g.position.set(0, 0, 0);
  return g;
}

function buildSpawnPads() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const count = 10;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    const r = ARENA_HALF - 5;
    const pad = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.5, 16), mat.clone());
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(Math.cos(a) * r, 0.03, Math.sin(a) * r);
    pad.userData.base = mat.opacity;
    pad.userData.phase = rand(0, TAU);
    g.add(pad);
  }
  return g;
}

/**
 * Overhead light truss. Fills the empty sky above the arena so the horizon is
 * closed off and vertical scale is readable.
 */
function buildOverheadRig() {
  const g = new THREE.Group();
  const y = 11.5;
  // Brighter than the walls on purpose: these are the closest thing to a
  // ceiling, and at low contrast they read as beams floating in a void.
  const beamMat = new THREE.MeshStandardMaterial({
    color: 0x3b4a5e, roughness: 0.7, metalness: 0.55,
    emissive: 0x0d1a2a, emissiveIntensity: 1,
  });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x35e6ff, transparent: true, opacity: 0.85 });
  const lampMatAlt = new THREE.MeshBasicMaterial({ color: 0x9d6bff, transparent: true, opacity: 0.7 });

  // two crossing truss spines
  for (const rot of [0, Math.PI / 2]) {
    const spine = new THREE.Group();
    spine.rotation.y = rot;
    for (const dy of [0, 0.55]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(ARENA_HALF * 2 - 2, 0.16, 0.22), beamMat);
      beam.position.set(0, y + dy, 0);
      spine.add(beam);
    }
    // cross bracing
    for (let i = -ARENA_HALF + 4; i < ARENA_HALF - 2; i += 4) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), beamMat);
      brace.position.set(i, y + 0.28, 0);
      brace.rotation.z = (i % 8 === 0 ? 1 : -1) * 0.4;
      spine.add(brace);
    }
    g.add(spine);
  }

  // hanging lamp pods
  const podGeo = new THREE.CylinderGeometry(0.42, 0.6, 0.5, 8);
  const rodGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
  for (let i = 0; i < 4; i++) {
    for (const sz of [-1, 1]) {
      const x = (i - 1.5) * 15;
      const z = sz * 15;
      const rod = new THREE.Mesh(rodGeo, beamMat);
      rod.position.set(x, y + 2.1, z);
      const pod = new THREE.Mesh(podGeo, beamMat);
      pod.position.set(x, y + 0.5, z);
      const lamp = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 12),
        (i + (sz > 0 ? 1 : 0)) % 2 ? lampMat : lampMatAlt,
      );
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(x, y + 0.24, z);
      g.add(rod, pod, lamp);
    }
  }

  // Ceiling plane so the sky isn't a hole. Kept dark but not black — pure
  // black made the truss read as floating debris instead of a roof.
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    new THREE.MeshBasicMaterial({ color: 0x0d141f, side: THREE.DoubleSide }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = y + 4;
  g.add(ceiling);

  // ceiling-mounted lights actually cast light, so the top of the walls and
  // the upper half of the pillars are not unlit silhouettes.
  for (let i = 0; i < 4; i++) {
    for (const sz of [-1, 1]) {
      const pl = new THREE.PointLight(
        (i + (sz > 0 ? 1 : 0)) % 2 ? 0x35e6ff : 0x9d6bff, 22, 26, 2,
      );
      pl.position.set((i - 1.5) * 15, y, sz * 15);
      g.add(pl);
    }
  }

  return g;
}

/**
 * Tiny equirect gradient used as the scene environment. Metals reflect this
 * instead of nothing, which is the difference between "readable metal" and
 * "black silhouette". 4x64 is plenty — it is only ever seen as a reflection.
 */
function buildGradientEnv() {
  const w = 4, h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);          // 0 = top, 1 = bottom
    // dark navy overhead → cool blue mid → near-black floor
    const r = Math.round(10 + 26 * (1 - t) + 6 * (1 - Math.abs(0.5 - t) * 2));
    const g = Math.round(16 + 52 * (1 - t) + 10 * (1 - Math.abs(0.5 - t) * 2));
    const b = Math.round(30 + 84 * (1 - t) + 22 * (1 - Math.abs(0.5 - t) * 2));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function addLights(scene, group, renderer) {
  // An environment map is the other half of the fix: metals with nothing to
  // reflect render black. PMREMGenerator needs the renderer, not the scene.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = buildGradientEnv();
  const envRT = pmrem.fromEquirectangular(envTex);
  scene.environment = envRT.texture;
  envTex.dispose();
  pmrem.dispose();

  scene.add(new THREE.AmbientLight(0x3a4f6b, 1.15));

  const hemi = new THREE.HemisphereLight(0x4a6b96, 0x141a24, 1.0);
  scene.add(hemi);

  // key light follows nothing, angled for shape
  const key = new THREE.DirectionalLight(0xbcd8ff, 1.5);
  key.position.set(18, 30, 12);
  scene.add(key);

  // coloured rim from the opposite side
  const rim = new THREE.DirectionalLight(0xff2e88, 0.9);
  rim.position.set(-20, 14, -16);
  scene.add(rim);

  // core point light
  const coreLight = new THREE.PointLight(0x35e6ff, 60, 34, 2);
  coreLight.position.set(0, 5, 0);
  scene.add(coreLight);

  // corner accents
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const pl = new THREE.PointLight(i % 2 ? 0x9d6bff : 0x35e6ff, 30, 40, 2);
    pl.position.set(Math.cos(a) * (ARENA_HALF - 3), 6, Math.sin(a) * (ARENA_HALF - 3));
    scene.add(pl);
  }
}

function buildDust() {
  const n = 420;
  const pos = new Float32Array(n * 3);
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rand(-ARENA_HALF, ARENA_HALF);
    pos[i * 3 + 1] = rand(0.2, 9);
    pos[i * 3 + 2] = rand(-ARENA_HALF, ARENA_HALF);
    speed[i] = rand(0.15, 0.7);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fd8ff, size: 0.07, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.speeds = speed;
  return points;
}

export function updateArena(arena, t, dt) {
  // Core orb bob + halo spin
  const orb = arena.core.getObjectByName('coreOrb');
  const halo = arena.core.getObjectByName('coreHalo');
  if (orb) {
    orb.rotation.y += dt * 0.7;
    orb.rotation.x += dt * 0.35;
    orb.position.y = 5.1 + Math.sin(t * 1.6) * 0.16;
  }
  if (halo) {
    halo.rotation.z += dt * 0.9;
    halo.rotation.y = Math.sin(t * 0.5) * 0.6;
  }

  // Spawn pads pulse
  for (const pad of arena.spawnPads) {
    pad.material.opacity = 0.22 + Math.sin(t * 2.2 + pad.userData.phase) * 0.18;
    pad.rotation.z += dt * 0.6;
  }

  // Dust drift upward, wrap at ceiling
  const p = arena.dust.geometry.attributes.position;
  const speeds = arena.dust.userData.speeds;
  for (let i = 0; i < speeds.length; i++) {
    let y = p.array[i * 3 + 1] + speeds[i] * dt;
    if (y > 9) y = 0.2;
    p.array[i * 3 + 1] = y;
  }
  p.needsUpdate = true;
  arena.dust.rotation.y += dt * 0.012;
}

/** Random point inside the playfield, kept away from the core. */
export function randomPoint(minR = 0) {
  for (let i = 0; i < 24; i++) {
    const x = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
    const z = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
    if (Math.hypot(x, z) < minR) continue;
    if (Math.hypot(x, z) > ARENA_HALF - 2.5) continue;
    return new THREE.Vector3(x, 0, z);
  }
  return new THREE.Vector3(rand(-10, 10), 0, rand(-10, 10));
}

/** Push a circle out of arena pillars + the core. Mutates `pos`. */
export function resolveStaticCollision(pos, radius, pillars) {
  for (const p of pillars) {
    const c = p.userData.collide;
    if (!c || !c.pos) continue;
    const dx = pos.x - c.pos.x;
    const dz = pos.z - c.pos.z;
    const min = c.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 0.0001) {
      const d = Math.sqrt(d2);
      pos.x = c.pos.x + (dx / d) * min;
      pos.z = c.pos.z + (dz / d) * min;
    }
  }
  return pos;
}
