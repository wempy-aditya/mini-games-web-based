/**
 * Wiring layer.
 *
 * Everything with rules lives in sim.js; everything visual lives in render.js.
 * This file only translates user intent into calls on those two and keeps the
 * DOM in sync. The separation is deliberate: it is what let the simulation be
 * tested headlessly before a single pixel existed.
 */

import { Sim } from './sim.js';
import { Renderer } from './render.js';
import { Audio } from './audio.js';
import { TOWERS, TOWER_KEYS, UPGRADES, PATHS, PATH_KEYS } from './data.js';
import { adviseNextWave, localPlan } from './advisor.js';
import { loadConfig, saveConfig, clearConfig, isConfigured, testConnection, DIALECT } from './llm.js';
import { compact } from './util.js';

const SAVE_KEY = 'minigames.sentinel.save.v1';

// ── element handles ────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'),
  gold: $('gold'),
  lives: $('lives'),
  wave: $('wave'),
  kills: $('kills'),
  palette: $('palette'),
  inspector: $('inspector'),
  inspectBody: $('inspectBody'),
  status: $('status'),
  btnNext: $('btnNext'),
  btnPause: $('btnPause'),
  btnSound: $('btnSound'),
  btnAi: $('btnAi'),
  btnHelp: $('btnHelp'),
  btnMenu: $('btnMenu'),
  waveBanner: $('waveBanner'),
  advisorNote: $('advisorNote'),
  advisorAdvice: $('advisorAdvice'),
  mapPick: $('mapPick'),
  menuStats: $('menuStats'),
};

// ── state ──────────────────────────────────────────────────────────────────

let sim = new Sim();
let renderer = new Renderer(el.board, sim);
const audio = new Audio();

let llmCfg = loadConfig();
let armed = null;          // tower type id the player has picked up
let selected = null;       // tower being inspected
let bannerTimer = 0;
let advisorTimer = 0;
let advisorBusy = false;
let soundHook = null;      // set below; used to fire sounds on sim events

// ── persistence ────────────────────────────────────────────────────────────

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(sim.toJSON()));
  } catch { /* storage full or blocked: the run just is not saved */ }
}

function hasSave() {
  try { return Boolean(localStorage.getItem(SAVE_KEY)); } catch { return false; }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return Sim.fromJSON(JSON.parse(raw));
  } catch {
    return null;
  }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

// ── sound hooks ────────────────────────────────────────────────────────────

// The sim has no audio of its own; it records events instead. Watching them
// here keeps audio.js out of the simulation and the simulation testable.
function watchSimEvents() {
  let lastKills = sim.kills;
  let lastLeaked = sim.leaked;
  let lastProjectiles = sim.projectiles.length;
  let lastEffects = sim.effects.length;

  soundHook = () => {
    if (sim.kills > lastKills) audio.kill();
    if (sim.leaked > lastLeaked) {
      audio.leak();
      renderer.addShake(9);
    }
    for (let i = lastEffects; i < sim.effects.length; i++) {
      if (sim.effects[i].kind === 'boom') audio.boom();
      if (sim.effects[i].kind === 'beam' || sim.effects[i].kind === 'rail') audio.beam();
    }
    if (sim.projectiles.length > lastProjectiles && audio.enabled) {
      // A projectile appearing means a tower just fired.
      const p = sim.projectiles[sim.projectiles.length - 1];
      if (p.kind === 'bolt' || p.kind === 'shell') audio.blip({ freq: 300, to: 160, type: 'triangle', dur: 0.07, gain: 0.14 });
    }
    lastKills = sim.kills;
    lastLeaked = sim.leaked;
    lastProjectiles = sim.projectiles.length;
    lastEffects = sim.effects.length;
  };
}

// ── HUD ────────────────────────────────────────────────────────────────────

