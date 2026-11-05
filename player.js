/* Make it Fast Edit Arsenal — lightweight preview renderer.
   Normal resolution (DPR 1), 25 fps only while media is playing, and a single
   redraw on seek / edit / resize / drag when paused. No WebGL, no per-frame DOM
   rebuild, no double-resolution buffers. */
export class LightPreview {
  constructor({ video, image, frame, stage, getState, getProject }) {
    this.canvas = document.getElementById('light-preview');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.ctx) return;
    this.video = video;
    this.image = image;
    this.frame = frame;
    this.stage = stage;
    this.getState = getState;
    this.getProject = getProject;
    this.dpr = 1;
    this.fps = 25;
    this.frames = 0;
    this.running = false;
    this.timer = 0;
    this.dirty = true;
    this.hidden = document.hidden;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'low';
    this.frame.classList.add('light-preview-on');
    this.resize();
    this.attach();
    this.draw();
    window.__MVS_PLAYER__ = this;
  }

  get mode() { return this.getState?.().mode || 'video'; }
  get sourceEl() { return this.mode === 'audio' ? this.image : this.video; }

  resize() {
    if (!this.canvas || !this.frame) return;
    const rect = this.frame.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    if (!this.running) this.draw();
  }

  setMode() { this.markDirty(); }

  start() {
    if (this.running || this.hidden) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), Math.round(1000 / this.fps));
    this.tick();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = 0;
    this.draw();
  }

  tick() { this.draw(); }

  draw() {
    if (!this.ctx || !this.canvas) return;
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    const el = this.sourceEl;
    const p = this.getProject?.();
    if (!el || !el.getAttribute('src') || !p) { this.frames++; this.dirty = false; return; }
    const sw = el.videoWidth || el.naturalWidth || w;
    const sh = el.videoHeight || el.naturalHeight || h;
    const scale = Math.min(w / Math.max(1, sw), h / Math.max(1, sh));
    const dw = Math.max(1, sw * scale), dh = Math.max(1, sh * scale);
    const t = p.transform || { rotate: 0, flipH: false, flipV: false };
    const c = p.color || { brightness: 0, contrast: 1, saturation: 1 };
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((Number(t.rotate) || 0) * Math.PI / 180);
    ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
    ctx.filter = `brightness(${Math.max(.5, Math.min(1.6, 1 + (Number(c.brightness) || 0)))}) contrast(${Number(c.contrast) || 1}) saturate(${Number(c.saturation) ?? 1})`;
    try { ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh); } catch (_) { /* frame not ready */ }
    ctx.restore();
    ctx.filter = 'none';
    this.frames++;
    this.dirty = false;
  }

  attach() {
    const sync = () => {
      const playing = [...document.querySelectorAll('video,audio')].some(el => !el.paused && !el.ended);
      if (playing && !this.hidden) this.start(); else this.stop();
    };
    [...document.querySelectorAll('video,audio')].forEach(el => {
      el.addEventListener('play', sync);
      el.addEventListener('pause', sync);
      el.addEventListener('ended', sync);
      el.addEventListener('seeked', () => this.markDirty());
      el.addEventListener('loadeddata', () => this.markDirty());
      el.addEventListener('loadedmetadata', () => this.markDirty());
    });
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (this.hidden) this.stop(); else sync();
    });
    window.addEventListener('resize', () => this.resize(), { passive: true });
    if (typeof ResizeObserver !== 'undefined' && this.frame) new ResizeObserver(() => this.resize()).observe(this.frame);
  }

  state() {
    return {
      context: '2d', dpr: this.dpr, fps: this.fps, running: this.running,
      frames: this.frames, width: this.canvas?.width || 0, height: this.canvas?.height || 0,
      hidden: this.hidden, dirty: this.dirty
    };
  }
}
