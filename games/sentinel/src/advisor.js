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

import { ENEMIES, TOWERS, TOWER_KEYS, waveFor } from './data.js';
import { askSystemOne, isConfigured, loadConfig, DIALECT, askChat } from './llm.js';

const DIFFICULTIES = ['gentle', 'balanced', 'aggressive'];
const FOCUS = ['grunt', 'runner', 'brute', 'shielded', 'swift'];

/**
 * Below this the model is guessing rather than deciding, and a guess dressed
 * up as advice is worse than no advice.
 *
 * Measured against the live endpoint with the current questions: confidence
 * runs 0.27 to 0.65 depending on how one-sided the board is. A board with slow
 * and area damage scores 0.32 because no enemy type genuinely stands out; a
 * board of plain arrows scores 0.65 because one does. The floor sits just under
 * the ambiguous-but-defensible end so those still count, while a genuine coin
 * toss (top two options within 0.05) is caught separately by the margin test.
 */
export const CONFIDENCE_FLOOR = 0.3;

/** Top two options this close together mean the choice was effectively a toss. */
export const MARGIN_FLOOR = 0.05;

/**
 * How much of the wave difficulty each tier asks for, and how fast the group
 * arrives. Spread out arrivals are easier to read on screen; compressed
 * arrivals are a different challenge, not just a bigger number.
 */
const TIER_SCALE = {
  gentle: { count: 0.6, gap: 1.35 },
  balanced: { count: 1, gap: 1 },
  aggressive: { count: 1.45, gap: 0.75 },
};