function paintHud() {
  el.gold.textContent = compact(sim.gold);
  el.lives.textContent = String(sim.lives);
  el.wave.textContent = String(sim.wave);
  el.kills.textContent = String(sim.kills);

  const running = sim.waveActive || sim.enemies.length > 0;
  el.btnNext.disabled = running || sim.over;
  el.btnNext.textContent = sim.wave === 0
    ? 'MULAI GELOMBANG 1'
    : running ? 'GELOMBANG BERJALAN' : `GELOMBANG ${sim.wave + 1}`;

  el.btnPause.textContent = sim.paused ? '▶' : 'II';
  el.btnSound.textContent = audio.enabled ? '♪' : '×';
  el.btnAi.classList.toggle('live', isConfigured(llmCfg));

  if (sim.over) {
    el.status.textContent = 'Permainan berakhir.';
  } else if (sim.paused) {
    el.status.textContent = 'Dijeda.';
  } else if (running) {
    el.status.textContent = `Gelombang ${sim.wave}: ${sim.enemies.length} musuh di papan, ${sim.spawnQueue.length} menyusul.`;
  } else {
    el.status.textContent = `Siap. ${sim.gold} gelar untuk dibelanjakan.`;
  }

  paintPalette();
  paintInspector();
}

function paintPalette() {
  if (el.palette.childElementCount !== TOWER_KEYS.length) {
    el.palette.innerHTML = '';
    for (const id of TOWER_KEYS) {
      const def = TOWERS[id];
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.dataset.tower = id;
      btn.innerHTML = `
        <span class="nm"><i class="dot" style="background:${def.color}"></i>${def.name}</span>
        <span class="cost">${def.cost}</span>
        <span class="ds">${def.desc}</span>`;
      btn.addEventListener('click', () => pickTower(id));
      el.palette.appendChild(btn);
    }
  }
  for (const btn of el.palette.children) {
    const def = TOWERS[btn.dataset.tower];
    btn.classList.toggle('on', armed === btn.dataset.tower);
    btn.disabled = sim.over || sim.gold < def.cost;
  }
}

function paintInspector() {
  if (!selected || !sim.towers.includes(selected)) {
    el.inspector.hidden = true;
    selected = null;
    return;
  }
  el.inspector.hidden = false;
  const t = selected;
  const def = TOWERS[t.type];

  const rows = UPGRADES
    .map((u) => {
      const lvl = t.upgrades[u.id] || 0;
      const cost = sim.upgradeCost(t, u.id);
      const maxed = cost === null;
      const pips = Array.from({ length: u.max },
        (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      // Upgrades that mean nothing to a given tower are hidden rather than
      // shown greyed out: a chain count on a cannon is just noise.
      if ((u.id === 'chain' && t.projectile !== 'beam')
        || (u.id === 'pierce' && t.projectile === 'beam')
        || (u.id === 'pierce' && t.projectile === 'rail')
        || (u.id === 'frostpower' && t.projectile !== 'frost')) {
        return '';
      }
      return `<div class="uprow">
        <span>
          <span class="nm">${u.name} <span class="pips">${pips}</span></span>
          <span class="ds">${u.desc}</span>
        </span>
        <button data-up="${u.id}" ${maxed || sim.gold < cost || sim.over ? 'disabled' : ''}>
          ${maxed ? 'MAX' : cost}
        </button>
      </div>`;
    })
    .join('');

  const refund = Math.floor(t.totalSpent * 0.7);
  el.inspectBody.innerHTML = `
    <div class="uprow">
      <span><span class="nm">${def.name}</span>
      <span class="ds">${t.kills} musuh dihancurkan</span></span>
      <span class="cost">${t.damage} dmg</span>
    </div>
    ${rows}
    <div class="sellrow">
      <span class="info">Terpasang, total biaya ${t.totalSpent}.</span>
      <button id="btnSell">Jual +${refund}</button>
    </div>`;

  for (const b of el.inspectBody.querySelectorAll('[data-up]')) {
    b.addEventListener('click', () => doUpgrade(t, b.dataset.up));
  }
  const sell = $('btnSell');
  if (sell) sell.addEventListener('click', () => doSell(t));
}

function banner(text, ms = 1600) {
  el.waveBanner.textContent = text;
  el.waveBanner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.waveBanner.hidden = true; }, ms);
}

