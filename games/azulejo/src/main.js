/**
 * Bootstrap and UI wiring.
 *
 * State lives in `Match`; this file only translates user intent into match calls
 * and repaints. Keeping the rules out of here is what makes the headless test
 * suite in `test/` possible.
 */

import { Match, MODE, PHASE, HAND_SIZE } from './match.js';
import { Renderer, THEME, roundRect, hexA } from './render.js';
import { CELL } from './board.js';
import { rotated, orientations, NEUTRAL } from './tile.js';
import { COLOR_META, key } from './util.js';
import { audio } from './audio.js';
import { DIFFICULTY } from './ai.js';

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('board'),
  hand: $('hand'),
  hints: $('hints'),
  phase: $('phaseLabel'),
  wallTools: $('wallTools'),
  wallSwatches: $('wallSwatches'),
  cancelWall: $('btnCancelWall'),
  thinking: $('thinking'),
  scoreYou: $('scoreYou'),
  scoreFoe: $('scoreFoe'),
  scoreYouVal: $('scoreYouVal'),
  scoreFoeVal: $('scoreFoeVal'),
  foeName: $('foeName'),
  toast: $('toast'),
  screenTitle: $('screenTitle'),
  screenHelp: $('screenHelp'),
  screenOver: $('screenOver'),
  screenMenu: $('screenMenu'),
  overTitle: $('overTitle'),
  overSub: $('overSub'),
  finalScores: $('finalScores'),
  overBreakdown: $('overBreakdown'),
  bestLine: $('bestLine'),
  segMode: $('segMode'),
  segDiff: $('segDiff'),
  btnContinue: $('btnContinue'),
  btnSound: $('btnSound'),
  btnUndo: $('btnUndo'),
  btnMenuSound: $('btnMenuSound'),
  wallTable: $('wallTable'),
};

const prefs = Match.loadPrefs();
const renderer = new Renderer(el.canvas);
let match = new Match({ mode: prefs.mode, difficulty: prefs.difficulty });

/** Transient UI state, deliberately not part of the match. */
const ui = {
  screen: 'title',
  selected: -1,        // index into hand
  rotations: [],       // per hand index
  wallColor: null,     // chosen wall colour, or null = not arming
  hover: null,
  hoverMove: null,
  legalCells: new Set(),
  busy: false,
  thinking: false,
};

// ── boot ──────────────────────────────────────────────────────────────────

initSwatches();
initWallTable();
initSegments();
bindEvents();
refreshAll();
showScreen('title');
requestAnimationFrame(loop);

function initSwatches() {
  el.wallSwatches.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = String(i);
    b.style.background = COLOR_META[i].hex;
    b.style.color = COLOR_META[i].hex;
    b.title = `${COLOR_META[i].name} — ${COLOR_META[i].wall} poin`;
    b.innerHTML = `<span class="pts">${COLOR_META[i].wall}</span>`;
    b.addEventListener('click', () => pickWallColor(i));
    el.wallSwatches.appendChild(b);
  }
}

function initWallTable() {
  el.wallTable.innerHTML = COLOR_META.map((c) => `
    <div class="wt">
      <div class="sw" style="background:${c.hex}"></div>
      <div class="nm">${c.name}</div>
      <div class="pt">${c.wall}</div>
    </div>`).join('');
}

function initSegments() {
  el.segMode.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === prefs.mode);
    b.setAttribute('aria-checked', String(b.dataset.mode === prefs.mode));
    b.addEventListener('click', () => {
      prefs.mode = b.dataset.mode;
      Match.savePrefs(prefs);
      el.segMode.querySelectorAll('button').forEach((x) => {
        const on = x.dataset.mode === prefs.mode;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      });
      updateFoeName();
    });
  });

  el.segDiff.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.diff === prefs.difficulty);
    b.setAttribute('aria-checked', String(b.dataset.diff === prefs.difficulty));
    b.addEventListener('click', () => {
      prefs.difficulty = b.dataset.diff;
      Match.savePrefs(prefs);
      el.segDiff.querySelectorAll('button').forEach((x) => {
        const on = x.dataset.diff === prefs.difficulty;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      });
    });
  });

  el.btnContinue.hidden = !Match.hasSave();
  updateSoundButtons();
  updateFoeName();
  renderBest();
}

