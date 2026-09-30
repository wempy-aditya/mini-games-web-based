import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { buildArena, updateArena, ARENA_HALF } from './arena.js';
import { Player } from './player.js';
import { Fx } from './fx.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Game } from './game.js';
import { drawCards, applyCard } from './upgrades.js';
import { audio } from './audio.js';
import { clamp, formatNumber } from './util.js';

const BEST_KEY = 'minigames.neonbreach.best';
const canvas = document.getElementById('scene');

// ── renderer / scene / camera ──
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.5;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 300);

// ── systems ──
const arena = buildArena(scene, renderer);
const fx = new Fx(scene);
const player = new Player(scene, arena, camera);
const hud = new Hud();
const input = new Input(canvas);
const game = new Game({ scene, camera, player, arena, fx, hud });

// ── post-processing ──
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Bloom was 1.05 which blew out the core light into a screen-wide glare.
// 0.62 keeps the neon glow without blinding the player.
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.62, 0.7, 0.78);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ── DOM refs ──
const screens = {
  title: document.getElementById('screenTitle'),
  controls: document.getElementById('screenControls'),
  clear: document.getElementById('screenClear'),
  pause: document.getElementById('screenPause'),
  over: document.getElementById('screenOver'),
};
const loading = document.getElementById('loading');
const best = Number(localStorage.getItem(BEST_KEY)) || 0;

// ── app state machine ──
let appState = 'title'; // title | controls | playing | clear | pause | over
let countdownTimer = null;
let countdownLeft = 0;
let pendingCards = [];

function setAppState(s) {
  appState = s;
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== s;
  hud.show(s === 'playing' || s === 'clear' || s === 'pause');
  document.body.classList.toggle('playing', s === 'playing');

  if (s === 'playing') {
    input.enabled = true;
    input.requestLock();
  } else {
    input.enabled = false;
    input.exitLock();
  }
  // The viewmodel only belongs in the live FPS view — not on menus, pause or
  // the upgrade screen, where the camera is repurposed.
  if (player.gun) player.gun.visible = (s === 'playing');
  audio.resume();
}

// ── title best display ──
function refreshTitleStats() {
  document.getElementById('titleBest').textContent = formatNumber(best);
  const last = JSON.parse(localStorage.getItem('minigames.neonbreach.last') || 'null');
  document.getElementById('titleWave').textContent = last ? last.wave : '—';
  document.getElementById('titleKills').textContent = last ? last.kills : '—';
}
refreshTitleStats();

// ── buttons ──
document.getElementById('btnPlay').onclick = () => { audio.resume(); audio.uiClick(); startRun(); };
document.getElementById('btnControls').onclick = () => { audio.uiClick(); setAppState('controls'); };
document.getElementById('btnControlsBack').onclick = () => { audio.uiClick(); setAppState('title'); };
document.getElementById('btnResume').onclick = () => { audio.uiClick(); setAppState('playing'); };
document.getElementById('btnQuit').onclick = () => { audio.uiClick(); endToTitle(); };
document.getElementById('btnRetry').onclick = () => { audio.uiClick(); startRun(); };
document.getElementById('btnMenu').onclick = () => { audio.uiClick(); endToTitle(); };

function startRun() {
  game.startRun();
  setAppState('playing');
  syncHud();
}

function endToTitle() {
  game.state = 'idle';
  game.enemies.forEach((e) => e.dispose(scene));
  game.enemies = [];
  player.reset();
  refreshTitleStats();
  setAppState('title');
}

function saveRun() {
  const acc = Math.round(player.accuracy * 100);
  localStorage.setItem('minigames.neonbreach.last', JSON.stringify({
    wave: game.wave, score: game.score, kills: player.kills, acc,
  }));
  if (game.score > best) {
    best = game.score;
    localStorage.setItem(BEST_KEY, String(best));
  }
}

// ── global input hooks ──
input.onPause = () => {
  if (appState === 'playing') {
    // pause
    renderPauseStats();
    setAppState('pause');
  } else if (appState === 'pause') {
    setAppState('playing');
  }
};
input.onConfirm = () => {
  if (appState === 'title') startRun();
  else if (appState === 'over') startRun();
  else if (appState === 'clear') pickCard(0); // Enter picks first as default
};
input.onPick = (i) => {
  if (appState === 'clear') pickCard(i);
};

// Pointer-lock loss during play → auto-pause so you don't die while alt-tabbed.
// In headless there's no real pointer lock, so skip auto-pause or it would
// immediately bounce to the pause screen during verification.
const isHeadless = /HeadlessChrome/.test(navigator.userAgent);

input.onLockChange = (locked) => {
  if (!locked && appState === 'playing' && !isHeadless) {
    renderPauseStats();
    setAppState('pause');
  }
};

// ── intermission / upgrade cards ──
function showClear() {
  pendingCards = drawCards(game.run, 3);
  const waveNum = document.getElementById('clearWave');
  const kills = document.getElementById('clearKills');
  const score = document.getElementById('clearScore');
  const acc = document.getElementById('clearAcc');
  waveNum.textContent = game.wave;
  kills.textContent = player.kills;
  score.textContent = formatNumber(game.score);
  acc.textContent = `${Math.round(player.accuracy * 100)}%`;

  const cardsEl = document.getElementById('cards');
  cardsEl.innerHTML = '';
  pendingCards.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'card-pick';
    el.innerHTML = `
      <div class="card-key">${i + 1}</div>
      <div class="card-ico">${card.icon}</div>
      <div class="card-name">${card.name}</div>
      <div class="card-desc">${card.desc}</div>
      <div class="card-tag">${card.tag}</div>`;
    el.onclick = () => pickCard(i);
    cardsEl.appendChild(el);
  });

  setAppState('clear');
  startCountdown(10);
}