function advisorNote(text, isLocal) {
  el.advisorNote.textContent = text;
  el.advisorNote.classList.toggle('local', Boolean(isLocal));
  el.advisorNote.hidden = false;
  clearTimeout(advisorTimer);
  advisorTimer = setTimeout(() => { el.advisorNote.hidden = true; }, 3200);
}

// ── player actions ─────────────────────────────────────────────────────────

function pickTower(id) {
  audio.resume();
  if (sim.over) return;
  armed = armed === id ? null : id;
  if (armed) {
    selected = null;
    audio.build();
  }
  paintHud();
}

function doUpgrade(tower, upgradeId) {
  audio.resume();
  if (sim.upgrade(tower, upgradeId)) {
    audio.upgrade();
    save();
  } else {
    audio.denied();
  }
  paintHud();
}

function doSell(tower) {
  audio.resume();
  if (sim.sell(tower)) {
    audio.sell();
    if (selected === tower) selected = null;
    save();
  }
  paintHud();
}

function onBoardClick(ev) {
  audio.resume();
  if (sim.over) return;
  const cell = renderer.cellAt(ev.clientX, ev.clientY);
  if (!cell) return;

  const existing = sim.towerAt(cell.col, cell.row);

  if (armed) {
    if (existing) {
      // Clicking an occupied cell with a tool armed just inspects instead.
      selected = existing;
      armed = null;
      paintHud();
      return;
    }
    const built = sim.build(armed, cell.col, cell.row);
    if (built) {
      audio.place();
      // Keep the tool armed so a run of towers can be laid down quickly.
      if (sim.gold < TOWERS[armed].cost) armed = null;
      save();
    } else {
      audio.denied();
    }
    paintHud();
    return;
  }

  selected = existing || null;
  paintHud();
}

function onBoardMove(ev) {
  const cell = renderer.cellAt(ev.clientX, ev.clientY);
  const same = cell && renderer.hover
    && cell.col === renderer.hover.col && cell.row === renderer.hover.row;
  if (same) return;
  renderer.hover = cell;
}

function nextWave() {
  if (sim.over) return;
  audio.resume();
  audio.waveStart();
  // The local plan is a genuine fallback, not a stub: the sim already defaults
  // to its own scripted table, so only pre-computing it here would double up.
  sim.plan = localPlan(sim, sim.wave + 1);
  sim.startWave(sim.wave + 1);
  banner(`GELOMBANG ${sim.wave}`, 1500);
  save();
  paintHud();
}

/**
 * Ask the configured model to plan the next wave, then start it.
 *
 * The model is optional by design: while it is thinking the button is disabled,
 * and if anything at all goes wrong the locally generated plan is used instead.
 * The game is never blocked on the network.
 */