function renderBest() {
  const best = loadBest();
  el.bestLine.innerHTML = best
    ? `terbaik: <b>${best.score}</b> poin${best.wave ? ` · ${best.lines} garis` : ''}`
    : 'belum ada rekor';
}

const BEST_KEY = 'minigames.azulejo.best.v1';
function loadBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) || 'null'); } catch { return null; }
}
function saveBest(entry) {
  const cur = loadBest();
  if (!cur || entry.score > cur.score) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(entry)); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * The opponent's label must come from the LIVE match, not the setup screen
 * preference. Reading `prefs` here made a running human-vs-AI match announce
 * itself as "AI vs AI", which is simply wrong.
 */
function updateFoeName() {
  const isAiAi = match.mode === MODE.AI_VS_AI;
  el.foeName.textContent = isAiAi
    ? `AI ${DIFFICULTY[match.difficulty]?.label ?? DIFFICULTY.normal.label}`
    : `AI ${DIFFICULTY[match.difficulty]?.label ?? DIFFICULTY.normal.label}`;
  el.scoreFoe.classList.toggle('spectate', isAiAi);
}

function updateSoundButtons() {
  el.btnSound.classList.toggle('off', !audio.enabled);
  el.btnMenuSound.textContent = `SUARA: ${audio.enabled ? 'ON' : 'OFF'}`;
}

// ── events ────────────────────────────────────────────────────────────────

