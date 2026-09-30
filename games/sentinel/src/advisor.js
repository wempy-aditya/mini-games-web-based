/**
 * The wave advisor.
 *
 * This is where the optional decision model plugs in. Between waves the advisor
 * asks the model for a difficulty and a target, turns that into a concrete wave
 * plan, and hands it to the simulation. If the model is disabled, slow, or
 * nonsense, `localPlan` produces an equivalent plan from the current board state
 * and the game plays exactly the same.
 *
 * The contract that matters: a plan is never trusted. Every field is clamped and
 * every enemy type is checked against the real catalogue before it reaches the
 * sim, so a hallucinated "dragon" or a count of 100000 cannot break a run.
 */

import { ENEMIES, ENEMY_KEYS, waveFor, waveScaling } from './data.js';
import { askSystemOne, isConfigured, loadConfig, DIALECT, askChat } from './llm.js';

const DIFFICULTIES = ['gentle', 'balanced', 'aggressive'];
const FOCUS = ['grunt', 'runner', 'brute', 'shielded', 'swift'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * A compact, text-first description of the run. Kept short on purpose: the
 * model's accuracy drops as the state grows, and a wall of raw numbers is both
 * slower and less reliable than a sentence plus a few numbers.
 */
export function summarizeState(sim) {
  const comp = sim.composition();
  const towerText = Object.entries(comp)
    .map(([type, n]) => `${n}x ${type}`)
    .join(', ') || 'no towers yet';

  const text = [
    `Wave ${sim.wave} of a tower defence run.`,
    `Lives remaining: ${sim.lives}.`,
    `Gold available: ${Math.round(sim.gold)}.`,
    `Towers on the map: ${towerText}.`,
    `Enemies killed so far: ${sim.kills}.`,
    `Enemies that reached the core: ${sim.leaked}.`,
  ].join(' ');

  return {
    wave: sim.wave,
    lives: sim.lives,
    gold: Math.round(sim.gold),
    composition: comp,
    kills: sim.kills,
    leaked: sim.leaked,
    text,
  };
}

/**
 * The plan used when no model is available. It escalates with the wave number
 * and leans on whatever the player already built, so the offline game still has
 * a sensible difficulty curve.
 */
export function localPlan(sim, wave) {
  const base = waveFor(wave);
  const spec = { wave, groups: base.groups.map((g) => ({ ...g })) };
  const comp = sim.composition();

  // A board full of area damage wants a tougher mix; a board of single-target
  // towers wants faster, weaker runners. This is the same reasoning a player
  // would do, done cheaply.
  const hasSplash = (comp.cannon || 0) + (comp.tesla || 0) > 0;
  const hasSlow = (comp.frost || 0) > 0;

  if (hasSplash && wave >= 3) {
    spec.groups.push({ type: 'brute', count: clampInt(1 + Math.floor(wave / 4), 1, 6, 1), gap: 1.4 });
  }
  if (!hasSlow && wave >= 2) {
    spec.groups.push({ type: 'runner', count: clampInt(4 + wave, 4, 24, 4), gap: 0.3 });
  }
  return spec;
}

/**
 * Turn a model answer into a wave plan.
 *
 * Accepts either a System One `answers` envelope or a plain object. Anything it
 * cannot understand is replaced with a local decision rather than rejected, so
 * a bad model answer still leaves the player with a playable wave.
 */
export function planFromAnswer(answer, sim, wave) {
  const answers = answer?.answers || answer || {};
  const d = answers.difficulty || {};
  const f = answers.focus || {};

  let difficulty = d.choice;
  if (d.type === 'score') {
    // A 0..2 score maps onto the three difficulty tiers.
    difficulty = DIFFICULTIES[clampInt(d.score, 0, 2, 1)];
  }
  if (!DIFFICULTIES.includes(difficulty)) difficulty = 'balanced';

  let focus = f.choice;
  if (!ENEMIES[focus]) focus = null;

  const spec = {
    wave,
    groups: waveFor(wave).groups.map((g) => ({ ...g })),
  };

  // The focus choice appends a group rather than replacing the scripted wave:
  // the model steers the flavour of a wave, it does not get to make the wave
  // empty. An empty wave would be a soft lock, not a challenge.
  if (focus) {
    const counts = { gentle: 0.5, balanced: 1, aggressive: 1.5 };
    const base = spec.groups.reduce((n, g) => n + g.count, 0);
    const n = clampInt(Math.round(base * counts[difficulty] * 0.35), 2, 30, 4);
    spec.groups.push({ type: focus, count: n, gap: 0.35 });
  } else {
    // No usable focus: scale the scripted groups by difficulty instead.
    const mult = difficulty === 'gentle' ? 0.7 : difficulty === 'aggressive' ? 1.35 : 1;
    spec.groups = spec.groups.map((g) => ({
      ...g,
      count: clampInt(Math.round(g.count * mult), 1, 60, g.count),
      gap: clampInt(g.gap / mult, 0.12, 3, g.gap),
    }));
  }

  // Final scrub. Nothing reaches the sim without a real enemy and sane numbers.
  spec.groups = spec.groups.filter((g) => ENEMIES[g.type] && g.count > 0);
  if (spec.groups.length === 0) {
    const base = waveFor(wave);
    spec.groups = base.groups.map((g) => ({ ...g }));
  }
  return spec;
}

/**
 * Ask the configured model to plan the next wave.
 *
 * Returns `{ plan, source, ms, error }`. `source` is 'local' whenever the model
 * did not contribute, so the HUD can show the player where the wave came from.
 */
export async function adviseNextWave(sim, wave, cfg = loadConfig()) {
  const fallback = localPlan(sim, wave);

  if (!isConfigured(cfg)) {
    return { plan: fallback, source: 'local' };
  }

  const state = summarizeState(sim);

  try {
    if (cfg.dialect === DIALECT.SYSTEMONE) {
      const res = await askSystemOne(state.text, {
        difficulty: {
          type: 'choice',
          instructions: 'How hard should the next wave be, given the lives and gold the player has left?',
          criteria: {
            gentle: 'The player is losing lives or broke; give them room to recover',
            balanced: 'A normal challenge matching the current wave number',
            aggressive: 'The player is ahead, safe and rich; push them hard',
          },
        },
        focus: {
          type: 'choice',
          instructions: 'Which enemy type should this wave emphasise, given the towers the player has built?',
          criteria: {
            grunt: 'Basic enemies, good against single-target towers',
            runner: 'Fast weak enemies, good against slow heavy towers',
            brute: 'Armoured high-health enemies, good against area damage',
            shielded: 'Armoured enemies, punishes towers with no armour penetration',
            swift: 'Very fast enemies, punishes towers with short range',
          },
        },
      }, cfg);

      if (!res.ok) return { plan: fallback, source: 'local', error: res.error, ms: res.ms };
      return {
        plan: planFromAnswer(res.answers, sim, wave),
        source: 'jev',
        ms: res.ms,
        model: res.model,
        raw: res.answers,
      };
    }

    // OpenAI-compatible path: ask for a small JSON object and read the same
    // two fields, so both dialects drive the game identically.
    const res = await askChat(
      'You plan waves for a tower defence game. Reply with JSON only: '
      + '{"difficulty":"gentle|balanced|aggressive","focus":"grunt|runner|brute|shielded|swift"}.',
      state.text,
      cfg,
    );
    if (!res.ok) return { plan: fallback, source: 'local', error: res.error, ms: res.ms };
    const j = res.json || {};
    return {
      plan: planFromAnswer({ answers: { difficulty: { choice: j.difficulty }, focus: { choice: j.focus } } }, sim, wave),
      source: 'llm',
      ms: res.ms,
      model: cfg.model,
      raw: j,
    };
  } catch (err) {
    // A model bug must never take the game down.
    return { plan: fallback, source: 'local', error: err.message };
  }
}
