/**
 * WebAudio SFX, fully synthesized — no asset files.
 *
 * The palette is deliberately ceramic: short plucks for placement, a wooden
 * knock for a wall, a bright arpeggio when a line completes, and a low resolve
 * for the final scoring. All created lazily on the first user gesture so the
 * browser autoplay policy is respected.
 */

const STORAGE_KEY = 'minigames.azulejo.audio';

class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v !== null) this.enabled = v === '1';
    } catch { /* ignore */ }
  }

  /** Must be called from a user gesture. */
  resume() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    if (on) this.resume();
  }

  _env(node, { attack = 0.005, decay = 0.18, peak = 0.3 } = {}) {
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** Plucked ceramic tone. */
  tone(freq, { type = 'triangle', decay = 0.18, peak = 0.28, detune = 0, delay = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.detune.setValueAtTime(detune, t0);
    osc.connect(gain);
    gain.connect(this.master);
    this._env(gain, { decay, peak });
    osc.start(t0);
    osc.stop(t0 + decay + 0.08);
  }

  /** Short filtered noise for percussive layers. */
  noise({ decay = 0.12, peak = 0.16, freq = 1400, q = 1.2, delay = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.ceil(this.ctx.sampleRate * (decay + 0.05));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(freq, t0);
    filt.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    src.connect(filt); filt.connect(gain); gain.connect(this.master);
    src.start(t0);
  }

  // ── game events ──────────────────────────────────────────────────────────

  select() {
    this.tone(660, { type: 'sine', decay: 0.07, peak: 0.14 });
  }

  hover() {
    this.tone(440, { type: 'sine', decay: 0.04, peak: 0.06 });
  }

  rotate() {
    this.tone(520, { type: 'square', decay: 0.05, peak: 0.08 });
  }

  place() {
    this.tone(392, { type: 'triangle', decay: 0.2, peak: 0.24 });
    this.tone(587, { type: 'sine', decay: 0.26, peak: 0.14, delay: 0.02 });
    this.noise({ decay: 0.07, peak: 0.1, freq: 2200 });
  }

  wall() {
    this.tone(196, { type: 'sine', decay: 0.16, peak: 0.24 });
    this.noise({ decay: 0.1, peak: 0.14, freq: 420, q: 0.8 });
  }

  invalid() {
    this.tone(150, { type: 'sawtooth', decay: 0.14, peak: 0.12 });
  }

  lineComplete(points = 1) {
    // Rising arpeggio; brighter and longer the more valuable the line.
    const root = 523.25;
    const steps = Math.min(6, 2 + points);
    for (let i = 0; i < steps; i++) {
      this.tone(root * Math.pow(2, i / 6), {
        type: 'triangle', decay: 0.3, peak: 0.2, delay: i * 0.055,
      });
    }
  }

  undo() {
    this.tone(330, { type: 'sine', decay: 0.12, peak: 0.14 });
    this.tone(247, { type: 'sine', decay: 0.16, peak: 0.12, delay: 0.04 });
  }

  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone(f, { type: 'triangle', decay: 0.45, peak: 0.22, delay: i * 0.1 }));
  }

  lose() {
    const notes = [392, 349.23, 293.66, 246.94];
    notes.forEach((f, i) => this.tone(f, { type: 'sine', decay: 0.5, peak: 0.2, delay: i * 0.13 }));
  }

  draw() {
    this.noise({ decay: 0.09, peak: 0.1, freq: 3200, q: 0.6 });
  }
}

export const audio = new Audio();