function bindEvents() {
  el.canvas.addEventListener('mousemove', onHover);
  el.canvas.addEventListener('mouseleave', () => { ui.hover = null; ui.hoverMove = null; });
  el.canvas.addEventListener('click', onCanvasClick);
  el.canvas.addEventListener('contextmenu', onCanvasRight);

  $('btnStart').addEventListener('click', startNew);
  el.btnContinue.addEventListener('click', continueSaved);
  $('btnHow').addEventListener('click', () => showScreen('help'));
  $('btnHelp').addEventListener('click', () => showScreen('help'));
  $('btnHelpClose').addEventListener('click', () => showScreen(ui.screen === 'help' ? 'title' : 'game'));
  $('btnMenuHelp').addEventListener('click', () => showScreen('help'));

  $('btnAgain').addEventListener('click', startNew);
  $('btnReview').addEventListener('click', () => showScreen('game'));
  $('btnToMenu').addEventListener('click', toMenu);

  $('btnUndo').addEventListener('click', doUndo);
  el.btnSound.addEventListener('click', () => { audio.setEnabled(!audio.enabled); updateSoundButtons(); });
  el.btnMenuSound.addEventListener('click', () => { audio.setEnabled(!audio.enabled); updateSoundButtons(); });
  $('btnMenu').addEventListener('click', () => { if (ui.screen === 'game') showScreen('menu'); });
  $('btnResume').addEventListener('click', () => showScreen('game'));

  el.cancelWall.addEventListener('click', cancelWall);

  window.addEventListener('keydown', onKey);
  // The stage box is only final after layout settles, and it changes when the
  // tray grows a hint line. Re-measure on the next frame so the board always
  // matches the space it actually has — a stale size is what clipped the board.
  window.addEventListener('resize', scheduleResize);
  if (window.ResizeObserver) {
    new ResizeObserver(scheduleResize).observe(el.canvas.parentElement);
  }
  window.addEventListener('beforeunload', () => { if (ui.screen === 'game') match.save(); });

  // First gesture unlocks WebAudio.
  const unlock = () => { audio.resume(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

function onHover(e) {
  if (ui.busy || ui.screen !== 'game') return;
  const rect = el.canvas.getBoundingClientRect();
  const p = renderer.hit(e.clientX - rect.left, e.clientY - rect.top);
  const changed = (p?.r !== ui.hover?.r) || (p?.c !== ui.hover?.c);
  ui.hover = p;
  if (changed) {
    ui.hoverMove = p && ui.legalCells.has(key(p.r, p.c)) ? p : null;
    if (p) audio.hover();
  }
}

function onCanvasClick(e) {
  if (ui.busy || ui.screen !== 'game') return;
  const rect = el.canvas.getBoundingClientRect();
  const p = renderer.hit(e.clientX - rect.left, e.clientY - rect.top);
  if (!p) return;
  audio.resume();
  handleCellClick(p.r, p.c);
}

function onCanvasRight(e) {
  e.preventDefault();
  if (ui.selected < 0) return;
  rotateSelected(1);
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (ui.screen === 'help') showScreen('title');
    else if (ui.screen === 'menu') showScreen('game');
    else if (ui.screen === 'game') showScreen('menu');
    return;
  }

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    showScreen(ui.screen === 'help' ? 'game' : 'help');
    return;
  }

  if (ui.screen !== 'game' || ui.busy) return;

  const k = e.key.toLowerCase();

  if (k === 'r') { rotateSelected(1); return; }
  if (k === 'z') { doUndo(); return; }
  if (k === 'u') { drawTile(); return; }
  if (k === 'escape') return;

  // Digits select hand tiles, or pick a wall colour during the wall phase.
  if (/^[1-9]$/.test(e.key)) {
    const n = Number(e.key);
    if (ui.selected >= 0 && n <= match.currentHand.length) {
      selectTile(n - 1);
    } else if (n <= 5) {
      pickWallColor(n - 1);
    }
    return;
  }
}

function selectTile(i) {
  if (i < 0 || i >= match.currentHand.length) return;
  ui.selected = ui.selected === i ? -1 : i;
  if (ui.selected >= 0) {
    // Selecting a tile implies "play phase": arming a wall and holding a tile
    // at the same time is a confusing state, so the wall picker closes.
    if (ui.wallColor !== null) cancelWall();
  }
  audio.select();
  updateLegal();
  render();
}

function rotateSelected(dir) {
  if (ui.selected < 0) {
    toast('pilih ubin dulu', true);
    return;
  }
  const n = match.currentHand.length;
  ui.rotations[ui.selected] = ((ui.rotations[ui.selected] || 0) + dir + 4) % 4;
  audio.rotate();
  updateLegal();
  render();
}

function currentTileAt(i) {
  const base = match.currentHand[i];
  if (!base) return null;
  return rotated(base, ui.rotations[i] || 0);
}

function pickWallColor(c) {
  if (ui.busy || match.over) return;
  if (ui.wallColor === c) { cancelWall(); return; }
  ui.wallColor = c;
  ui.selected = -1;
  audio.select();
  updateLegal();
  render();
}

function cancelWall() {
  ui.wallColor = null;
  match.cancelWall();
  updateLegal();
  render();
}

function drawTile() {
  if (ui.busy || match.over) return;
  if (!match.drawTile()) { toast('tumpukan ubin habis', true); return; }
  ui.selected = -1;
  audio.draw();
  updateLegal();
  render();
}

function doUndo() {
  if (ui.busy || match.over) return;
  if (!match.undo()) { toast('tidak ada yang bisa dibatalkan', true); return; }
  ui.selected = -1;
  ui.wallColor = null;
  audio.undo();
  updateLegal();
  render();
}

function handleCellClick(r, c) {
  // Arming a wall: click a cell to mark it.
  if (ui.wallColor !== null) {
    if (!match.markWall(r, c, ui.wallColor)) {
      audio.invalid();
      toast('sel itu sudah terisi', true);
      return;
    }
    audio.wall();
    // Keep the colour armed so the player can immediately place the matching
    // tile; it auto-clears once the turn ends.
    updateLegal();
    render();
    return;
  }

  if (ui.selected < 0) {
    toast('pilih ubin dari tangan dulu', true);
    return;
  }

  const tile = currentTileAt(ui.selected);
  if (!tile) return;
  if (!match.board.canPlace(r, c, tile.edges)) {
    audio.invalid();
    toast('tidak cocok dengan tetangga', true);
    return;
  }

  const before = match.board.score(0);
  const idx = ui.selected;
  const wasWall = match.board.isWall(r, c);

  if (!match.playTile(idx, r, c, tile.edges, tile.variant)) {
    audio.invalid();
    return;
  }

  renderer.animate(r, c, 'place', wasWall ? ui.wallColor : -1);
  audio.place();
  if (wasWall) audio.wall();

  const after = match.board.score(0);
  for (const line of after.completed) {
    if (!before.completed.some((x) => x.line === line.line)) {
      audio.lineComplete(line.points);
      flashLine(line);
    }
  }

  ui.selected = -1;
  ui.rotations = [];
  ui.wallColor = null;
  afterTurn();
}

// ── turn flow ─────────────────────────────────────────────────────────────

async function afterTurn() {
  updateLegal();
  render();
  match.save();

  if (match.over) {
    setTimeout(() => showResult(), 420);
    return;
  }

  if (match.mode === MODE.HUMAN_VS_AI && match.turn === 1) {
    runAiTurn();
  } else if (match.mode === MODE.AI_VS_AI) {
    // Spectate: let the AI play itself, with a small delay so it is watchable.
    setTimeout(runAiTurn, 480);
  }
}

async function runAiTurn() {
  if (ui.busy || match.over) return;
  ui.busy = true;
  ui.thinking = true;
  ui.selected = -1;
  ui.wallColor = null;
  updateLegal();
  render();

  const result = await match.aiTurn();

  ui.thinking = false;
  ui.busy = false;

  if (result && result.kind === 'wall') {
    renderer.animate(result.r, result.c, 'wall', match.board.wallColor[result.r * 5 + result.c]);
  }
  if (match.over) {
    updateLegal();
    render();
    setTimeout(() => showResult(), 420);
    return;
  }

  updateLegal();
  render();
  if (match.mode === MODE.AI_VS_AI) setTimeout(runAiTurn, 480);
}

// ── screens ───────────────────────────────────────────────────────────────

function showScreen(name) {
  ui.screen = name;
  for (const [k, node] of Object.entries({
    title: el.screenTitle, help: el.screenHelp, over: el.screenOver, menu: el.screenMenu,
  })) {
    node.hidden = k !== name;
  }
  if (name === 'game') {
    el.canvas.focus?.();
    updateLegal();
    render();
  }
  if (name === 'menu' || name === 'title' || name === 'over') {
    renderBest();
  }
}

function startNew() {
  audio.resume();
  match = new Match({ mode: prefs.mode, difficulty: prefs.difficulty });
  Match.clearSave();
  ui.selected = -1;
  ui.rotations = [];
  ui.wallColor = null;
  ui.busy = false;
  showScreen('game');
  updateFoeName();
  updateLegal();
  render();
  if (match.mode === MODE.AI_VS_AI) setTimeout(runAiTurn, 500);
}

function continueSaved() {
  audio.resume();
  match = new Match({ mode: prefs.mode, difficulty: prefs.difficulty });
  if (!Match.loadInto(match)) {
    toast('simpanan rusak, mulai baru', true);
    startNew();
    return;
  }
  ui.selected = -1;
  ui.rotations = [];
  ui.wallColor = null;
  showScreen('game');
  updateFoeName();
  updateLegal();
  render();
  if (!match.over && (match.mode === MODE.AI_VS_AI || match.turn === 1)) setTimeout(runAiTurn, 400);
}

function toMenu() {
  match.save();
  el.btnContinue.hidden = false;
  showScreen('title');
}

function showResult() {
  const r = match.result;
  if (!r) return;

  const you = r.scores[0];
  const foe = r.scores[1];
  const won = r.winner === 0;
  const drew = r.winner === -1;
  const isAiAi = match.mode === MODE.AI_VS_AI;

  el.overTitle.textContent = isAiAi
    ? (drew ? 'SERI' : `${DIFFICULTY[prefs.difficulty].label} MENANG`)
    : (drew ? 'SERI' : won ? 'KAMU MENANG' : 'KAMU KALAH');
  el.overTitle.style.color = drew ? THEME.text : won ? '#2e9e5b' : THEME.accent;

  const reason = r.fullBoard
    ? 'Papan penuh.'
    : `${r.dead.length} sel terkunci — tidak ada ubin yang cocok lagi.`;
  el.overSub.textContent = reason;

  el.finalScores.innerHTML = `
    <div class="fside ${r.winner === 0 ? 'win' : ''}">
      <div class="fv">${you}</div>
      <div class="fn">${isAiAi ? 'AI A' : 'KAMU'}</div>
    </div>
    <div class="fmid">:</div>
    <div class="fside ${r.winner === 1 ? 'win' : ''}">
      <div class="fv">${foe}</div>
      <div class="fn">${isAiAi ? 'AI B' : el.foeName.textContent}</div>
    </div>`;

  const d = r.detail;
  const chips = d.completed.length
    ? `<div class="lines">${d.completed.map((c) =>
      `<span class="linechip" style="background:${COLOR_META[c.color].hex}">${COLOR_META[c.color].name} +${c.points}</span>`).join('')}</div>`
    : '<div class="brow"><span>garis selesai</span><b>0</b></div>';

  el.overBreakdown.innerHTML = `
    ${chips}
    <div class="brow"><span>sisa ubin di tangan</span><b>+${match.hands[0].length}</b></div>
    <div class="brow"><span>dinding belum garis</span><b>+${d.residual}</b></div>
    <div class="brow total"><span>TOTAL</span><b>${you}</b></div>`;

  if (!isAiAi) {
    const improved = saveBest({ score: you, lines: d.completed.length });
    if (improved) el.overSub.textContent += ' Rekor baru!';
  }

  const won_sound = isAiAi || won;
  if (won_sound && !drew) audio.win(); else audio.lose();

  match.save();
  showScreen('over');
}

// ── repaint ───────────────────────────────────────────────────────────────

function updateLegal() {
  ui.legalCells = new Set();
  if (match.over || ui.busy) return;

  if (ui.selected >= 0) {
    const tile = currentTileAt(ui.selected);
    if (tile) {
      for (const mv of match.legalMovesFor(ui.selected)) {
        if (ui.rotations[ui.selected] === 0) ui.legalCells.add(key(mv.r, mv.c));
      }
      if (ui.rotations[ui.selected] !== 0) {
        for (const mv of boardLegal(tile)) ui.legalCells.add(key(mv.r, mv.c));
      }
    }
  } else if (ui.wallColor !== null) {
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (match.board.isEmpty(r, c)) ui.legalCells.add(key(r, c));
      }
    }
  }
}

