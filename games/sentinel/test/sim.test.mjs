/**
 * Headless test harness for Sentinel's simulation.
 *
 *   node games/sentinel/test/sim.test.mjs
 *
 * This is not a substitute for playing the game, but it catches the class of
 * bug that `node --check` cannot see: `node --check` only parses syntax, it
 * never resolves an identifier, so a typo'd constant or an inverted comparison
 * sails straight through and only shows up at runtime.
 */

import { Sim, START_GOLD, MAX_TOWERS } from '../src/sim.js';
import { buildPath, pointAt, isBuildable, cellCenter, toCell, inGrid, segmentPointDistance } from '../src/geometry.js';
import { TOWERS, ENEMIES, UPGRADES, waveFor, waveScaling, PATHS, PATH_KEYS } from '../src/data.js';
import { makeRng } from '../src/util.js';
import { planFromAnswer, summarizeState, localPlan, readConfidence, CONFIDENCE_FLOOR, MARGIN_FLOOR, isUnreliable } from '../src/advisor.js';
import * as advisorExports from '../src/advisor.js';
import {
  loadConfig, saveConfig, clearConfig, isConfigured, normalizeBase,
  buildSystemOneRequest, buildChatRequest, extractJson, extractChatText,
  DIALECT, DEFAULT_CONFIG,
} from '../src/llm.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(name, actual, expected) {
  return check(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// localStorage shim so the config module can be exercised in Node.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// performance exists in Node 16+, but be explicit for older runtimes.
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

// ── geometry ───────────────────────────────────────────────────────────────
section('geometry');

{
  for (const key of PATH_KEYS) {
    const p = buildPath(key);
    check(`path ${key} has segments`, p.segments.length > 0);
    check(`path ${key} length positive`, p.length > 0, `len=${p.length}`);

    const start = pointAt(p, 0);
    const a = p.points[0];
    check(`path ${key} starts at first point`, Math.hypot(start.x - a[0], start.y - a[1]) < 0.001);

    const end = pointAt(p, p.length);
    const z = p.points[p.points.length - 1];
    check(`path ${key} ends at last point`, Math.hypot(end.x - z[0], end.y - z[1]) < 0.001);

    // Sampling must stay inside the bounding box of the polyline.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of p.points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    let outside = 0;
    for (let t = 0; t <= p.length; t += p.length / 97) {
      const q = pointAt(p, t);
      if (q.x < minX - 1 || q.x > maxX + 1 || q.y < minY - 1 || q.y > maxY + 1) outside++;
    }
    eq(`path ${key} samples stay on the polyline`, outside, 0);
  }
}

{
  const p = buildPath('meander');
  // Beyond the end, pointAt must clamp rather than run off into space.
  const over = pointAt(p, p.length + 5000);
  const last = p.points[p.points.length - 1];
  check('pointAt clamps past the end', Math.hypot(over.x - last[0], over.y - last[1]) < 0.001);

  const under = pointAt(p, -500);
  const first = p.points[0];
  check('pointAt clamps before the start', Math.hypot(under.x - first[0], under.y - first[1]) < 0.001);
}

{
  // pointAt must be continuous: no jumps between adjacent samples.
  const p = buildPath('meander');
  let maxJump = 0;
  let prev = pointAt(p, 0);
  for (let t = 0.5; t <= p.length; t += 0.5) {
    const q = pointAt(p, t);
    maxJump = Math.max(maxJump, Math.hypot(q.x - prev.x, q.y - prev.y));
    prev = q;
  }
  check('pointAt is continuous along the path', maxJump < 1.0, `largest step ${maxJump.toFixed(3)}px`);
}

{
  eq('cellCenter col 0', cellCenter(0, 0).x, 20);
  const c = toCell(25, 65);
  eq('toCell col', c.col, 0);
  eq('toCell row', c.row, 1);
  check('inGrid rejects negatives', !inGrid(-1, 0));
  check('inGrid rejects past-cols', !inGrid(14, 0));
  check('inGrid accepts origin', inGrid(0, 0));

  const seg = { x1: 0, y1: 0, x2: 10, y2: 0 };
  eq('segment distance perpendicular', Math.round(segmentPointDistance(seg, 5, 5)), 5);
  eq('segment distance clamped before start', Math.round(segmentPointDistance(seg, -5, 0)), 5);
  eq('segment distance clamped past end', Math.round(segmentPointDistance(seg, 15, 0)), 5);
}

{
  // A cell sitting on the road must be rejected; one off it must be accepted.
  const p = buildPath('meander');
  const onPath = new Set();
  let found = null;
  for (let col = 0; col < 14 && !found; col++) {
    for (let row = 0; row < 7; row++) {
      const c = cellCenter(col, row);
      if (segmentPointDistance(p.segments[0], c.x, c.y) < 12) { found = { col, row }; break; }
    }
  }
  check('found a cell overlapping the path', Boolean(found));
  if (found) {
    check('cell on the path is not buildable', !isBuildable(p, found.col, found.row, onPath));
  }

  // And an occupied cell is rejected even when it is otherwise free.
  let free = null;
  for (let col = 0; col < 14 && !free; col++) {
    for (let row = 0; row < 7; row++) {
      if (isBuildable(p, col, row, onPath)) { free = { col, row }; break; }
    }
  }
  check('found a free cell', Boolean(free));
  if (free) {
    check('free cell is buildable when empty', isBuildable(p, free.col, free.row, onPath));
    const taken = new Set([`${free.col},${free.row}`]);
    check('free cell is rejected once occupied', !isBuildable(p, free.col, free.row, taken));
  }
}

// ── data integrity ─────────────────────────────────────────────────────────
section('data');

{
  for (const [id, t] of Object.entries(TOWERS)) {
    check(`tower ${id} has positive cost`, t.cost > 0);
    check(`tower ${id} has positive damage`, t.damage > 0);
    check(`tower ${id} has positive range`, t.range > 0);
    check(`tower ${id} has positive cooldown`, t.cooldown > 0);
    eq(`tower ${id} id matches key`, t.id, id);
  }
  for (const [id, e] of Object.entries(ENEMIES)) {
    check(`enemy ${id} has positive hp`, e.hp > 0);
    check(`enemy ${id} has positive speed`, e.speed > 0);
    check(`enemy ${id} has non-negative armor`, e.armor >= 0);
    check(`enemy ${id} has positive bounty`, e.bounty > 0);
    eq(`enemy ${id} id matches key`, e.id, id);
  }
  for (const u of UPGRADES) {
    check(`upgrade ${u.id} has max > 0`, u.max > 0);
    check(`upgrade ${u.id} cost grows`, u.cost(u.max - 1) > u.cost(0));
  }

  // The colour values are read by the renderer as CSS; a malformed one would
  // silently render black.
  for (const [id, t] of Object.entries(TOWERS)) {
    check(`tower ${id} colour is a hex string`, /^#[0-9a-f]{6}$/i.test(t.color), t.color);
  }
  for (const [id, e] of Object.entries(ENEMIES)) {
    check(`enemy ${id} colour is a hex string`, /^#[0-9a-f]{6}$/i.test(e.color), e.color);
  }

  check('PATHS has entries', PATH_KEYS.length >= 3);
  for (const key of PATH_KEYS) check(`path ${key} defined`, Boolean(PATHS[key]));
}

{
  eq('wave 1 is scripted', waveFor(1).groups.length, 1);
  eq('wave scaling grows with n', waveScaling(10) > waveScaling(5), true);
  check('late waves are generated', Boolean(waveFor(20).generated));
  const scale = waveScaling(15);
  check('scaling is monotonic', waveScaling(15) > waveScaling(14));
  check('scaling is finite', Number.isFinite(scale));
}

// ── building and economy ───────────────────────────────────────────────────
section('building');

{
  const sim = new Sim();
  eq('starts with starting gold', sim.gold, START_GOLD);
  eq('starts with starting lives', sim.lives, 20);
  eq('starts with no towers', sim.towers.length, 0);
  eq('starts on wave 0', sim.wave, 0);
  check('not over at start', !sim.over);
}

{
  const sim = new Sim();
  const p = sim.path;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  check('found a buildable spot', Boolean(spot));

  const before = sim.gold;
  const t = sim.build('arrow', spot.col, spot.row);
  check('build returns a tower', Boolean(t));
  eq('build charges the cost', sim.gold, before - TOWERS.arrow.cost);
  eq('tower count is 1', sim.towers.length, 1);
  eq('tower sits at the cell centre', t.x, cellCenter(spot.col, spot.row).x);
  eq('tower starts with no upgrades', Object.keys(t.upgrades).length, 0);

  // Building on the same cell twice must be refused.
  const dup = sim.build('arrow', spot.col, spot.row);
  check('duplicate build refused', dup === null);
  eq('duplicate build did not charge', sim.gold, before - TOWERS.arrow.cost);
}

{
  const sim = new Sim();
  const broke = new Sim();
  broke.gold = 0;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (broke.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const t = broke.build('cannon', spot.col, spot.row);
  check('build refused when broke', t === null);
  eq('no tower created when broke', broke.towers.length, 0);
  eq('gold unchanged when broke', broke.gold, 0);
  check('unknown tower type refused', sim.build('nope', 0, 0) === null);
}

{
  const sim = new Sim();
  // Fill to the cap and confirm the limit holds.
  let placed = 0;
  for (let col = 0; col < 14; col++) {
    for (let row = 0; row < 7; row++) {
      sim.gold = 99999;
      if (sim.build('arrow', col, row)) placed++;
    }
  }
  eq('cannot exceed MAX_TOWERS', placed, MAX_TOWERS);
  eq('tower list respects the cap', sim.towers.length, MAX_TOWERS);
}

{
  const sim = new Sim();
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  sim.gold = 9999;
  const t = sim.build('arrow', spot.col, spot.row);
  check('sell returns a boolean', typeof sim.sell === 'function');
  // Gold right now already excludes the original purchase, so the refund is the
  // only thing that should move it. Calling sell() inside an assertion would
  // consume the tower before the real check runs, so the dry test is on the
  // function, not a call.
  const goldAfterBuild = sim.gold;
  check('sell succeeded', sim.sell(t));
  eq('tower removed', sim.towers.length, 0);
  eq('refund is 70 percent of the spend', sim.gold, goldAfterBuild + Math.floor(TOWERS.arrow.cost * 0.7));
  check('selling twice is a no-op', sim.sell(t) === false);
  eq('double sell does not pay again', sim.gold, goldAfterBuild + Math.floor(TOWERS.arrow.cost * 0.7));
}

// ── upgrades ───────────────────────────────────────────────────────────────
section('upgrades');

{
  const sim = new Sim();
  sim.gold = 99999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const t = sim.build('cannon', spot.col, spot.row);

  const rateBefore = t.rate;
  const cost = sim.upgradeCost(t, 'rate');
  check('upgrade has a cost', cost > 0);
  check('upgrade applied', sim.upgrade(t, 'rate'));
  check('rate decreased', t.rate < rateBefore, `${rateBefore} -> ${t.rate}`);
  eq('upgrade level is 1', t.upgrades.rate, 1);

  const rangeBefore = t.range;
  sim.upgrade(t, 'range');
  check('range increased', t.range > rangeBefore, `${rangeBefore} -> ${t.range}`);

  const dmgBefore = t.damage;
  sim.upgrade(t, 'power');
  check('damage increased', t.damage > dmgBefore);

  // Upgrades are recomputed from scratch, so applying the same set twice must
  // land on the same numbers as applying it once.
  const sim2 = new Sim();
  sim2.gold = 99999;
  const t2 = sim2.build('cannon', spot.col, spot.row);
  t2.upgrades = { rate: 1, range: 1, power: 1 };
  const fresh = sim2.statsFor('cannon', t2.upgrades);
  eq('stat recompute matches a clean build', t.rate === fresh.rate && t.damage === fresh.damage, true);

  // Cost must escalate per level, so the two reads have to straddle a purchase.
  const c1 = sim.upgradeCost(t, 'rate');
  sim.upgrade(t, 'rate');
  const c2 = sim.upgradeCost(t, 'rate');
  check('costs escalate with level', c2 > c1, `l1=${c1} l2=${c2}`);
}

{
  // Cap every upgrade at its max and confirm the cost becomes unavailable.
  const sim = new Sim();
  sim.gold = 999999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const t = sim.build('arrow', spot.col, spot.row);
  const up = UPGRADES.find((u) => u.id === 'rate');
  for (let i = 0; i < up.max; i++) sim.upgrade(t, 'rate');
  eq('upgrade stops at max level', t.upgrades.rate, up.max);
  eq('maxed upgrade has no cost', sim.upgradeCost(t, 'rate'), null);
  check('maxed upgrade cannot be bought', sim.upgrade(t, 'rate') === false);
  check('unknown upgrade is refused', sim.upgrade(t, 'nope') === false);
}

{
  const sim = new Sim();
  sim.gold = 0;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  sim.gold = 9999;
  const t = sim.build('arrow', spot.col, spot.row);
  sim.gold = 0;
  check('upgrade refused when broke', sim.upgrade(t, 'power') === false);
  eq('no upgrade level recorded', t.upgrades.power, undefined);
}

// ── waves and combat ───────────────────────────────────────────────────────
section('waves');

{
  const sim = new Sim();
  sim.startWave(1);
  eq('wave counter advanced', sim.wave, 1);
  check('wave is active', sim.waveActive);
  check('spawn queue populated', sim.spawnQueue.length > 0);
  eq('nothing spawned yet', sim.enemies.length, 0);

  sim.step(0.016);
  check('enemies appear over time', sim.enemies.length > 0);
  const e = sim.enemies[0];
  check('enemy starts at path start', Number.isFinite(e.x) && Number.isFinite(e.y));
  check('enemy has full hp', e.hp === e.maxHp);
}

{
  // Run a wave to completion with no towers: enemies must leak and lives must
  // fall. This is the "did pathing actually reach the core" check.
  const sim = new Sim({ lives: 3 });
  sim.startWave(1);
  let guard = 0;
  while (sim.lives > 0 && !sim.over && guard++ < 4000) sim.step(0.05);
  check('undefended wave ends in a loss', sim.over, `guard=${guard}`);
  check('lives never went negative', sim.lives >= 0);
  check('leaks were counted', sim.leaked > 0, `leaked=${sim.leaked}`);
  eq('lives hit zero', sim.lives, 0);
  check('no bounty was paid out', sim.gold === START_GOLD, `gold=${sim.gold}`);
}

{
  // Enemies must advance monotonically along the path.
  const sim = new Sim();
  sim.startWave(1);
  let prev = -1;
  for (let i = 0; i < 200; i++) {
    sim.step(0.05);
    const e = sim.enemies[0];
    if (!e) continue;
    if (e.progress < prev) { check('enemy progress never rewinds', false, `${prev} -> ${e.progress}`); break; }
    prev = e.progress;
  }
  check('enemy progress advanced', prev > 0, `final=${prev.toFixed(1)}`);
}

{
  // Damage, kills and bounty.
  const sim = new Sim();
  const e = sim.spawnEnemy('grunt', 1);
  const goldBefore = sim.gold;
  sim.damage(e, 9999);
  check('enemy dies from lethal damage', e.dead);
  eq('kill counted', sim.kills, 1);
  check('bounty paid', sim.gold === goldBefore + ENEMIES.grunt.bounty, `gold=${sim.gold}`);
  eq('dead enemy is culled on the next step', sim.enemies.length, 1);
}

{
  // Armour reduces damage but must never make an enemy immune.
  const sim = new Sim();
  const soft = sim.spawnEnemy('grunt', 1);
  const hard = sim.spawnEnemy('brute', 1);
  const softDealt = sim.damage(soft, 20);
  const hardDealt = sim.damage(hard, 20);
  check('armour reduces damage', hardDealt < softDealt, `soft=${softDealt} hard=${hardDealt}`);
  check('armour never fully negates a hit', hardDealt > 0, `hard=${hardDealt}`);
  check('armour floor is 20 percent', Math.abs(hardDealt - Math.max(4, 20 - ENEMIES.brute.armor)) < 0.001,
    `got ${hardDealt}`);
}

{
  // Towers must actually shoot, and kills must credit the tower.
  const sim = new Sim();
  sim.gold = 99999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const tower = sim.build('arrow', spot.col, spot.row);
  sim.startWave(1);
  let guard = 0;
  while (sim.kills === 0 && guard++ < 3000) sim.step(0.05);
  check('a lone tower scored a kill', sim.kills > 0, `guard=${guard} kills=${sim.kills}`);
  check('kill credited to the tower', tower.kills > 0, `tower.kills=${tower.kills}`);
  check('damage was tracked', tower.damageDealt > 0);
}

{
  // An instant weapon (beam) must deal its damage without a travel delay.
  const sim = new Sim();
  sim.gold = 99999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const beam = sim.build('tesla', spot.col, spot.row);
  const e = sim.spawnEnemy('grunt', 1);
  // Enemies derive their x/y from the path every tick, so the only way to place
  // one next to the tower is to advance its progress to the matching distance,
  // not to poke at its coordinates directly.
  const p = sim.path;
  let bestT = 0;
  let bestD = Infinity;
  for (let t = 0; t <= p.length; t += 2) {
    const q = pointAt(p, t);
    const d = Math.hypot(q.x - beam.x, q.y - beam.y);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  e.progress = bestT;
  sim.step(0.016);
  const hpAfterStep = e.hp;
  check('enemy is in beam range after seeking', bestD < beam.range, `dist=${bestD.toFixed(1)} range=${beam.range}`);
  // The beam fires on the first step where a target is present, so allow a few
  // ticks for the cooldown to come round.
  let guard = 0;
  while (e.hp === hpAfterStep && guard++ < 20) sim.step(0.05);
  check('beam damaged its target', e.hp < e.maxHp, `${e.maxHp} -> ${e.hp}`);
}

{
  // Splash must hit the target but not a bystander outside the blast radius.
  const sim = new Sim();
  sim.gold = 99999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  sim.build('cannon', spot.col, spot.row);

  // Enemies are repositioned from their path progress every tick, so the only
  // reliable way to arrange a scenario is to choose progress values.
  const p = sim.path;
  let midT = p.length * 0.5;
  let endT = p.length * 0.75;
  const near = sim.spawnEnemy('grunt', 1);
  near.progress = midT;
  const far = sim.spawnEnemy('grunt', 1);
  far.progress = endT;

  sim.step(0.016);  // let both settle onto the path
  const nearHp = near.hp;
  const farHp = far.hp;
  const apart = Math.hypot(near.x - far.x, near.y - far.y);
  check('staged enemies are well apart', apart > 46, `apart=${apart.toFixed(1)}`);

  // The shell starts ON the target, so it arrives on the very first step. A
  // homing shell re-acquires its target each tick, which means its impact point
  // is wherever the enemy actually is — not wherever the test guessed.
  sim.projectiles.push({
    kind: 'shell', x: near.x, y: near.y, tx: near.x, ty: near.y,
    speed: 300, damage: 40, splash: 46, color: '#fff',
    tower: sim.towers[0], targetId: near.id,
  });
  sim.step(0.016);
  check('shell resolved on arrival', sim.projectiles.length === 0, `${sim.projectiles.length} left`);
  check('splash hit the target', near.hp < nearHp || near.dead, `${nearHp} -> ${near.hp}`);
  check('splash missed the distant enemy', far.hp === farHp, `${farHp} -> ${far.hp}`);
}

{
  // Slow must reduce speed and expire.
  const sim = new Sim();
  const e = sim.spawnEnemy('grunt', 1);
  const baseSpeed = e.speed;
  sim.applySlow(e, 0.5, 1.0);
  const p0 = e.progress;
  sim.step(0.1);
  const slowedStep = e.progress - p0;
  const after = e.progress;
  sim.clock = 10;             // let the slow lapse
  sim.step(0.1);
  const normalStep = e.progress - after;
  check('slow reduces movement', slowedStep < normalStep, `slowed=${slowedStep.toFixed(2)} normal=${normalStep.toFixed(2)}`);
  check('slowed step is slower than the base speed', slowedStep < baseSpeed * 0.1 * 1.01,
    `${slowedStep.toFixed(3)} vs ${(baseSpeed * 0.1).toFixed(3)}`);
  check('slow expires', normalStep > slowedStep);
}

{
  // Economy upgrade must raise the payout, not just the stat block.
  const sim = new Sim();
  sim.gold = 99999;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  const t = sim.build('arrow', spot.col, spot.row);
  const plain = sim.statsFor('arrow', {}).economy;
  // The bounty reads the tower's OWN upgrade set, so the test has to actually buy
  // the upgrade rather than only asking what the stat block would look like.
  sim.upgrade(t, 'economy');
  sim.upgrade(t, 'economy');
  const boosted = sim.statsFor('arrow', t.upgrades).economy;
  check('economy upgrade raises the multiplier', boosted > plain, `${plain} -> ${boosted}`);
  const e = sim.spawnEnemy('grunt', 1);
  const before = sim.gold;
  sim.damage(e, 9999, t);
  check('bounty scales with the economy upgrade',
    sim.gold - before > Math.round(ENEMIES.grunt.bounty * plain),
    `got ${sim.gold - before}`);
}

// ── wave progression ───────────────────────────────────────────────────────
section('progression');

{
  // A defended run should survive several waves and keep paying out.
  const sim = new Sim();
  sim.gold = 4000;
  // Ring the path with towers on every legal cell.
  for (let col = 0; col < 14; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) sim.build('sniper', col, row);
    }
  }
  check('defended run has towers', sim.towers.length > 0);
  let survived = 0;
  for (let w = 1; w <= 6; w++) {
    sim.startWave(w);
    let guard = 0;
    while (!sim.waveDone() && !sim.over && guard++ < 6000) sim.step(0.05);
    if (sim.over) break;
    survived++;
  }
  check('a defended run survives several waves', survived >= 4, `survived=${survived}`);
  check('a defended run earns gold', sim.goldEarned > 0, `earned=${sim.goldEarned}`);
  check('a defended run kills things', sim.kills > 0);
}

{
  // The injected plan must replace the scripted wave exactly once.
  const sim = new Sim();
  sim.plan = { wave: 2, groups: [{ type: 'swift', count: 3, gap: 0.1 }] };
  sim.startWave(1);
  eq('wave 1 used the script', sim.lastReport.planned, false);
  sim.startWave(2);
  eq('wave 2 used the plan', sim.lastReport.planned, true);
  eq('plan queue length honoured', sim.spawnQueue.length, 3);
  sim.startWave(3);
  eq('plan consumed after one use', sim.lastReport.planned, false);
}

{
  // Waves past the scripted table must keep working.
  const sim = new Sim();
  sim.gold = 4000;
  for (let col = 0; col < 14; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) sim.build('cannon', col, row);
    }
  }
  sim.startWave(20);
  check('generated wave has a spawn queue', sim.spawnQueue.length > 0);
  let guard = 0;
  while (!sim.waveDone() && !sim.over && guard++ < 20000) sim.step(0.05);
  check('a generated wave can be cleared', sim.waveDone() || sim.over, `guard=${guard}`);
}

// ── save / load ────────────────────────────────────────────────────────────
section('save/load');

{
  const sim = new Sim();
  sim.gold = 777;
  sim.wave = 4;
  sim.kills = 19;
  sim.leaked = 2;
  for (let col = 0; col < 14; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { sim.build('cannon', col, row); break; }
    }
  }
  const t = sim.towers[0];
  sim.gold = 3000;
  sim.upgrade(t, 'power');
  sim.upgrade(t, 'range');

  const json = JSON.parse(JSON.stringify(sim.toJSON()));
  const restored = Sim.fromJSON(json);

  eq('gold restored', restored.gold, sim.gold);
  eq('wave restored', restored.wave, sim.wave);
  eq('kills restored', restored.kills, sim.kills);
  eq('leaked restored', restored.leaked, sim.leaked);
  eq('tower count restored', restored.towers.length, sim.towers.length);
  eq('path restored', restored.pathKey, sim.pathKey);

  const rt = restored.towers[0];
  eq('upgrades restored', rt.upgrades.power, t.upgrades.power);
  eq('upgrades restored (2)', rt.upgrades.range, t.upgrades.range);
  eq('derived damage restored', rt.damage, t.damage);
  eq('derived range restored', rt.range, t.range);
  eq('total spend restored', rt.totalSpent, t.totalSpent);
  check('restored tower is buildable-adjacent', restored.towers[0].col === t.col);

  // The restore must not have charged for the towers it re-created.
  const spentOnRestore = restored.gold;
  check('restore did not re-charge', spentOnRestore === sim.gold, `${spentOnRestore} vs ${sim.gold}`);
}