function pickCard(i) {
  if (appState !== 'clear' || !pendingCards[i]) return;
  audio.upgrade();
  applyCard(game.run, player, pendingCards[i]);
  // reflect immediately in HUD
  player.mag = Math.min(player.mag, player.magSize);
  clearCountdown();
  game.resumeFromIntermission();
  setAppState('playing');
  syncHud();
}

function startCountdown(sec) {
  clearCountdown();
  countdownLeft = sec;
  const el = document.getElementById('countdown');
  const num = document.getElementById('countdownNum');
  el.hidden = false;
  num.textContent = countdownLeft;
  countdownTimer = setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft <= 0) {
      clearCountdown();
      pickCard(0); // auto-pick first
      return;
    }
    num.textContent = countdownLeft;
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  document.getElementById('countdown').hidden = true;
}

// ── pause stats ──
function renderPauseStats() {
  const el = document.getElementById('pauseStats');
  el.innerHTML = `
    <div>wave<b>${game.wave}</b></div>
    <div>score<b>${formatNumber(game.score)}</b></div>
    <div>kill<b>${player.kills}</b></div>`;
}

// ── game over screen ──
function showGameOver() {
  saveRun();
  const sub = document.getElementById('overSub');
  sub.textContent = `core collapsed on wave ${game.wave}`;
  const stats = document.getElementById('overStats');
  const acc = Math.round(player.accuracy * 100);
  stats.innerHTML = `
    <div class="ost hi"><span>skor</span><b>${formatNumber(game.score)}</b></div>
    <div class="ost"><span>terbaik</span><b>${formatNumber(best)}</b></div>
    <div class="ost"><span>wave</span><b>${game.wave}</b></div>
    <div class="ost"><span>kill</span><b>${player.kills}</b></div>
    <div class="ost"><span>akurasi</span><b>${acc}%</b></div>
    <div class="ost"><span>headshot</span><b>${player.headshots}</b></div>
    <div class="ost"><span>dash</span><b>${player.dashUsed}</b></div>
    <div class="ost boss"><span>boss</span><b>${game.wave >= 5 ? 'reached' : '—'}</b></div>`;
  const mods = document.getElementById('runMods');
  mods.innerHTML = game.run.mods.map((m) => `<span class="mod-chip">${m.name}</span>`).join('');
  clearCountdown();
  setAppState('over');
}

// ── HUD sync (called on state changes, not every frame) ──
function syncHud() {
  hud.setWave(game.wave, game.waveKilled, game.waveTotal);
  hud.setHp(player.hp, player.maxHp);
  hud.setAmmo(player.mag, player.magSize, player.reserve, player.reloading, 0);
  hud.setDash(player.dashCharges, 1 + player.extraDash);
  hud.setScore(game.score, best, game.combo, game.comboMult);
  const modBits = [];
  if (player.pierce > 0) modBits.push(`PIERCE ${player.pierce}`);
  if (player.critChance > 0.2) modBits.push(`CRIT ${Math.round(player.critChance * 100)}%`);
  hud.setModText(modBits.join(' · '));
}

// ── fire held state ──
input.canvas.addEventListener('mousedown', () => { game.fireHeld = true; });
addEventListener('mouseup', () => { game.fireHeld = false; });
// also allow auto-fire via holding 'confirm'? no — mouse only.

// ── main loop ──
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  // clamp dt so tab-switch / breakpoint never teleports entities
  dt = Math.min(dt, 0.05);
  const t = now / 1000;

  updateArena(arena, t, dt);

  if (appState === 'playing') {
    game.fireHeld = input.mouseDown;
    if (input.justPressed('reload')) player.startReload();
    player.update(dt, input, arena);
    player.updateWeapon(dt);
    game.update(dt);
    // per-frame HUD that must be live
    hud.setHp(player.hp, player.maxHp);
    hud.setAmmo(player.mag, player.magSize, player.reserve, player.reloading,
      player.reloading ? player.reloadT / player.reloadTime : 0);
    hud.setDash(player.dashCharges, 1 + player.extraDash);
    hud.setScore(game.score, best, game.combo, game.comboMult);
    hud.setBoss(!!game.boss, game.boss ? game.boss.hp / game.boss.maxHp : 0);
    hud.setWave(game.wave, game.waveKilled, game.waveTotal);

    // wave clear / game over transitions
    if (game.state === 'intermission' && appState === 'playing') showClear();
    if (game.state === 'over' && appState === 'playing') showGameOver();
  } else if (appState === 'title' || appState === 'over' || appState === 'controls') {
    // slow orbit camera behind the title/over menus
    const r = 26;
    const a = t * 0.12;
    camera.position.set(Math.cos(a) * r, 9, Math.sin(a) * r);
    camera.lookAt(0, 3, 0);
    // No weapon in menu view — the orbit shot is a flyaround, not a FPS view.
    player.gun.visible = false;
  }

  fx.update(dt);
  hud.update(dt);
  input.endFrame();

  composer.render();
}

// ── boot ──
document.getElementById('loading').classList.add('done');
setTimeout(() => loading.remove(), 500);
setAppState('title');
requestAnimationFrame(frame);

// Debug/verification handle. Harmless in production and much easier to test
// headless than poking at internals from the outside.
window.__NB = { game, player, arena, fx, hud, input, renderer, scene, camera,
  get appState() { return appState; },
  setAppState, startRun, pickCard };