/** Legal cells for an arbitrary tile object, independent of hand indexing. */
function boardLegal(tile) {
  const out = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (match.board.canPlace(r, c, tile.edges)) out.push({ r, c });
    }
  }
  return out;
}

function refreshAll() {
  updateLegal();
  render();
}

function render() {
  renderTop();
  renderHand();
  renderTray();
  draw();
}

function renderTop() {
  const you = match.board.score(match.hands[0].length).total;
  const foe = match.board.score(match.hands[1].length).total;
  el.scoreYouVal.textContent = String(you);
  el.scoreFoeVal.textContent = String(foe);
  el.scoreYou.classList.toggle('active', match.turn === 0 && !match.over && ui.screen === 'game');
  el.scoreFoe.classList.toggle('active', match.turn === 1 && !match.over && ui.screen === 'game');
  el.thinking.hidden = !ui.thinking;
  el.btnUndo.disabled = match.undoStack.length === 0 || match.over || ui.busy;
}

function renderHand() {
  const hand = match.currentHand;
  el.hand.innerHTML = '';

  hand.forEach((tile, i) => {
    const card = document.createElement('div');
    card.className = 'tcard';
    if (ui.selected === i) card.classList.add('sel');
    if (ui.wallColor !== null) card.classList.add('dim');

    const cv = document.createElement('canvas');
    const px = 132;
    cv.width = px; cv.height = px;
    drawMiniTile(cv, currentTileAt(i));
    card.appendChild(cv);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    card.appendChild(idx);

    const deg = (ui.rotations[i] || 0) * 90;
    if (deg) {
      const rot = document.createElement('span');
      rot.className = 'rot';
      rot.textContent = `${deg}°`;
      card.appendChild(rot);
    }

    card.addEventListener('click', () => { audio.resume(); selectTile(i); });
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.selected = i; rotateSelected(1); });
    el.hand.appendChild(card);
  });
}