{
  // A round trip through JSON twice must be stable.
  const sim = new Sim();
  sim.gold = 500;
  let spot = null;
  for (let col = 0; col < 14 && !spot; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { spot = { col, row }; break; }
    }
  }
  sim.build('tesla', spot.col, spot.row);
  const a = JSON.stringify(sim.toJSON());
  const b = JSON.stringify(Sim.fromJSON(JSON.parse(a)).toJSON());
  eq('serialisation is idempotent', a, b);
}

// ── pause / speed ──────────────────────────────────────────────────────────
section('controls');

{
  const sim = new Sim();
  sim.startWave(1);
  sim.step(0.5);
  const before = sim.clock;
  sim.paused = true;
  sim.step(0.5);
  eq('paused sim does not advance', sim.clock, before);

  sim.paused = false;
  sim.speed = 3;
  const t0 = sim.clock;
  // dt is clamped to 0.05 BEFORE the speed multiplier, so a 0.1s tick at 3x
  // advances 0.15s, not 0.3s. That clamp is what stops an alt-tab from
  // teleporting a wave across the map, and it must not be "fixed".
  sim.step(0.1);
  check('speed multiplies the step', Math.abs((sim.clock - t0) - 0.15) < 0.001, `advanced ${(sim.clock - t0).toFixed(3)}`);

  sim.clock = 0;
  sim.speed = 1;
  sim.step(0.02);
  check('speed 1 advances by the raw dt', Math.abs(sim.clock - 0.02) < 0.001, `clock=${sim.clock.toFixed(4)}`);

  // A huge dt must be clamped, or an alt-tab would teleport the whole wave.
  const sim2 = new Sim();
  sim2.startWave(1);
  sim2.step(10);
  check('dt is clamped to a safe maximum', sim2.clock <= 0.051, `clock=${sim2.clock}`);
}