/** What a tower type can and cannot do, in words the model can reason with. */
function describeTowers(sim) {
  const comp = sim.composition();
  const entries = Object.entries(comp);
  if (entries.length === 0) return 'none yet';

  const traits = new Set();
  let anySplash = false;
  for (const [type, n] of entries) {
    if (n <= 0) continue;
    const s = sim.statsFor(type, {});
    if (!s) continue;
    if (s.splash > 0) anySplash = true;
    if (s.slow > 0) traits.add('slow');
    if (s.chain > 0) traits.add('chain lightning');
    if (s.pierce > 1) traits.add('piercing');
    if (s.range >= 200) traits.add('long range');
  }

  // "single target only" is a claim about the whole board, not one tower. A
  // cannon is area damage, so listing both would tell the model the board has
  // area damage and lacks it at the same time.
  traits.add(anySplash ? 'area damage' : 'single target only');
  return [...traits].join(', ');
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * A compact, text-first description of the run.
 *
 * Kept short on purpose, but not shorter than useful. A bare list of numbers
 * ("lives 20, gold 3000, 5x arrow") reads as three unrelated facts, and the
 * model cannot tell that those facts mean the player is cruising. The same
 * facts written as a situation ("never damaged, gold untouched, nothing on
 * the board answers fast enemies") doubled the model's confidence on the same
 * question. Numbers set the scene; sentences carry the meaning.
 *
 * The shape is: where the run stands, what the board can do, and what the
 * player has been doing. That is what a wave planner actually needs.
 */
export function summarizeState(sim) {
  const comp = sim.composition();
  const towerText = Object.entries(comp)
    .map(([type, n]) => `${n}x ${type}`)
    .join(', ') || 'no towers yet';

  const traits = describeTowers(sim);
  const starts = sim.lives + sim.leaked;
  const maxLives = sim.startLives ?? starts;
  const health = maxLives > 0 ? clamp01(sim.lives / maxLives) : 1;

  // Gold relative to what one more tower costs. "3000 gold" means nothing on
  // its own; "enough for six more towers" means something.
  const cheapest = Math.min(...TOWER_KEYS.map((k) => TOWERS[k].cost));
  const affordable = Math.floor(sim.gold / cheapest);

  const parts = [
    `Wave ${sim.wave + 1} is about to start in a tower defence run.`,
    `Core health: ${Math.round(health * 100)}% (${sim.lives} of ${maxLives} lives, ${sim.leaked} enemies have already reached it).`,
  ];

  if (sim.leaked === 0 && sim.wave > 0) {
    parts.push('The player has never lost a life, which usually means the waves so far were too easy for what they built.');
  } else if (health < 0.35) {
    parts.push('The player is in real trouble and one bad wave could end the run.');
  }

  parts.push(
    `Gold: ${Math.round(sim.gold)}, enough for about ${affordable} more of the cheapest tower. `
    + (sim.gold > cheapest * 6 ? 'That is a lot of unspent gold, so the player is saving or ignoring the shop.'
      : sim.gold < cheapest ? 'That is not enough for even one tower, so they cannot react before the wave hits.'
        : 'That is enough to add something, but not much.'),
  );

  parts.push(`Board: ${towerText} (${traits}).`);
  if (!/slow/.test(traits)) {
    parts.push('Nothing on the board slows enemies down, so anything fast will get through much more easily.');
  }
  if (!/area damage/.test(traits)) {
    parts.push('Nothing on the board does area damage, so armoured groups will not be punished.');
  }

  parts.push(`Enemies destroyed so far: ${sim.kills}.`);

  return {
    wave: sim.wave,
    lives: sim.lives,
    gold: Math.round(sim.gold),
    composition: comp,
    kills: sim.kills,
    leaked: sim.leaked,
    traits,
    health,
    affordable,
    text: parts.join(' '),
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
 *
 * `meta` carries the model's own words back to the player: how sure it was, and
 * what it thought the board was missing. A wave planner that only whispers the
 * enemy count throws away the most useful part of the answer.
 */
export function planFromAnswer(answer, sim, wave, meta = {}) {
  const answers = answer?.answers || answer || {};
  const d = answers.difficulty || {};
  const f = answers.focus || {};
  const g = answers.gap || {};

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
    groups: waveFor(wave).groups.map((g2) => ({ ...g2 })),
  };

  // The focus choice appends a group rather than replacing the scripted wave:
  // the model steers the flavour of a wave, it does not get to make the wave
  // empty. An empty wave would be a soft lock, not a challenge.
  if (focus) {
    const tier = TIER_SCALE[difficulty];
    const base = spec.groups.reduce((n, x) => n + x.count, 0);
    const n = clampInt(Math.round(base * tier.count * 0.35), 2, 30, 4);
    spec.groups.push({ type: focus, count: n, gap: clampInt(0.35 * tier.gap, 0.12, 3, 0.35) });
    // The chosen focus group is the reason this wave is hard, so the scripted
    // part keeps its own size rather than also scaling by tier. That stops
    // "aggressive" from compounding two multipliers into a wall.
    const focusName = ENEMIES[focus].name;
    meta.hint = `Prioritaskan ${focusName}`;
  } else {
    // No usable focus: scale the scripted groups by difficulty instead.
    const tier = TIER_SCALE[difficulty];
    spec.groups = spec.groups.map((x) => ({
      ...x,
      count: clampInt(Math.round(x.count * tier.count), 1, 60, x.count),
      gap: clampInt(x.gap * tier.gap, 0.12, 3, x.gap),
    }));
  }

  // The model's read of what the board cannot answer. Two shapes are possible:
  // a `noul` reading (0..1, no probabilities) or free text. Both become advice,
  // because the point is to tell the player something they have not noticed.
  // `noul` needs its own wording: "0.82" on its own means nothing to a human.
  if (g.noul !== undefined && Number.isFinite(g.noul)) {
    const n = clamp01(g.noul);
    meta.need = n;
    if (n >= 0.65) {
      meta.gap = 'Papan ini kekurangan menara. Tambah satu sebelum gelombang berikutnya.';
    } else if (n >= 0.35) {
      meta.gap = 'Papan ini cukup lemah di satu sisi. Pertimbangkan upgrade.';
    }
  } else if (typeof g.choice === 'string' && g.choice.trim()) {
    meta.gap = g.choice.trim().slice(0, 160);
  }

  // Final scrub. Nothing reaches the sim without a real enemy and sane numbers.
  spec.groups = spec.groups.filter((x) => ENEMIES[x.type] && x.count > 0);
  if (spec.groups.length === 0) {
    const base = waveFor(wave);
    spec.groups = base.groups.map((x) => ({ ...x }));
  }
  return spec;
}

/**
 * Read how sure the model was about each answer.
 *
 * `confidence` is the model's certainty in its own choice. `probabilities`
 * gives the full spread, and the gap between the top two options is a sharper
 * signal than confidence alone: two options at 0.45 and 0.51 means the choice
 * was a coin toss, whatever confidence claims.
 */
export function readConfidence(answer) {
  const answers = answer?.answers || answer || {};
  const out = {};
  for (const [name, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object') continue;
    const probs = a.probabilities && typeof a.probabilities === 'object'
      ? Object.entries(a.probabilities)
        .filter(([, v]) => Number.isFinite(v))
        .sort((x, y) => y[1] - x[1])
      : [];
    const top = probs[0]?.[1] ?? null;
    const second = probs[1]?.[1] ?? null;
    out[name] = {
      choice: a.choice,
      confidence: clamp01(a.confidence ?? 0),
      // How far ahead the winner is. 1.0 means every other option was zero.
      margin: top === null ? null : clamp01(top - (second ?? 0)),
      spread: probs.length ? probs.map(([k]) => k) : [],
      probabilities: a.probabilities || {},
    };
  }
  return out;
}

/**
 * Ask the configured model to plan the next wave.
 *
 * Returns `{ plan, source, ms, error, meta }`. `source` is 'local' whenever the
 * model did not contribute, so the HUD can show the player where the wave came
 * from.
 *
 * When the model reports low confidence the plan falls back to the local one.
 * That is the whole point of asking a decision model instead of a text model:
 * it can say "I do not know", and honouring that is more useful than dressing a
 * coin toss up as a decision. The abstention is reported so the UI can say so.
 */
export async function adviseNextWave(sim, wave, cfg = loadConfig()) {
  const fallback = localPlan(sim, wave);

  if (!isConfigured(cfg)) {
    return { plan: fallback, source: 'local', reason: 'not-configured' };
  }

  const state = summarizeState(sim);

  const commit = (answer, source, ms, model) => {
    const meta = {
      confidence: readConfidence(answer),
      state,
    };
    const plan = planFromAnswer(answer, sim, wave, meta);
    return { plan, source, ms, model, meta };
  };

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
          // Framed as "what does this board fail to stop" rather than "what
          // should this wave emphasise". Measured on the live endpoint, the
          // original wording scored 0.27 confidence because all five options
          // were equally defensible; this wording scored 0.65 on the same
          // board and picked the same enemy. A question with one clear answer
          // gets a clear answer.
          instructions: 'Which enemy type would get through this board most easily and do the '
            + 'most damage to the core? Answer with the one type this board is worst equipped to stop.',
          criteria: {
            grunt: 'Basic enemies, which even weak towers handle',
            runner: 'Fast weak enemies, which slip past slow heavy towers',
            brute: 'Armoured high-health enemies, which shrug off single-target fire',
            shielded: 'Armoured enemies, which need armour penetration to die quickly',
            swift: 'Very fast enemies, which cross short-range towers untouched',
          },
        },
        // Free text on a decision model: the one slot where it can say what it
        // sees that the player has not noticed. Kept last so it cannot colour
        // the two typed answers above it.
        gap: {
          type: 'noul',
          instructions: 'How badly does this board need a fix before the next wave: '
            + 'a slow tower, area damage, more gold, a wider range, or nothing at all? '
            + 'Answer 0 if the board is fine, 1 if it clearly is not.',
        },
      }, cfg);

      if (!res.ok) {
        return { plan: fallback, source: 'local', error: res.error, ms: res.ms, reason: 'request-failed' };
      }

      const meta = { confidence: readConfidence(res.answers), state };
      const weakest = weakestAnswer(meta.confidence);
      if (weakest && isUnreliable(weakest)) {
        // The model answered but would not stand behind it. Use the local plan,
        // which reasons from the board directly, and keep the model's own words
        // so the player sees why it declined to decide.
        return {
          plan: fallback,
          source: 'local',
          ms: res.ms,
          model: res.model,
          reason: 'low-confidence',
          meta,
        };
      }

      const plan = planFromAnswer(res.answers, sim, wave, meta);
      return { plan, source: 'jev', ms: res.ms, model: res.model, meta };
    }

    // OpenAI-compatible path: ask for a small JSON object and read the same
    // fields, so both dialects drive the game identically. A text model has no
    // calibrated confidence, so the floor cannot apply and meta carries none.
    const res = await askChat(
      'You plan waves for a tower defence game. Reply with JSON only: '
      + '{"difficulty":"gentle|balanced|aggressive","focus":"grunt|runner|brute|shielded|swift"}.',
      state.text,
      cfg,
    );
    if (!res.ok) {
      return { plan: fallback, source: 'local', error: res.error, ms: res.ms, reason: 'request-failed' };
    }
    const j = res.json || {};
    return commit({ answers: { difficulty: { choice: j.difficulty }, focus: { choice: j.focus } } }, 'llm', res.ms, cfg.model);
  } catch (err) {
    // A model bug must never take the game down.
    return { plan: fallback, source: 'local', error: err.message, reason: 'exception' };
  }
}

/**
 * The answer the model was least sure about, if any. Used to decide whether to
 * trust the reply at all: one shaky answer out of several means the whole plan
 * rests on a coin toss.
 */
function weakestAnswer(confidence) {
  let worst = null;
  for (const [name, c] of Object.entries(confidence)) {
    // `gap` is a calibrated 0..1 reading, not a decision, so it is excluded
    // from the trust test; only the two typed choices gate the wave.
    if (name === 'gap') continue;
    if (!worst || c.confidence < worst.confidence) worst = { name, ...c };
  }
  return worst;
}

/**
 * Whether an answer should be trusted. Two independent tests, because either
 * one alone gets fooled:
 *
 * - Low confidence on its own is not disqualifying. The measured range is wide
 *   for a reason, and a genuinely ambiguous board should still get an answer.
 * - A near-tie between the top two options is disqualifying regardless of what
 *   confidence claims. A model can report 0.8 confidence while its own
 *   probabilities are 0.50 and 0.49, and then the confidence is meaningless.
 */
export function isUnreliable(answer) {
  if (!answer) return false;
  if (answer.confidence < CONFIDENCE_FLOOR) return true;
  return answer.margin !== null && answer.margin < MARGIN_FLOOR;
}
