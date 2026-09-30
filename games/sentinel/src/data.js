/**
 * Static game data: the tower/enemy catalogue and the upgrade pool.
 *
 * Numbers here are the game's balance surface. They are deliberately plain
 * objects rather than classes so a save file can serialise them directly and a
 * designer can retune without touching engine code.
 */

// ── palette ────────────────────────────────────────────────────────────────

export const COLORS = {
  ink: '#0b0f16',
  panel: '#141b26',
  panel2: '#1c2534',
  edge: '#2a3446',
  grid: '#1a2330',
  grass: '#16241c',
  grassAlt: '#132019',
  path: '#2c2620',
  pathEdge: '#3d352c',
  text: '#e6eaf2',
  dim: '#8794a8',
  gold: '#f0b429',
  hp: '#e5484d',
  shield: '#3b82f6',
  crit: '#fbbf24',
  range: 'rgba(96,165,250,0.16)',
  rangeEdge: 'rgba(96,165,250,0.55)',
};

// ── paths ──────────────────────────────────────────────────────────────────

/**
 * The map is a fixed set of waypoints. Enemies walk from `spawn` along the
 * polyline to `core`. Rendering, pathing and range maths all read from here, so
 * the layout can be retuned without touching any other system.
 */
export const PATHS = {
  meander: {
    name: 'MEANDER',
    points: [
      [-40, 90], [120, 90], [120, 30], [240, 30], [240, 150],
      [360, 150], [360, 60], [480, 60], [480, 120],
    ],
  },
  spiral: {
    name: 'SPIRAL',
    points: [
      [-40, 200], [520, 200], [520, 40], [80, 40], [80, 160],
      [440, 160], [440, 80], [160, 80], [160, 120], [360, 120],
    ],
  },
  fork: {
    name: 'FORK',
    points: [
      [-40, 60], [180, 60], [180, 160], [380, 160], [380, 60], [520, 60],
    ],
  },
};

export const PATH_KEYS = Object.keys(PATHS);

// ── towers ────────────────────────────────────────────────────────────────

export const TOWERS = {
  arrow: {
    id: 'arrow',
    name: 'PANAH',
    cost: 50,
    damage: 12,
    range: 130,
    cooldown: 0.55,
    projectile: 'bolt',
    color: '#7dd3fc',
    desc: 'Cepat, murah, serangan tunggal.',
  },
  cannon: {
    id: 'cannon',
    name: 'MERIAM',
    cost: 110,
    damage: 34,
    range: 115,
    cooldown: 1.5,
    projectile: 'shell',
    splash: 46,
    color: '#fb923c',
    desc: 'Ledakan area. Berat di dekat menara.',
  },
  frost: {
    id: 'frost',
    name: 'BEKU',
    cost: 85,
    damage: 6,
    range: 105,
    cooldown: 0.9,
    projectile: 'frost',
    slow: 0.45,
    slowTime: 1.6,
    color: '#a5b4fc',
    desc: 'Melemahkan, tidak membunuh.',
  },
  tesla: {
    id: 'tesla',
    name: 'TESLA',
    cost: 150,
    damage: 20,
    range: 95,
    cooldown: 1.0,
    projectile: 'beam',
    chain: 3,
    color: '#f0abfc',
    desc: 'Rantai lightning ke 3 target.',
  },
  sniper: {
    id: 'sniper',
    name: 'PENEMBAK',
    cost: 130,
    damage: 70,
    range: 230,
    cooldown: 2.4,
    projectile: 'rail',
    pierce: 3,
    color: '#fda4af',
    desc: 'Jarak jauh, menembus garis.',
  },
};

export const TOWER_KEYS = Object.keys(TOWERS);

// ── enemies ────────────────────────────────────────────────────────────────

export const ENEMIES = {
  grunt: {
    id: 'grunt',
    name: 'PENYERUBAH',
    hp: 42,
    speed: 44,
    armor: 0,
    bounty: 6,
    radius: 9,
    color: '#94a3b8',
  },
  runner: {
    id: 'runner',
    name: 'PELARI',
    hp: 28,
    speed: 88,
    armor: 0,
    bounty: 8,
    radius: 7,
    color: '#4ade80',
  },
  brute: {
    id: 'brute',
    name: 'BRUTA',
    hp: 190,
    speed: 26,
    armor: 6,
    bounty: 22,
    radius: 15,
    color: '#f87171',
  },
  shielded: {
    id: 'shielded',
    name: 'BERPERISAI',
    hp: 96,
    speed: 38,
    armor: 10,
    bounty: 18,
    radius: 12,
    color: '#60a5fa',
  },
  swift: {
    id: 'swift',
    name: 'CEPAT',
    hp: 60,
    speed: 120,
    armor: 2,
    bounty: 14,
    radius: 8,
    color: '#fbbf24',
  },
  boss: {
    id: 'boss',
    name: 'RAJA',
    hp: 1400,
    speed: 22,
    armor: 14,
    bounty: 180,
    radius: 26,
    color: '#e879f9',
    boss: true,
  },
};