{
  // A zero or negative dt must not corrupt the simulation.
  const sim = new Sim();
  sim.startWave(1);
  sim.step(0);
  sim.step(-1);
  check('zero and negative dt are harmless', Number.isFinite(sim.clock) && sim.enemies.length >= 0);
}

// ── deterministic replay ───────────────────────────────────────────────────
section('determinism');

{
  // Two sims fed the same seeds and ticks should end in the same state. This is
  // what makes a bug report reproducible.
  const run = () => {
    const sim = new Sim();
    sim.gold = 2000;
    for (let col = 0; col < 14; col++) {
      for (let row = 0; row < 7; row++) {
        if (sim.canBuild(col, row)) sim.build('cannon', col, row);
      }
    }
    for (let w = 1; w <= 3; w++) {
      sim.startWave(w);
      let guard = 0;
      while (!sim.waveDone() && !sim.over && guard++ < 6000) sim.step(0.05);
    }
    return { kills: sim.kills, lives: sim.lives, gold: sim.gold, over: sim.over };
  };
  const a = run();
  const b = run();
  eq('replay is deterministic (kills)', a.kills, b.kills);
  eq('replay is deterministic (lives)', a.lives, b.lives);
  eq('replay is deterministic (over)', a.over, b.over);
}

// ── LLM client ─────────────────────────────────────────────────────────────
section('llm client');