async function nextWaveAdvised() {
  if (sim.over || advisorBusy) return;
  if (sim.waveActive || sim.enemies.length > 0) return;

  audio.resume();
  const wave = sim.wave + 1;

  if (!isConfigured(llmCfg)) {
    audio.waveStart();
    sim.plan = localPlan(sim, wave);
    sim.startWave(wave);
    banner(`GELOMBANG ${wave}`, 1500);
    save();
    paintHud();
    return;
  }

  advisorBusy = true;
  el.btnNext.disabled = true;
  el.status.textContent = 'Model sedang menyusun gelombang...';

  const res = await adviseNextWave(sim, wave, llmCfg);

  advisorBusy = false;
  sim.plan = res.plan;
  sim.startWave(wave);
  audio.waveStart();
  banner(`GELOMBANG ${wave}`, 1500);

  if (res.source === 'local') {
    // Three different reasons to fall back, and the player deserves to know
    // which: the model is off, the model failed, or the model declined to
    // decide. "Local plan" alone reads like a bug.
    if (res.reason === 'low-confidence') {
      const entries = Object.entries(res.meta?.confidence || {})
        .filter(([k]) => k !== 'gap')
        .sort((a, b) => a[1].confidence - b[1].confidence);
      const [label, worst] = entries[0] || ['salah satu keputusan', { confidence: 0 }];
      advisorNote(`Jev ragu soal "${label}" (keyakinan ${Math.round(worst.confidence * 100)}%), jadi pakai rencana lokal.`, true);
    } else if (res.error) {
      advisorNote(`Model gagal: ${res.error}. Pakai rencana lokal.`, true);
    } else {
      advisorNote('Rencana lokal (model nonaktif).', true);
    }
  } else {
    const name = res.source === 'jev' ? 'Jev' : 'model';
    const bits = [`Disusun ${name} dalam ${res.ms}ms`];
    if (res.meta?.hint) bits.push(res.meta.hint);
    const conf = res.meta?.confidence?.difficulty;
    if (conf && Number.isFinite(conf.confidence)) {
      bits.push(`keyakinan ${Math.round(conf.confidence * 100)}%`);
    }
    advisorNote(bits.join(' — '));
  }

  save();
  paintHud();
  // The build advice outlives the wave banner: it is the part the player acts
  // on between waves, so it gets its own line rather than a 3 second flash.
  advisorAdvice(res.meta?.gap);
}

/**
 * Show the model's read of what the board is missing, if it had one. Shown
 * regardless of whether the wave came from the model or the local fallback: a
 * low-confidence answer still carries a useful observation, and the point of
 * abstaining is to still offer something.
 */
function advisorAdvice(text) {
  if (!text) {
    el.advisorAdvice.hidden = true;
    return;
  }
  el.advisorAdvice.textContent = `Saran: ${text}`;
  el.advisorAdvice.hidden = false;
}

// ── game loop ──────────────────────────────────────────────────────────────

let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const beforeWave = sim.waveActive;
  const beforeOver = sim.over;
  sim.step(dt);
  if (soundHook) soundHook();

  // Wave cleared: reward the player and offer the next one.
  if (beforeWave && !sim.waveActive && sim.enemies.length === 0 && !sim.over) {
    audio.waveClear();
    const bonus = 20 + sim.wave * 5;
    sim.gold += bonus;
    banner(`GELOMBANG ${sim.wave} SELESAI  +${bonus}`, 1800);
    save();
  }

  if (!beforeOver && sim.over) {
    audio.gameOver();
    showOver();
  }

  renderer.draw(dt);
  paintHud();
  requestAnimationFrame(frame);
}

// ── modals ─────────────────────────────────────────────────────────────────

function openModal(node) { node.hidden = false; }
function closeModal(node) { node.hidden = true; }

let aiDraft = null;

function openAi() {
  aiDraft = { ...llmCfg };
  $('aiDialect').value = aiDraft.dialect;
  $('aiEnabled').checked = aiDraft.enabled;
  $('aiBase').value = aiDraft.baseUrl;
  $('aiModel').value = aiDraft.model;
  $('aiKey').value = aiDraft.apiKey;
  $('aiTemp').value = String(aiDraft.temperature);
  $('aiTimeout').value = String(aiDraft.timeoutMs);
  if ($('aiTransport')) $('aiTransport').value = aiDraft.transport || 'auto';
  $('aiKey').type = 'password';
  $('aiTestOut').textContent = '';
  $('aiTestOut').className = 'testout';
  syncDialectNote();
  openModal($('aiModal'));
}

function syncDialectNote() {
  const d = $('aiDialect').value;
  $('tempRow').hidden = d === DIALECT.SYSTEMONE;
  $('dialectNote').textContent = d === DIALECT.SYSTEMONE
    ? 'Model keputusan: menerima state dan pertanyaan bertipe, mengembalikan pilihan bertipe dengan confidence. Nama model yang lazim: jev-latest atau jev-1.13.0.'
    : 'Model bahasa biasa. Sentinel meminta jawaban JSON dan memakainya untuk menyusun gelombang. Pastikan endpoint mendukung /v1/chat/completions.';
}

