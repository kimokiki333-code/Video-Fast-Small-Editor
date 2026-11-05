/* Make it Fast Edit Arsenal — tiny 2D ambient background.
   A few drifting embers and one faint rotating wireframe ring. 20 fps, half
   resolution, plain Canvas 2D. No WebGL, no Three.js, no shaders, no particles
   system. Stops while media plays or the tab is hidden. */
(() => {
  const canvas = document.getElementById('storm-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) { canvas.style.display = 'none'; return; }

  const SCALE = .5;
  const FPS = 20;
  const EMBER_COUNT = 7;
  let w = 1, h = 1, timer = 0, running = false, frames = 0;
  let hidden = document.hidden;
  let mediaPlaying = false;
  let angle = 0;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const embers = Array.from({ length: EMBER_COUNT }, (_, i) => ({
    x: rnd(.05, .95), y: rnd(.05, .95), r: rnd(.7, 1.8),
    vy: rnd(.0006, .0018), drift: rnd(-.0005, .0005), phase: rnd(0, 6.28), i
  }));

  function resize() {
    w = Math.max(1, Math.floor(window.innerWidth * SCALE));
    h = Math.max(1, Math.floor(window.innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    draw();
  }

  function drawRing() {
    const cx = w * .5, cy = h * .48;
    const radius = Math.min(w, h) * .34;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(0,229,255,.075)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 36; i++) {
      const a = i / 36 * Math.PI * 2;
      const x = Math.cos(a) * radius, y = Math.sin(a) * radius * .38;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(182,255,60,.045)';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * radius * .82, Math.sin(a) * radius * .31);
      ctx.lineTo(Math.cos(a + .18) * radius, Math.sin(a + .18) * radius * .38);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    drawRing();
    for (const e of embers) {
      e.y -= e.vy;
      e.x += Math.sin(e.phase + frames * .012) * e.drift;
      if (e.y < -.02) { e.y = 1.02; e.x = rnd(.05, .95); }
      if (e.x < -.02) e.x = 1.02;
      if (e.x > 1.02) e.x = -.02;
      const x = e.x * w, y = e.y * h;
      const alpha = .16 + .14 * Math.sin(e.phase + frames * .035) ** 2;
      ctx.fillStyle = e.i % 3 === 0 ? `rgba(255,61,139,${alpha})` : `rgba(182,255,60,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, e.r, 0, Math.PI * 2);
      ctx.fill();
    }
    frames++;
  }

  function tick() { draw(); }

  function start() {
    if (running || hidden || mediaPlaying) return;
    running = true;
    timer = setInterval(tick, Math.round(1000 / FPS));
    tick();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    timer = 0;
  }

  function setMediaPlaying(value) {
    mediaPlaying = !!value;
    if (mediaPlaying) stop(); else start();
  }

  function bindMedia() {
    document.querySelectorAll('video,audio').forEach(el => {
      if (el.__mvsBgBound) return;
      el.__mvsBgBound = true;
      const sync = () => setMediaPlaying([...document.querySelectorAll('video,audio')].some(m => !m.paused && !m.ended));
      el.addEventListener('play', sync);
      el.addEventListener('pause', sync);
      el.addEventListener('ended', sync);
    });
  }

  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    if (hidden) stop(); else start();
  });
  bindMedia();
  if (typeof MutationObserver !== 'undefined') new MutationObserver(bindMedia).observe(document.body, { childList: true, subtree: true });
  resize();
  start();

  window.__MVS_BG__ = {
    state: () => ({ context: '2d', fps: FPS, scale: SCALE, running, frames, width: w, height: h, hidden, mediaPlaying }),
    setMediaPlaying, start, stop, draw
  };
  window.__MVS_STORM__ = window.__MVS_BG__;
})();