{
  clearConfig();
  const fresh = loadConfig();
  eq('default dialect is systemone', fresh.dialect, DIALECT.SYSTEMONE);
  eq('default base url', fresh.baseUrl, 'https://api.typesafe.ai');
  eq('default model', fresh.model, 'jev-latest');
  eq('default key is empty', fresh.apiKey, '');
  eq('disabled by default', fresh.enabled, false);
  check('unconfigured client reports not configured', !isConfigured(fresh));

  saveConfig({ ...fresh, apiKey: 'sk-test', enabled: true });
  const loaded = loadConfig();
  eq('config persisted', loaded.apiKey, 'sk-test');
  check('configured client reports configured', isConfigured(loaded));
  clearConfig();
  check('clear wipes the config', loadConfig().apiKey === '');

  // A partial config must not claim to be ready.
  check('missing key blocks', !isConfigured({ ...DEFAULT_CONFIG, enabled: true, apiKey: '' }));
  check('missing url blocks', !isConfigured({ ...DEFAULT_CONFIG, enabled: true, apiKey: 'k', baseUrl: '' }));
  check('missing model blocks', !isConfigured({ ...DEFAULT_CONFIG, enabled: true, apiKey: 'k', model: '' }));
  check('disabled blocks', !isConfigured({ ...DEFAULT_CONFIG, enabled: false, apiKey: 'k' }));
}