/** A tile rendered into a small standalone canvas for the tray. */
function drawMiniTile(cv, tile) {
  const ctx = cv.getContext('2d');
  const s = cv.width;
  ctx.clearRect(0, 0, s, s);

  ctx.fillStyle = THEME.boardBg;
  roundRect(ctx, 2, 2, s - 4, s - 4, s * 0.07);
  ctx.fill();

  if (!tile) return;

  const bandW = s * 0.16;
  for (let e = 0; e < 4; e++) {
    if (tile.edges[e] === NEUTRAL) continue;
    ctx.fillStyle = COLOR_META[tile.edges[e]].hex;
    const t = 3;
    if (e === 0) ctx.fillRect(t, t, s - t * 2, bandW);
    if (e === 1) ctx.fillRect(s - bandW - t, t, bandW, s - t * 2);
    if (e === 2) ctx.fillRect(t, s - bandW - t, s - t * 2, bandW);
    if (e === 3) ctx.fillRect(t, t, bandW, s - t * 2);
  }

  ctx.fillStyle = '#fbf7ec';
  ctx.fillRect(bandW + 1, bandW + 1, s - (bandW + 1) * 2, s - (bandW + 1) * 2);

  // Reuse the board renderer's motif code by drawing into the same context.
  renderer._drawPattern(ctx, tile, bandW, bandW, s - bandW * 2, motifOf(tile.edges));

  ctx.strokeStyle = 'rgba(27,58,107,0.55)';
  ctx.lineWidth = 2;
  roundRect(ctx, 2, 2, s - 4, s - 4, s * 0.07);
  ctx.stroke();
}

