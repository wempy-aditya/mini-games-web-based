// Input: keyboard + mouse-look with pointer-lock, plus a keyboard-only
// fallback so the game stays playable where pointer lock is unavailable
// (headless verification, kiosk, some embeds).
//
// Key split matters: WASD moves, arrow keys look. Folding arrows into the
// move map would make the keyboard-look fallback impossible.

const MOVE_KEYS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
};
const LOOK_KEYS = {
  ArrowUp: 'lookUp', ArrowDown: 'lookDown',
  ArrowLeft: 'lookLeft', ArrowRight: 'lookRight',
};
const ACTION_KEYS = {
  Space: 'jump',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyR: 'reload',
  Escape: 'pause',
  Enter: 'confirm',
  Digit1: 'pick1', Digit2: 'pick2', Digit3: 'pick3',
  Numpad1: 'pick1', Numpad2: 'pick2', Numpad3: 'pick3',
};

const ALL = { ...MOVE_KEYS, ...LOOK_KEYS, ...ACTION_KEYS };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.held = new Set();
    this.pressed = new Set();
    this.mouseDown = false;
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = false;
    this.keyboardLookRate = 2.8; // rad/s
    this.onPause = null;
    this.onConfirm = null;
    this.onPick = null;
    this.onLockChange = null;
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      const action = ALL[e.code];
      if (!action) return;
      e.preventDefault();
      if (e.repeat) return;
      this.held.add(action);
      this.pressed.add(action);

      if (action === 'pause') this.onPause?.();
      // Space doubles as menu-confirm; harmless while playing (no-op there).
      if (action === 'confirm' || action === 'jump') this.onConfirm?.();
      if (action.startsWith('pick')) this.onPick?.(Number(action.slice(4)) - 1);
    });

    window.addEventListener('keyup', (e) => {
      const action = ALL[e.code];
      if (!action) return;
      e.preventDefault();
      this.held.delete(action);
    });

    // Losing focus must not leave keys stuck down.
    window.addEventListener('blur', () => {
      this.held.clear();
      this.mouseDown = false;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (!this.locked && this.enabled) this.requestLock();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDx += e.movementX || 0;
      this.mouseDy += e.movementY || 0;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this.onLockChange?.(false);
    });
  }

  requestLock() {
    if (this.locked || !this.enabled) return;
    if (!this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      // Chrome 113+ returns a promise that rejects if called right after exit.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* stay in keyboard-look mode */ }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(action) { return this.held.has(action); }
  justPressed(action) { return this.pressed.has(action); }

  /**
   * Look delta for this frame in radians.
   * Mouse only counts while pointer-locked; arrow keys always work, which is
   * what makes the game playable without pointer lock.
   */
  lookDelta(dt) {
    let yaw = this.mouseDx * this.sensitivity;
    let pitch = this.mouseDy * this.sensitivity * (this.invertY ? -1 : 1);

    const kb = this.keyboardLookRate * dt;
    if (this.down('lookLeft')) yaw += kb;
    if (this.down('lookRight')) yaw -= kb;
    if (this.down('lookUp')) pitch -= kb;
    if (this.down('lookDown')) pitch += kb;

    return { yaw, pitch };
  }

  /** Consume per-frame edges and accumulated deltas. Call once per frame. */
  endFrame() {
    this.pressed.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
  }
}