function readAiDraft() {
  return {
    dialect: $('aiDialect').value,
    enabled: $('aiEnabled').checked,
    baseUrl: $('aiBase').value.trim(),
    model: $('aiModel').value.trim(),
    apiKey: $('aiKey').value.trim(),
    temperature: Number($('aiTemp').value) || 0.7,
    maxTokens: 400,
    timeoutMs: Number($('aiTimeout').value) || 15000,
    transport: $('aiTransport') ? $('aiTransport').value : 'auto',
  };
}

function bindAiModal() {
  $('aiClose').addEventListener('click', () => closeModal($('aiModal')));
  $('aiCancel').addEventListener('click', () => closeModal($('aiModal')));
  $('aiDialect').addEventListener('change', syncDialectNote);

  $('aiReveal').addEventListener('click', () => {
    const input = $('aiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('aiReveal').textContent = input.type === 'password' ? 'Lihat' : 'Sembunyi';
  });

  $('aiTest').addEventListener('click', async () => {
    const btn = $('aiTest');
    const out = $('aiTestOut');
    btn.disabled = true;
    out.className = 'testout';
    out.textContent = 'Menguji...';
    const res = await testConnection(readAiDraft());
    out.className = `testout ${res.ok ? 'ok' : 'err'}`;
    out.textContent = res.ok ? `OK - ${res.detail}` : `Gagal - ${res.error}`;
    btn.disabled = false;
  });

  $('aiSave').addEventListener('click', () => {
    llmCfg = readAiDraft();
    saveConfig(llmCfg);
    closeModal($('aiModal'));
    paintHud();
    if (isConfigured(llmCfg)) advisorNote('Model aktif. Gelombang berikutnya akan disusun model.');
  });

  $('aiClear').addEventListener('click', () => {
    clearConfig();
    llmCfg = loadConfig();
    $('aiBase').value = llmCfg.baseUrl;
    $('aiModel').value = llmCfg.model;
    $('aiKey').value = '';
    $('aiEnabled').checked = false;
    $('aiTestOut').className = 'testout';
    $('aiTestOut').textContent = 'Tersimpan dihapus.';
    paintHud();
  });
}

function bindMenus() {
  $('btnHelp').addEventListener('click', () => openModal($('helpModal')));
  $('helpClose').addEventListener('click', () => closeModal($('helpModal')));
  $('helpOk').addEventListener('click', () => closeModal($('helpModal')));

  $('btnMenu').addEventListener('click', () => {
    $('menuStats').innerHTML = `
      <div><span>GELOMBANG</span><b>${sim.wave}</b></div>
      <div><span>NYAWA</span><b>${sim.lives}</b></div>
      <div><span>DIJATUHKAN</span><b>${sim.kills}</b></div>
      <div><span>TOTAL GELAR</span><b>${sim.goldEarned}</b></div>`;
    openModal($('menuModal'));
  });
  $('menuClose').addEventListener('click', () => closeModal($('menuModal')));
  $('menuOk').addEventListener('click', () => closeModal($('menuModal')));

  $('btnRestart').addEventListener('click', () => {
    clearSave();
    closeModal($('menuModal'));
    restart(el.mapPick.value);
  });

  $('overAgain').addEventListener('click', () => {
    closeModal($('overModal'));
    restart(sim.pathKey);
  });
}

function showOver() {
  $('overTitle').textContent = sim.leaked > 0 ? 'INTI JAUHAT' : 'GELOMBANG SELESAI';
  $('overStats').innerHTML = `
    <div class="full"><span>GELOMBANG DITEMPUH</span><b>${sim.wave}</b></div>
    <div><span>DIJATUHKAN</span><b>${sim.kills}</b></div>
    <div><span>MENARA</span><b>${sim.towers.length}</b></div>
    <div><span>TOTAL GELAR</span><b>${sim.goldEarned}</b></div>
    <div><span>BOCOR</span><b>${sim.leaked}</b></div>`;
  openModal($('overModal'));
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function restart(pathKey) {
  sim = new Sim({ pathKey });
  renderer.sim = sim;
  watchSimEvents();
  armed = null;
  selected = null;
  renderer.selected = null;
  renderer.ghost = null;
  renderer.hover = null;
  clearSave();
  paintHud();
  // Advice from the previous run would be advice about a board that no longer
  // exists, so it goes with it.
  advisorAdvice(null);
  el.advisorNote.hidden = true;
  banner('PERTARUNGAN BARU', 1200);
}

function onKey(ev) {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;

  switch (ev.key) {
    case ' ':
      ev.preventDefault();
      if (sim.over) return;
      sim.paused = !sim.paused;
      break;
    case 'n':
    case 'N':
      if (isConfigured(llmCfg)) nextWaveAdvised(); else nextWave();
      break;
    case 'Escape':
      if (armed) { armed = null; paintHud(); break; }
      if (selected) { selected = null; paintHud(); break; }
      for (const m of ['aiModal', 'helpModal', 'menuModal']) closeModal($(m));
      break;
    case '1': case '2': case '3': case '4': case '5': {
      const id = TOWER_KEYS[Number(ev.key) - 1];
      if (id) pickTower(id);
      break;
    }
    default:
      break;
  }
}

function bind() {
  el.board.addEventListener('pointerdown', onBoardClick);
  el.board.addEventListener('pointermove', onBoardMove);
  el.board.addEventListener('pointerleave', () => { renderer.hover = null; });

  el.btnNext.addEventListener('click', () => {
    if (isConfigured(llmCfg)) nextWaveAdvised(); else nextWave();
  });
  el.btnPause.addEventListener('click', () => { sim.paused = !sim.paused; paintHud(); });
  el.btnSound.addEventListener('click', () => { audio.toggle(); paintHud(); });
  el.btnAi.addEventListener('click', openAi);

  for (const b of document.querySelectorAll('[data-speed]')) {
    b.addEventListener('click', () => {
      sim.speed = Number(b.dataset.speed);
      for (const o of document.querySelectorAll('[data-speed]')) o.classList.toggle('on', o === b);
    });
  }

  for (const key of PATH_KEYS) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PATHS[key].name;
    el.mapPick.appendChild(opt);
  }
  el.mapPick.value = sim.pathKey;

  // Save on the way out so a refresh does not lose a run in progress.
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('keydown', onKey);

  // Keep the canvas sized to its box. Coalesced to the next frame because the
  // browser has not necessarily reflowed when a resize event fires.
  let pending = false;
  const remeasure = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderer.resize(); });
  };
  window.addEventListener('resize', remeasure);
  if ('ResizeObserver' in window) new ResizeObserver(remeasure).observe(el.board);
}

function boot() {
  const saved = hasSave() ? loadSave() : null;
  if (saved) {
    sim = saved;
    el.mapPick.value = sim.pathKey;
    if (sim.wave > 0) banner(`DILANJUTKAN — GELOMBANG ${sim.wave}`, 1800);
  }

  renderer = new Renderer(el.board, sim);
  watchSimEvents();
  bindAiModal();
  bindMenus();
  bind();
  paintHud();

  last = performance.now();
  requestAnimationFrame(frame);
}

// Debug handle for headless verification. `sim` is a live getter because
// restart() replaces the object; a captured reference would go stale.
window.__SN = {
  get sim() { return sim; },
  renderer,
  audio,
  get cfg() { return llmCfg; },
  setCfg(c) { llmCfg = c; saveConfig(c); paintHud(); },
  TOWERS, UPGRADES,
  nextWave,
  nextWaveAdvised,
  pickTower,
  restart,
  save, loadSave, hasSave, clearSave,
  isConfigured,
  testConnection,
};

boot();