function motifOf(edges) {
  const counts = new Map();
  for (const e of edges) {
    if (e === NEUTRAL) continue;
    counts.set(e, (counts.get(e) || 0) + 1);
  }
  if (!counts.size) return THEME.boardEdge;
  let best = 0; let n = -1;
  for (const [k, v] of counts) if (v > n) { n = v; best = k; }
  return COLOR_META[best].hex;
}

function renderTray() {
  const humanTurn = match.mode === MODE.HUMAN_VS_AI && match.turn === 0 && !match.over && !ui.busy;

  if (match.over) {
    el.phase.textContent = 'SELESAI';
    el.phase.className = 'phase';
  } else if (ui.thinking) {
    el.phase.textContent = 'LAIN BERMAIN';
    el.phase.className = 'phase';
  } else if (match.mode === MODE.AI_VS_AI) {
    el.phase.textContent = match.turn === 0 ? 'GILIRAN AI A' : 'GILIRAN AI B';
    el.phase.className = 'phase';
  } else if (!humanTurn) {
    el.phase.textContent = 'MENUNGGU';
    el.phase.className = 'phase';
  } else if (ui.wallColor !== null) {
    el.phase.textContent = `DINDING ${COLOR_META[ui.wallColor].name}`;
    el.phase.className = 'phase wall';
  } else {
    el.phase.textContent = 'PASANG UBIN';
    el.phase.className = 'phase';
  }

  // Wall picker visibility
  el.wallTools.style.display = humanTurn && !match.over ? '' : 'none';
  el.wallSwatches.querySelectorAll('.swatch').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.color) === ui.wallColor);
  });
  el.cancelWall.hidden = !match.pendingWall;

  // Hints
  if (match.over) {
    el.hints.innerHTML = 'permainan selesai';
  } else if (match.mode === MODE.AI_VS_AI) {
    el.hints.innerHTML = 'mode tontonan - AI AIM vs AI B';
  } else if (!humanTurn) {
    el.hints.innerHTML = '<b>giliran lawan</b>';
  } else if (ui.wallColor !== null) {
    el.hints.innerHTML = match.pendingWall
      ? `dinding ditandai di <b>${match.pendingWall.r + 1},${match.pendingWall.c + 1}</b> — sekarang pasang ubin se warna <span class="warn">${COLOR_META[ui.wallColor].name}</span>`
      : 'klik sel kosong untuk menandai dinding';
  } else if (ui.selected >= 0) {
    const t = currentTileAt(ui.selected);
    const n = t ? boardLegal(t).length : 0;
    el.hints.innerHTML = n
      ? `<b>${n}</b> sel legal · klik kanan / <b>R</b> untuk memutar`
      : '<span class="warn">tidak ada sel yang cocok — putar ubin</span>';
  } else {
    el.hints.innerHTML = 'pilih ubin di tangan, atau tandai dinding dulu';
  }
}

