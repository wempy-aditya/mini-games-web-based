// Snake — vanilla canvas, no dependencies.
// Grid-based, fixed-step tick so speed changes never alter the simulation.
(() => {
  'use strict';

  const COLS = 20;
  const ROWS = 20;
  const BASE_TICK_MS = 150;
  const MIN_TICK_MS = 60;
  const SPEED_STEP_MS = 4;
  const STORAGE_KEY = 'minigames.snake.best';

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const KEY_DIRS = {
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
  };

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const levelEl = document.getElementById('level');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlay-text');

  const cell = canvas.width / COLS;

  let snake, dir, queuedDir, food, score, best, tickMs, timer, running, dead;

  best = Number(localStorage.getItem(STORAGE_KEY)) || 0;
  bestEl.textContent = best;

  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = DIRS.right;
    queuedDir = DIRS.right;
    score = 0;
    tickMs = BASE_TICK_MS;
    dead = false;
    placeFood();
    syncHud();
  }

  function placeFood() {
    const open = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!snake.some((s) => s.x === x && s.y === y)) open.push({ x, y });
      }
    }
    food = open.length ? open[Math.floor(Math.random() * open.length)] : null;
  }

  function syncHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    levelEl.textContent = Math.floor(score / 5) + 1;
  }

  function step() {
    // Apply at most one buffered turn per tick: kills the 180-degree flip exploit.
    dir = queuedDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
    const hitSelf = snake.some((s, i) => i < snake.length - 1 && s.x === head.x && s.y === head.y);
    if (hitWall || hitSelf) return die();

    snake.unshift(head);
    if (food && head.x === food.x && head.y === food.y) {
      score += 1;
      const nextTick = Math.max(MIN_TICK_MS, tickMs - SPEED_STEP_MS);
      if (nextTick !== tickMs) {
        tickMs = nextTick;
        restartTimer();
      }
      placeFood();
    } else {
      snake.pop();
    }
    syncHud();
  }

  function die() {
    dead = true;
    stopTimer();
    if (score > best) {
      best = score;
      localStorage.setItem(STORAGE_KEY, String(best));
    }
    syncHud();
    showOverlay(`Game over — skor ${score}. Tekan Spasi untuk main lagi`);
    draw();
  }

  function showOverlay(text) {
    overlayText.textContent = text;
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
  }

  function restartTimer() {
    stopTimer();
    timer = setInterval(step, tickMs);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function start() {
    reset();
    hideOverlay();
    running = true;
    restartTimer();
    draw();
  }

  function togglePause() {
    if (dead) return start();
    if (running) {
      stopTimer();
      running = false;
      showOverlay('Jeda — tekan Spasi untuk lanjut');
    } else {
      restartTimer();
      running = true;
      hideOverlay();
    }
    draw();
  }

  function turn(name) {
    const next = DIRS[name];
    if (!next) return;
    // Reject reversal against the direction currently queued.
    if (next.x === -queuedDir.x && next.y === -queuedDir.y) return;
    queuedDir = next;
  }

  function draw() {
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < COLS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell + 0.5, 0);
      ctx.lineTo(i * cell + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let i = 1; i < ROWS; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * cell + 0.5);
      ctx.lineTo(canvas.width, i * cell + 0.5);
      ctx.stroke();
    }

    if (food) {
      ctx.fillStyle = '#e8785d';
      roundRect(food.x * cell + 3, food.y * cell + 3, cell - 6, cell - 6, 4);
      ctx.fill();
    }

    snake.forEach((seg, i) => {
      const t = i === 0 ? 1 : 0.78 - Math.min(i, 12) * 0.02;
      ctx.fillStyle = i === 0 ? '#a6e9c3' : `rgba(125,211,160,${Math.max(t, 0.35)})`;
      roundRect(seg.x * cell + 1.5, seg.y * cell + 1.5, cell - 3, cell - 3, 3);
      ctx.fill();
    });
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Swipe support (single-step per gesture on touch devices).
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 'right' : 'left');
    else turn(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const dirName = KEY_DIRS[e.key];
    if (dirName) {
      e.preventDefault();
      if (!running) start();
      turn(dirName);
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      start();
    }
  });

  overlay.addEventListener('click', () => (running ? togglePause() : start()));
  canvas.addEventListener('click', () => { if (!running) start(); });

  document.querySelectorAll('.touch button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!running) start();
      turn(btn.dataset.dir);
    });
  });

  reset();
  showOverlay('Tekan Spasi atau tap untuk mulai');
  draw();
})();
