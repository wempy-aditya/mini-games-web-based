/**
 * Upgrade cards. Each is a pure `apply(player, run)` mutation so the card
 * definitions stay data-only and the wave-clear screen just renders them.
 * `weight` biases the draw; `max` stacks cap the card (0 = uncapped).
 */
export const CARDS = [
  {
    id: 'dmg',
    icon: '◤', name: 'OVERCHARGE', tag: 'damage',
    desc: 'Damage <b>+25%</b>',
    weight: 10, max: 6,
    apply: (p) => { p.damageMul *= 1.25; },
  },
  {
    id: 'rate',
    icon: '»', name: 'RAPID CYCLE', tag: 'fire rate',
    desc: 'Fire rate <b>+22%</b>',
    weight: 10, max: 6,
    apply: (p) => { p.fireRateMul *= 1.22; },
  },
  {
    id: 'crit',
    icon: '✦', name: 'CRIT CHANCE', tag: 'crit',
    desc: 'Crit chance <b>+12%</b>',
    weight: 9, max: 5,
    apply: (p) => { p.critChance = Math.min(p.critChance + 0.12, 0.9); },
  },
  {
    id: 'critmul',
    icon: '✸', name: 'CRIT POWER', tag: 'crit',
    desc: 'Crit multiplier <b>+0.6×</b>',
    weight: 6, max: 4,
    apply: (p) => { p.critMul += 0.6; },
  },
  {
    id: 'mag',
    icon: '▤', name: 'EXTENDED MAG', tag: 'ammo',
    desc: 'Mag size <b>+12</b>',
    weight: 8, max: 5,
    apply: (p) => { p.magSize += 12; p.mag = p.magSize; },
  },
  {
    id: 'reserve',
    icon: '⊞', name: 'DEEP RESERVE', tag: 'ammo',
    desc: 'Reserve ammo <b>+90</b>',
    weight: 7, max: 4,
    apply: (p) => { p.reserveMax += 90; p.reserve += 90; },
  },
  {
    id: 'reload',
    icon: '⟳', name: 'FAST RELOAD', tag: 'utility',
    desc: 'Reload speed <b>+30%</b>',
    weight: 7, max: 3,
    apply: (p) => { p.reloadTime *= 0.7; },
  },
  {
    id: 'pierce',
    icon: '⇢', name: 'PIERCING ROUNDS', tag: 'damage',
    desc: 'Bullets pierce <b>+1</b> target',
    weight: 5, max: 3,
    apply: (p) => { p.pierce += 1; },
  },
  {
    id: 'lifesteal',
    icon: '♥', name: 'SYPHON', tag: 'sustain',
    desc: 'Heal <b>6 HP</b> per kill',
    weight: 5, max: 4,
    apply: (p) => { p.lifesteal += 6; },
  },
  {
    id: 'maxhp',
    icon: '⬢', name: 'PLATING', tag: 'defense',
    desc: 'Max HP <b>+30</b> (heals same)',
    weight: 8, max: 4,
    apply: (p) => { p.maxHp += 30; p.heal(30); },
  },
  {
    id: 'dash',
    icon: '⇉', name: 'BLINK DRIVE', tag: 'mobility',
    desc: 'Add <b>1</b> dash charge',
    weight: 5, max: 3,
    apply: (p) => { p.extraDash += 1; p.dashCharges = 1 + p.extraDash; },
  },
  {
    id: 'regen',
    icon: '✚', name: 'NANO REGEN', tag: 'sustain',
    desc: 'Regen <b>+2 HP/s</b>',
    weight: 5, max: 4,
    apply: (p, run) => { run.regen += 2; },
  },
  {
    id: 'thorns',
    icon: '✳', name: 'REACTIVE ARMOR', tag: 'defense',
    desc: 'Reflect <b>10 dmg</b> on contact',
    weight: 4, max: 3,
    apply: (p, run) => { run.thorns += 10; },
  },
  {
    id: 'combo',
    icon: '⚡', name: 'OVERCLOCK COMBO', tag: 'score',
    desc: 'Combo decays <b>slower</b>, mult <b>+0.3</b>',
    weight: 5, max: 4,
    apply: (p, run) => { run.comboWindow += 0.5; run.comboBonus += 0.3; },
  },
  {
    id: 'nova',
    icon: '◉', name: 'KILL NOVA', tag: 'aoe',
    desc: 'Kills emit a <b>small blast</b>',
    weight: 3, max: 3,
    apply: (p, run) => { run.nova += 1; },
  },
  {
    id: 'thorns2',
    icon: '◭', name: 'SHIELD FIELD', tag: 'defense',
    desc: 'Damage taken <b>-12%</b>',
    weight: 6, max: 3,
    apply: (p, run) => { run.dr *= 0.88; },
  },
];

/** Draw 3 distinct cards, respecting per-card stack caps. */
export function drawCards(run, count = 3) {
  const taken = run.taken; // { cardId: stacks }
  const pool = CARDS.filter((c) => (c.max === 0 || (taken[c.id] || 0) < c.max));
  const picks = [];
  const avail = pool.slice();
  const n = Math.min(count, avail.length);
  for (let i = 0; i < n; i++) {
    const totalWeight = avail.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < avail.length; idx++) {
      r -= avail[idx].weight;
      if (r <= 0) break;
    }
    picks.push(avail[Math.min(idx, avail.length - 1)]);
    avail.splice(avail.indexOf(picks[picks.length - 1]), 1);
  }
  return picks;
}

export function applyCard(run, player, card) {
  card.apply(player, run);
  run.taken[card.id] = (run.taken[card.id] || 0) + 1;
  run.mods.push(card);
}