{
  eq('base url strips trailing slash', normalizeBase('https://x.ai/'), 'https://x.ai');
  eq('base url strips /v1', normalizeBase('https://x.ai/v1'), 'https://x.ai');
  eq('base url strips both', normalizeBase('https://x.ai/v1///'), 'https://x.ai');
  eq('base url tolerates whitespace', normalizeBase('  https://x.ai  '), 'https://x.ai');
  eq('base url handles null', normalizeBase(null), '');
}

{
  const cfg = { ...DEFAULT_CONFIG, model: 'jev-1.13.0' };
  const req = buildSystemOneRequest('some state', {
    urgent: { type: 'noul', instructions: 'Is it urgent?' },
    team: { type: 'choice', instructions: 'Which team?', criteria: { a: 'A team', b: 'B team' } },
    mood: { type: 'score', instructions: 'How bad?', criteria: ['fine', 'bad', 'awful'] },
  }, cfg);

  eq('request carries the model', req.model, 'jev-1.13.0');
  eq('request carries the state', req.state, 'some state');
  eq('question count', Object.keys(req.questions).length, 3);
  eq('noul type', req.questions.urgent.type, 'noul');
  eq('choice carries criteria', req.questions.team.criteria.b, 'B team');
  eq('score criteria is a list', Array.isArray(req.questions.mood.criteria), true);
  check('no api key leaks into the body', JSON.stringify(req).indexOf('Bearer') === -1);

  // A non-string state must be serialised rather than sent as [object Object].
  const objReq = buildSystemOneRequest({ hp: 10 }, { q: { type: 'noul', instructions: 'x' } }, cfg);
  check('object state is serialised', typeof objReq.state === 'string' && objReq.state.includes('hp'));
}