export const ENEMY_KEYS = Object.keys(ENEMIES);

// ── upgrades ───────────────────────────────────────────────────────────────

/**
 * Upgrades apply to a single placed tower. `apply(stats, level)` mutates the
 * tower's derived stats in place; the caller clones first so undo/preview is
 * cheap and side-effect free.
 */
export const UPGRADES = [
  {
    id: 'rate',
    name: 'RATE TINGGI',
    max: 4,
    cost: (lvl) => 40 + lvl * 30,
    desc: 'Serangan lebih sering.',
    // `rate` is the seconds-between-shots stat. The live countdown lives in the
    // tower's own `cooldown` field, so this must not touch `cooldown` here.
    apply: (s) => { s.rate *= 0.85; },
  },
  {
    id: 'range',
    name: 'JANGKAUAN',
    max: 4,
    cost: (lvl) => 35 + lvl * 28,
    desc: 'Jangkauan +18.',
    apply: (s) => { s.range += 18; },
  },
  {
    id: 'power',
    name: 'TENAGA',
    max: 4,
    cost: (lvl) => 50 + lvl * 38,
    desc: 'Damage +25%.',
    apply: (s) => { s.damage *= 1.25; },
  },
  {
    id: 'pierce',
    name: 'TEMBUS',
    max: 2,
    cost: (lvl) => 70 + lvl * 50,
    desc: 'Menembus 1 target tambahan.',
    apply: (s) => { s.pierce = (s.pierce || 1) + 1; },
  },
  {
    id: 'chain',
    name: 'RANTAI',
    max: 2,
    cost: (lvl) => 80 + lvl * 55,
    desc: 'Rantai +1 target.',
    apply: (s) => { s.chain = (s.chain || 0) + 1; },
  },
  {
    id: 'economy',
    name: 'EKONOMI',
    max: 3,
    cost: (lvl) => 90 + lvl * 60,
    desc: 'Bounty musuh +12%.',
    apply: (s) => { s.economy *= 1.12; },
  },
  {
    id: 'frostpower',
    name: 'BEKU KUAT',
    max: 2,
    cost: (lvl) => 60 + lvl * 40,
    desc: 'Slow lebih lama dan lebih kuat.',
    apply: (s) => { s.slow += 0.12; s.slowTime += 0.4; },
  },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

// ── waves ──────────────────────────────────────────────────────────────────

/**
 * Wave definitions. `groups` are emitted in order; each group is a burst of one
 * enemy type. The LLM advisor can override the plan between waves, so this table
 * is the default rather than the only path.
 */
export const WAVES = [
  { groups: [{ type: 'grunt', count: 8, gap: 0.8 }] },
  { groups: [{ type: 'grunt', count: 12, gap: 0.65 }] },
  {
    groups: [
      { type: 'grunt', count: 8, gap: 0.7 },
      { type: 'runner', count: 5, gap: 0.4 },
    ],
  },
  {
    groups: [
      { type: 'runner', count: 12, gap: 0.35 },
      { type: 'shielded', count: 3, gap: 1.2 },
    ],
  },
  {
    groups: [
      { type: 'grunt', count: 14, gap: 0.5 },
      { type: 'brute', count: 2, gap: 2.0 },
    ],
  },
  { groups: [{ type: 'swift', count: 10, gap: 0.3 }] },
  {
    groups: [
      { type: 'shielded', count: 6, gap: 0.9 },
      { type: 'runner', count: 10, gap: 0.3 },
    ],
  },
  {
    groups: [
      { type: 'brute', count: 4, gap: 1.4 },
      { type: 'swift', count: 8, gap: 0.35 },
    ],
  },
  { groups: [{ type: 'boss', count: 1, gap: 1 }] },
  {
    groups: [
      { type: 'grunt', count: 20, gap: 0.35 },
      { type: 'shielded', count: 8, gap: 0.6 },
    ],
  },
  {
    groups: [
      { type: 'runner', count: 18, gap: 0.22 },
      { type: 'swift', count: 12, gap: 0.28 },
    ],
  },
  { groups: [{ type: 'boss', count: 2, gap: 3.0 }] },
];

/** Beyond the scripted table, waves are generated and scale smoothly. */
export function waveFor(n) {
  if (n <= WAVES.length) return WAVES[n - 1];
  const tier = Math.floor((n - WAVES.length) / 4);
  return {
    generated: true,
    groups: [
      { type: 'grunt', count: 14 + tier * 4, gap: 0.32 },
      { type: 'runner', count: 10 + tier * 3, gap: 0.24 },
      { type: 'shielded', count: 6 + tier * 2, gap: 0.55 },
      { type: 'brute', count: 3 + tier, gap: 1.2 },
    ],
  };
}

/** Multiplier applied to enemy HP as the run progresses. */
export function waveScaling(n) {
  return 1 + (n - 1) * 0.16 + Math.pow(Math.max(0, n - 12), 1.7) * 0.05;
}
