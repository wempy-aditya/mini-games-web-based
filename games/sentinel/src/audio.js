/**
 * WebAudio sound effects, synthesised on the fly.
 *
 * No audio files ship with the game. Every sound is a short envelope over one or
 * two oscillators, which keeps the whole game a single self-contained folder and
 * makes the palette trivially tunable.
 */

const STORAGE_KEY = 'minigames.sentinel.audio';

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = this.load();
  }

  load() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
  }

  toggle() {
    this.enabled = !this.enabled;
    this.save();
    if (this.enabled) this.resume();
    return this.enabled;
  }

  /**
   * Browsers start the audio context suspended until a user gesture, so this
   * must be called from a click handler the first time.
   */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** One oscillator with an exponential decay envelope. */
  blip({ freq = 440, to = null, type = 'sine', dur = 0.12, gain = 0.5, delay = 0 }) {
    if (!this.enabled) return;
    const ctx = this.resume();
    if (!ctx) return;

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);

    // Ramp from 0 rather than starting at `gain`, otherwise every sound clicks.
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(amp);
    amp.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst, used for impacts. */
  noise({ dur = 0.16, gain = 0.35, freq = 900, q = 1 }) {
    if (!this.enabled) return;
    const ctx = this.resume();
    if (!ctx) return;

    const t0 = ctx.currentTime;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.value = gain;

    src.connect(filter);
    filter.connect(amp);
    amp.connect(this.master);
    src.start(t0);
  }

  // ── the game's palette ───────────────────────────────────────────────────

  build() {
    this.blip({ freq: 320, to: 480, type: 'square', dur: 0.1, gain: 0.28 });
  }

  place() {
    this.blip({ freq: 520, to: 700, type: 'triangle', dur: 0.11, gain: 0.3 });
  }

  denied() {
    this.blip({ freq: 190, to: 120, type: 'sawtooth', dur: 0.13, gain: 0.22 });
  }

  upgrade() {
    this.blip({ freq: 620, to: 900, type: 'triangle', dur: 0.14, gain: 0.3 });
    this.blip({ freq: 930, to: 1200, type: 'sine', dur: 0.12, gain: 0.18, delay: 0.07 });
  }

  sell() {
    this.blip({ freq: 400, to: 240, type: 'triangle', dur: 0.16, gain: 0.26 });
  }

  kill() {
    this.noise({ dur: 0.09, gain: 0.2, freq: 1500, q: 0.8 });
  }

  boom() {
    this.noise({ dur: 0.28, gain: 0.4, freq: 320, q: 0.5 });
    this.blip({ freq: 120, to: 46, type: 'sine', dur: 0.3, gain: 0.3 });
  }

  beam() {
    this.blip({ freq: 1500, to: 700, type: 'sawtooth', dur: 0.11, gain: 0.13 });
  }

  leak() {
    this.blip({ freq: 300, to: 90, type: 'sawtooth', dur: 0.36, gain: 0.32 });
    this.noise({ dur: 0.3, gain: 0.24, freq: 240, q: 0.4 });
  }

  waveStart() {
    [392, 494, 587].forEach((f, i) => {
      this.blip({ freq: f, type: 'triangle', dur: 0.18, gain: 0.24, delay: i * 0.09 });
    });
  }

  waveClear() {
    [587, 698, 880].forEach((f, i) => {
      this.blip({ freq: f, type: 'sine', dur: 0.2, gain: 0.24, delay: i * 0.1 });
    });
  }

  boss() {
    [110, 82, 65].forEach((f, i) => {
      this.blip({ freq: f, to: f * 0.85, type: 'sawtooth', dur: 0.5, gain: 0.3, delay: i * 0.14 });
    });
  }

  gameOver() {
    [440, 370, 294, 220].forEach((f, i) => {
      this.blip({ freq: f, to: f * 0.94, type: 'triangle', dur: 0.42, gain: 0.3, delay: i * 0.17 });
    });
  }

  victory() {
    [523, 659, 784, 1047].forEach((f, i) => {
      this.blip({ freq: f, type: 'sine', dur: 0.3, gain: 0.26, delay: i * 0.12 });
    });
  }
}
