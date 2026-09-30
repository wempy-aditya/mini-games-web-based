// WebAudio SFX — fully synthesized, no asset files.
// Created lazily on first user gesture so autoplay policy never blocks it.

const STORAGE_KEY = 'minigames.neonbreach.audio';

class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuf = null;
    this.lastPlay = new Map();
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    try {
      this.ctx = new AC();
    } catch { this.enabled = false; return; }

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.34;
    this.master.connect(this.ctx.destination);

    // Shared 1s white-noise buffer for percussive sounds.
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    if (this.master) this.master.gain.value = on ? 0.34 : 0;
  }

  loadPref() {
    this.enabled = localStorage.getItem(STORAGE_KEY) !== '0';
  }

  /** Rate-limit a sound id so rapid triggers don't stack into clipping. */
  _throttle(id, ms) {
    const now = performance.now();
    const prev = this.lastPlay.get(id) || 0;
    if (now - prev < ms) return false;
    this.lastPlay.set(id, now);
    return true;
  }

  _tone({ type = 'sine', f0, f1, dur, gain = 0.3, delay = 0, curve = 'exp' }) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
      else osc.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.008, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.12, gain = 0.3, hp = 200, lp = 6000, delay = 0, sweepTo = null }) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hpF = this.ctx.createBiquadFilter();
    hpF.type = 'highpass';
    hpF.frequency.setValueAtTime(hp, t);
    const lpF = this.ctx.createBiquadFilter();
    lpF.type = 'lowpass';
    lpF.frequency.setValueAtTime(lp, t);
    if (sweepTo) lpF.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 40), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hpF).connect(lpF).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // ── game sounds ──

  shoot() {
    if (!this._throttle('shoot', 28)) return;
    this._tone({ type: 'square', f0: 220, f1: 70, dur: 0.08, gain: 0.16 });
    this._noise({ dur: 0.07, gain: 0.13, hp: 900, lp: 5200, sweepTo: 900 });
  }

  shootHeavy() {
    if (!this._throttle('shoot', 40)) return;
    this._tone({ type: 'sawtooth', f0: 130, f1: 45, dur: 0.16, gain: 0.22 });
    this._noise({ dur: 0.13, gain: 0.2, hp: 500, lp: 3400, sweepTo: 400 });
  }

  hit(crit = false) {
    if (!this._throttle('hit', 20)) return;
    this._tone({ type: 'triangle', f0: crit ? 1500 : 950, f1: crit ? 700 : 480, dur: 0.055, gain: crit ? 0.15 : 0.1 });
  }

  kill() {
    this._tone({ type: 'sawtooth', f0: 420, f1: 120, dur: 0.16, gain: 0.14 });
    this._noise({ dur: 0.22, gain: 0.16, hp: 300, lp: 2600, sweepTo: 300 });
  }

  explode() {
    this._noise({ dur: 0.5, gain: 0.3, hp: 60, lp: 1800, sweepTo: 120 });
    this._tone({ type: 'sine', f0: 160, f1: 34, dur: 0.42, gain: 0.24 });
  }

  hurt() {
    this._tone({ type: 'sawtooth', f0: 260, f1: 90, dur: 0.2, gain: 0.2 });
    this._noise({ dur: 0.16, gain: 0.14, hp: 200, lp: 1400 });
  }

  reloadClick() { this._tone({ type: 'square', f0: 700, f1: 400, dur: 0.04, gain: 0.1 }); }
  reloadDone() { this._tone({ type: 'square', f0: 500, f1: 900, dur: 0.07, gain: 0.11 }); }

  dash() {
    this._noise({ dur: 0.2, gain: 0.13, hp: 700, lp: 3200, sweepTo: 5200 });
  }

  pickup() {
    this._tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.1, gain: 0.13 });
    this._tone({ type: 'sine', f0: 1320, f1: 1760, dur: 0.12, gain: 0.09, delay: 0.06 });
  }

  waveStart(n) {
    this._tone({ type: 'square', f0: 300, f1: 600, dur: 0.14, gain: 0.11 });
    this._tone({ type: 'square', f0: 600, f1: 900, dur: 0.2, gain: 0.09, delay: 0.12 });
  }

  waveClear() {
    [0, 4, 7, 12].forEach((semi, i) => {
      const f = 523.25 * Math.pow(2, semi / 12);
      this._tone({ type: 'triangle', f0: f, f1: f, dur: 0.4, gain: 0.11, delay: i * 0.09 });
    });
  }

  bossSpawn() {
    this._tone({ type: 'sawtooth', f0: 90, f1: 42, dur: 1.1, gain: 0.24 });
    this._noise({ dur: 1.0, gain: 0.14, hp: 40, lp: 900 });
  }

  upgrade() {
    this._tone({ type: 'sine', f0: 660, f1: 990, dur: 0.1, gain: 0.12 });
    this._tone({ type: 'sine', f0: 990, f1: 1480, dur: 0.16, gain: 0.1, delay: 0.08 });
  }

  gameOver() {
    this._tone({ type: 'sawtooth', f0: 220, f1: 40, dur: 1.4, gain: 0.22 });
    this._noise({ dur: 1.3, gain: 0.12, hp: 50, lp: 700, sweepTo: 90 });
  }

  uiClick() { this._tone({ type: 'square', f0: 1100, f1: 1400, dur: 0.035, gain: 0.07 }); }
}

export const audio = new Audio();
