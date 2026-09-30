import { formatNumber, clamp } from './util.js';

/** All DOM reads/writes for the HUD live here so gameplay code stays clean. */
export class Hud {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      hitmarker: document.getElementById('hitmarker'),
      vignette: document.getElementById('vignette'),
      healFlash: document.getElementById('healFlash'),
      waveNum: document.getElementById('waveNum'),
      waveBar: document.getElementById('waveBar'),
      waveLeft: document.getElementById('waveLeft'),
      scoreVal: document.getElementById('scoreVal'),
      comboBox: document.getElementById('comboBox'),
      comboVal: document.getElementById('comboVal'),
      bestVal: document.getElementById('bestVal'),
      hpFill: document.getElementById('hpFill'),
      hpGhost: document.getElementById('hpGhost'),
      hpNum: document.getElementById('hpNum'),
      hpMax: document.getElementById('hpMax'),
      dashPip: document.getElementById('dashPip'),
      weaponBox: document.getElementById('weaponBox'),
      ammoMag: document.getElementById('ammoMag'),
      ammoRes: document.getElementById('ammoRes'),
      reloadBar: document.getElementById('reloadBar'),
      reloadFill: document.getElementById('reloadFill'),
      lowAmmo: document.getElementById('lowAmmo'),
      wpnMod: document.getElementById('wpnMod'),
      bossBar: document.getElementById('bossBar'),
      bossName: document.getElementById('bossName'),
      bossFill: document.getElementById('bossFill'),
      killfeed: document.getElementById('killfeed'),
    };
    this._lastHp = 100;
    this._damageTimer = 0;
  }

  show(on) { this.el.hud.hidden = !on; }

  setWave(n, killed, total) {
    this.el.waveNum.textContent = n;
    const frac = total ? killed / total : 0;
    this.el.waveBar.style.width = `${frac * 100}%`;
    this.el.waveLeft.textContent = total ? `${killed} / ${total} target` : 'incoming…';
  }

  setScore(score, best, combo, comboMult) {
    this.el.scoreVal.textContent = formatNumber(score);
    this.el.bestVal.textContent = formatNumber(best);
    const show = combo > 1;
    this.el.comboBox.hidden = !show;
    this.el.comboVal.textContent = `${combo}×`;
    this.el.comboBox.classList.toggle('hot', comboMult >= 3);
  }

  setHp(hp, maxHp) {
    const frac = clamp(hp / maxHp, 0, 1);
    this.el.hpFill.style.width = `${frac * 100}%`;
    this.el.hpGhost.style.width = `${frac * 100}%`;
    this.el.hpNum.textContent = Math.ceil(hp);
    this.el.hpMax.textContent = `/${maxHp}`;
    this.el.hpFill.parentElement.classList.toggle('low', frac < 0.3);
  }

  flashDamage(strength = 1) {
    this._damageTimer = 0.35 * strength;
  }

  flashHeal() {
    this.el.healFlash.style.opacity = '0.5';
    setTimeout(() => { this.el.healFlash.style.opacity = '0'; }, 140);
  }

  setAmmo(mag, magSize, reserve, reloading, reloadFrac) {
    this.el.ammoMag.textContent = mag;
    this.el.ammoRes.textContent = reserve;
    this.el.weaponBox.classList.toggle('empty', mag === 0);
    this.el.lowAmmo.hidden = !(mag <= Math.max(3, magSize * 0.2) && !reloading);
    this.el.reloadBar.hidden = !reloading;
    if (reloading) this.el.reloadFill.style.width = `${clamp(reloadFrac, 0, 1) * 100}%`;
  }

  setModText(txt) { this.el.wpnMod.textContent = txt || ''; }

  setDash(charges, max) {
    const pips = this.el.dashPip;
    const ready = charges > 0;
    pips.classList.toggle('cooling', !ready);
    pips.querySelector('i').style.opacity = ready ? '1' : '0.2';
  }

  setCrosshairSpread(px) {
    // px grows with recoil; arms move outward.
    const c = this.el.crosshair;
    c.querySelector('.ch-t').style.transform = `translateY(${-px}px)`;
    c.querySelector('.ch-b').style.transform = `translateY(${px}px)`;
    c.querySelector('.ch-l').style.transform = `translateX(${-px}px)`;
    c.querySelector('.ch-r').style.transform = `translateX(${px}px)`;
  }

  setCrosshairHot(on) {
    this.el.crosshair.classList.toggle('hot', on);
  }

  hitmark(kill = false) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'kill');
    void h.offsetWidth; // restart animation
    h.classList.add('show');
    if (kill) h.classList.add('kill');
  }

  setBoss(on, frac, name = 'SENTINEL PRIME') {
    this.el.bossBar.hidden = !on;
    if (on) {
      this.el.bossFill.style.width = `${clamp(frac, 0, 1) * 100}%`;
      this.el.bossName.textContent = name;
    }
  }

  killfeed(text, crit = false) {
    const item = document.createElement('div');
    item.className = 'kf-item' + (crit ? ' crit' : '');
    item.innerHTML = text;
    this.el.killfeed.prepend(item);
    // keep feed short
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => item.remove(), 2600);
  }

  update(dt) {
    if (this._damageTimer > 0) {
      this._damageTimer -= dt;
      this.el.vignette.style.opacity = Math.max(this._damageTimer, 0);
    } else if (this.el.vignette.style.opacity !== '0') {
      this.el.vignette.style.opacity = '0';
    }
  }
}