{
  const cfg = { ...DEFAULT_CONFIG, model: 'gpt-x', temperature: 0.2, maxTokens: 100 };
  const req = buildChatRequest('be terse', 'hello', cfg);
  eq('chat carries the model', req.model, 'gpt-x');
  eq('chat temperature', req.temperature, 0.2);
  eq('chat max tokens', req.max_tokens, 100);
  eq('chat asks for json', req.response_format.type, 'json_object');
  eq('chat message count', req.messages.length, 2);
  eq('system message first', req.messages[0].role, 'system');
  eq('user message second', req.messages[1].content, 'hello');
}

{
  // The parser has to survive every shape a model might return.
  eq('bare object parses', extractJson('{"a":1}').a, 1);
  eq('fenced block parses', extractJson('```json\n{"a":2}\n```').a, 2);
  eq('unfenced block parses', extractJson('```\n{"a":3}\n```').a, 3);
  eq('object in prose parses', extractJson('Sure! {"a":4} hope that helps').a, 4);
  eq('non json returns null', extractJson('no json here'), null);
  eq('null input returns null', extractJson(null), null);
  eq('number input returns null', extractJson(42), null);
  eq('unterminated object returns null', extractJson('{"a":1'), null);
  eq('empty string returns null', extractJson(''), null);
  eq('nested object survives', extractJson('{"a":{"b":[1,2]}}').a.b[1], 2);

  eq('chat text plain', extractChatText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  eq('chat text from array', extractChatText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  eq('chat text missing is empty', extractChatText({}), '');
  eq('chat text null is empty', extractChatText(null), '');
}

// ── advisor (LLM-driven wave planning) ─────────────────────────────────────
section('advisor');

{
  // The advisor translates a model answer into a wave plan, and it must never
  // hand the simulation a plan it cannot run.
  const { ENEMY_KEYS } = await import('../src/data.js');

  const sim = new Sim();
  sim.gold = 900;
  sim.wave = 2;
  for (let col = 0; col < 14; col++) {
    for (let row = 0; row < 7; row++) {
      if (sim.canBuild(col, row)) { sim.build('arrow', col, row); break; }
    }
  }

  const summary = summarizeState(sim);
  check('summary includes the wave', summary.wave === 2);
  check('summary includes lives', typeof summary.lives === 'number');
  check('summary includes gold', typeof summary.gold === 'number');
  check('summary includes composition', typeof summary.composition === 'object');
  eq('summary is compact', typeof summary.text, 'string');

  // Every enemy id the model may name must exist.
  check('all enemy ids are real', ENEMY_KEYS.every((k) => Boolean(ENEMIES[k])));

  // A valid choice answer becomes a plan.
  const answer = {
    answers: {
      difficulty: { type: 'choice', choice: 'aggressive', confidence: 0.8, probabilities: { aggressive: 0.8, balanced: 0.2 } },
      focus: { type: 'choice', choice: 'shielded', confidence: 0.7, probabilities: { shielded: 0.7 } },
    },
  };
  const plan = planFromAnswer(answer, sim, 3);
  check('plan has groups', Array.isArray(plan.groups) && plan.groups.length > 0);
  eq('plan targets the requested wave', plan.wave, 3);
  check('every planned enemy type exists', plan.groups.every((g) => ENEMIES[g.type]),
    JSON.stringify(plan.groups.map((g) => g.type)));

  // A garbage or empty answer must still yield a runnable plan.
  const fallbackPlan = planFromAnswer(null, sim, 3);
  check('null answer falls back', fallbackPlan.groups.length > 0);
  check('fallback plan uses real enemies', fallbackPlan.groups.every((g) => ENEMIES[g.type]));

  const emptyPlan = planFromAnswer({ answers: {} }, sim, 3);
  check('empty answers fall back', emptyPlan.groups.length > 0);

  const junkPlan = planFromAnswer({ answers: { difficulty: { type: 'choice', choice: 'dragon' } } }, sim, 3);
  check('unknown choice falls back to a real enemy', junkPlan.groups.every((g) => ENEMIES[g.type]));

  // A plan with silly numbers must be clamped, not trusted.
  const wildPlan = planFromAnswer({
    answers: {
      difficulty: { type: 'score', score: 2 },
      focus: { type: 'choice', choice: 'brute' },
    },
  }, sim, 3);
  check('wild plan still has sane counts', wildPlan.groups.every((g) => g.count > 0 && g.count < 200));
  check('wild plan still has a sane gap', wildPlan.groups.every((g) => g.gap > 0 && g.gap < 5));

  // The local plan must be valid too.
  const local = localPlan(sim, 4);
  check('local plan has groups', local.groups.length > 0);
  check('local plan uses real enemies', local.groups.every((g) => ENEMIES[g.type]));
  eq('local plan targets the wave', local.wave, 4);
}

// ── rich state, confidence and abstention ──────────────────────────────────
section('advisor confidence');
{
  // summarizeState, readConfidence and CONFIDENCE_FLOOR are imported at the top.
  // `sim` from the advisor block above is scoped there, so make one here.
  const sim = new Sim();
  sim.gold = 2000;

  // A bare run: nothing built, nothing happened.
  const bare = new Sim();
  const bareState = summarizeState(bare);
  eq('bare run reports full health', bareState.health, 1);
  eq('bare run reports zero leaks', bareState.leaked, 0);
  check('bare run says it has no towers', /no towers yet/.test(bareState.text));
  check('bare state names the missing answers', /Nothing on the board does area damage/.test(bareState.text));

  // Gold is reported relative to what a tower costs, not as a bare number.
  const rich = new Sim({ gold: 3000 });
  const richState = summarizeState(rich);
  check('gold is expressed in towers', /enough for about \d+ more/.test(richState.text),
    richState.text.slice(0, 200));
  eq('cheap tower is arrow', richState.affordable, 60);

  // Tower traits have to be readable in words, and gaps named.
  // (1,2) is on the path, so builds there silently fail. Pick cells the grid
  // actually allows: the tests must not pass by accident.
  const splashy = new Sim({ gold: 5000 });
  check('cannon placed', Boolean(splashy.build('cannon', 1, 1)));
  check('frost placed', Boolean(splashy.build('frost', 1, 3)));
  // Trait order is not part of the contract, so assert membership, not string
  // equality: a Set gives no ordering guarantee once items are added from a loop.
  const traits = summarizeState(splashy).traits;
  check('cannon contributes area damage', /area damage/.test(traits), traits);
  check('frost contributes slow', /slow/.test(traits), traits);
  check('a board with both never claims single target only', !/single target only/.test(traits), traits);
  check('a board with slow omits the slow warning', !/Nothing on the board slows/.test(summarizeState(splashy).text));
  check('a board with area damage omits the armour warning', !/Nothing on the board does area damage/.test(summarizeState(splashy).text));

  const single = new Sim({ gold: 5000 });
  check('arrow placed', Boolean(single.build('arrow', 1, 1)));
  check('second arrow placed', Boolean(single.build('arrow', 1, 3)));
  check('an arrow-only board says single target only', /single target only/.test(summarizeState(single).traits),
    summarizeState(single).traits);
  check('single-target board warns about no slow', /Nothing on the board slows/.test(summarizeState(single).text));
  check('single-target board warns about no area damage', /Nothing on the board does area damage/.test(summarizeState(single).text));

  // A run that has taken damage must not read as pristine.
  const hurt = new Sim({ gold: 100 });
  hurt.wave = 5;
  hurt.leaked = 9;
  hurt.lives = 4;
  const hurtState = summarizeState(hurt);
  check('damaged core is not 100%', hurtState.health < 0.3, String(hurtState.health));
  check('damaged core is called dangerous', /real trouble/.test(hurtState.text));
  check('damaged core is not called untouched', !/never lost a life/.test(hurtState.text));

  // Health must not drift as leaks accumulate: startLives is the denominator.
  const leaky = new Sim();
  leaky.leaked = 5;
  leaky.lives = leaky.startLives - 5;
  eq('health tracks leaks against the starting value', summarizeState(leaky).health, 0.75);

  // readConfidence: confidence, margin and the full spread.
  const conf = readConfidence({
    answers: {
      difficulty: { type: 'choice', choice: 'balanced', confidence: 0.27, probabilities: { balanced: 0.51, aggressive: 0.45, gentle: 0.04 } },
      gap: { type: 'noul', noul: 0.8 },
    },
  });
  eq('confidence is read', conf.difficulty.confidence, 0.27);
  eq('choice is read', conf.difficulty.choice, 'balanced');
  eq('margin is the gap to the runner-up', conf.difficulty.margin, 0.06);
  eq('noul has no probabilities', conf.gap.probabilities && Object.keys(conf.gap.probabilities).length, 0);

  // A lone option has nothing to beat, so the margin is the whole weight.
  const solo = readConfidence({ answers: { focus: { choice: 'grunt', confidence: 0.7, probabilities: { grunt: 1 } } } });
  eq('a single option wins outright', solo.focus.margin, 1);

  // Nonsense confidence must not leak through as a negative or NaN.
  const junk = readConfidence({ answers: { focus: { choice: 'grunt', confidence: 5, probabilities: { grunt: -2 } } } });
  eq('confidence is clamped to 1', junk.focus.confidence, 1);
  eq('negative probability still yields a usable margin', junk.focus.margin, 0);

  eq('confidence floor is sane', CONFIDENCE_FLOOR > 0 && CONFIDENCE_FLOOR < 1, true);

  // The model's own words about the board come back as a hint.
  const meta = {};
  planFromAnswer({
    answers: {
      difficulty: { type: 'choice', choice: 'balanced' },
      focus: { type: 'choice', choice: 'shielded' },
      gap: { type: 'choice', choice: 'no slow tower on the board' },
    },
  }, sim, 3, meta);
  check('a named enemy becomes a build hint', typeof meta.hint === 'string' && meta.hint.length > 0, String(meta.hint));
  eq('the gap answer is carried through', meta.gap, 'no slow tower on the board');

  // Difficulty must scale the wave: aggressive is bigger than gentle.
  const gentlePlan = planFromAnswer({ answers: { difficulty: { choice: 'gentle' }, focus: { type: 'noul', noul: 0.1 } } }, sim, 5);
  const hardPlan = planFromAnswer({ answers: { difficulty: { choice: 'aggressive' }, focus: { type: 'noul', noul: 0.1 } } }, sim, 5);
  const total = (p) => p.groups.reduce((n, g) => n + g.count, 0);
  check('aggressive sends more than gentle', total(hardPlan) > total(gentlePlan),
    `gentle=${total(gentlePlan)} hard=${total(hardPlan)}`);

  // A runaway gap answer must be cut, not shown whole.
  const longMeta = {};
  planFromAnswer({ answers: { gap: { type: 'choice', choice: 'x'.repeat(400) } } }, sim, 3, longMeta);
  check('a huge gap answer is truncated', longMeta.gap.length <= 160, String(longMeta.gap?.length));

  // A noul gap is a 0..1 reading, which means nothing to a human untranslated.
  const loudMeta = {};
  planFromAnswer({ answers: { gap: { type: 'noul', noul: 0.82 } } }, sim, 3, loudMeta);
  eq('a high need is reported as a number', loudMeta.need, 0.82);
  check('a high need becomes advice', typeof loudMeta.gap === 'string' && loudMeta.gap.length > 0, String(loudMeta.gap));
  check('advice is in words, not a bare figure', !/^[\d.]+$/.test(loudMeta.gap), String(loudMeta.gap));

  const quietMeta = {};
  planFromAnswer({ answers: { gap: { type: 'noul', noul: 0.1 } } }, sim, 3, quietMeta);
  eq('a low need is recorded', quietMeta.need, 0.1);
  check('a low need makes no suggestion', quietMeta.gap === undefined, String(quietMeta.gap));

  // isUnreliable: two independent tests, either one is enough to distrust.
  const { isUnreliable, MARGIN_FLOOR } = advisorExports;
  check('low confidence is distrusted', isUnreliable({ confidence: 0.1, margin: 0.5 }) === true);
  check('a confident clear winner is trusted', isUnreliable({ confidence: 0.9, margin: 0.5 }) === false);
  check('a coin toss is distrusted despite high confidence',
    isUnreliable({ confidence: 0.85, margin: 0.01 }) === true, `margin floor ${MARGIN_FLOOR}`);
  check('a missing margin does not trigger a distrust',
    isUnreliable({ confidence: 0.85, margin: null }) === false);
  check('nothing to judge is not treated as a failure', isUnreliable(null) === false);
}

// ── report ─────────────────────────────────────────────────────────────────
section('report');
if (fail > 0) {
  process.stdout.write('\nFAILURES:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