function draw() {
  renderer.draw({
    board: match.board,
    legalCells: ui.legalCells,
    hoverMove: ui.hoverMove,
    wallColorPick: ui.wallColor,
    canMarkWall: ui.wallColor !== null,
    phase: 'wall',
    lineHints: match.lineProgress().map((l) => ({
      ...l,
      cells: lineCells(l),
    })),
  });
}

/** Cell indices for a line descriptor from Match.lineProgress(). */
function lineCells(l) {
  const n = 5;
  if (l.kind === 'row') return Array.from({ length: n }, (_, c) => l.index * n + c);
  if (l.kind === 'col') return Array.from({ length: n }, (_, r) => r * n + l.index);
  if (l.index === 0) return Array.from({ length: n }, (_, i) => i * n + i);
  return Array.from({ length: n }, (_, i) => i * n + (n - 1 - i));
}

/**
 * Re-measure the board on the next frame, coalescing bursts of resize events.
 * Measuring during the event itself is unreliable because the browser has not
 * necessarily reflowed the stage yet.
 */
let resizePending = false;
function scheduleResize() {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    renderer.resize();
    draw();
  });
}

let lastFrame = performance.now();
function loop(now) {
  // Keep animating only while a placement animation is settling.
  if (renderer.anim.size > 0) {
    for (const [k, a] of renderer.anim) {
      if (now - a.t > 320) renderer.anim.delete(k);
    }
    draw();
  }
  lastFrame = now;
  requestAnimationFrame(loop);
}

let flashTimer = null;
function flashLine(line) {
  const k = line.line;
  if (k.kind === 'row') renderer.animate(k.index, 0, 'line', line.color);
  else if (k.kind === 'col') renderer.animate(0, k.index, 'line', line.color);
  clearTimeout(flashTimer);
}

let toastTimer = null;
function toast(msg, warn = false) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.classList.toggle('warn', warn);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1500);
}

// Debug handle for headless verification.
window.__AZ = {
  renderer, ui, prefs, MODE, PHASE, HAND_SIZE, CELL,
  // `match` must be a live getter: `startNew`/`continueSaved` REPLACE the match
  // object, so a captured reference would silently point at a dead game and
  // every headless check would report an empty board forever.
  get match() { return match; },
  startNew, continueSaved, handleCellClick, selectTile, pickWallColor,
  rotateSelected, doUndo, drawTile, showScreen, render,
  get state() {
    return {
      screen: ui.screen,
      turn: match.turn,
      over: match.over,
      selected: ui.selected,
      wallColor: ui.wallColor,
      hand: match.currentHand.length,
      score: match.board.score(match.hands[0].length).total,
      foe: match.board.score(match.hands[1].length).total,
      filled: match.board.filledCount,
      legal: [...ui.legalCells],
    };
  },
};
