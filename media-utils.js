/* Canvas, timecode and media helpers for Make it Fast Edit Arsenal. */
export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(+n) ? +n : min));
export const even = n => Math.max(2, Math.round((Number(n) || 2) / 2) * 2);
export const snapEven = n => Math.max(0, Math.round((Number(n) || 0) / 2) * 2);

export function formatTime(seconds, withMs = true) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const base = h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.min(999, ms)).padStart(3, '0')}` : base;
}

export function parseTime(value, fallback = 0) {
  const raw = String(value ?? '').trim().toLowerCase().replace(',', '.');
  if (!raw || raw === 'end') return NaN;
  if (/^\d*\.?\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return Number.isFinite(fallback) ? fallback : 0;
  const nums = parts.map(v => Number(v));
  if (nums.some(n => !Number.isFinite(n))) return fallback;
  if (parts.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

export function safeName(name, fallback = 'media') {
  return String(name || fallback).replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || fallback;
}

export function extensionOf(file, fallback = '.bin') {
  const name = file?.name || '';
  const match = name.toLowerCase().match(/(\.[a-z0-9]{1,6})$/);
  return match ? match[1] : fallback;
}

export function prettyBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export async function fileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export function blobToFile(blob, name) {
  return new File([blob], name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
}

export async function loadImage(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const ownsURL = typeof source !== 'string';
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    if (ownsURL) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export const FONT_STACKS = {
  space: '"Space Grotesk", Inter, sans-serif',
  inter: 'Inter, system-ui, sans-serif',
  arabic: '"Noto Sans Arabic", Inter, sans-serif',
  mono: '"SFMono-Regular", Consolas, monospace'
};

function wrapLines(ctx, text, maxWidth) {
  const result = [];
  const paragraphs = String(text || '').split('\n');
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { result.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else { result.push(line); line = words[i]; }
    }
    result.push(line);
  }
  return result;
}

export async function renderTextLayer(layer, outW, outH) {
  await document.fonts?.ready;
  const fontStack = FONT_STACKS[layer.font] || FONT_STACKS.space;
  const fontSize = Math.max(12, Math.round(outH * clamp(layer.sizePct ?? .065, .018, .22)));
  const weight = layer.weight || 700;
  try { await document.fonts.load(`${weight} ${fontSize}px ${fontStack}`); } catch (_) {}
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${weight} ${fontSize}px ${fontStack}`;
  const maxWidth = Math.max(80, outW * .84);
  const lines = wrapLines(measure, layer.text || 'Your text', maxWidth);
  const lineHeight = Math.round(fontSize * 1.18);
  const padX = Math.round(fontSize * .42);
  const padY = Math.round(fontSize * .30);
  const textWidth = Math.max(...lines.map(line => measure.measureText(line).width), fontSize);
  const w = Math.min(outW, Math.ceil(textWidth + padX * 2 + fontSize * .18));
  const h = Math.min(outH, Math.ceil(lines.length * lineHeight + padY * 2));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, w); canvas.height = Math.max(2, h);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = clamp(layer.opacity ?? 1, .05, 1);
  if (layer.background) {
    ctx.fillStyle = layer.bgColor || '#000000';
    roundRect(ctx, 0, 0, w, h, Math.round(fontSize * .25));
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,170,.18)';
    ctx.lineWidth = Math.max(1, Math.round(fontSize * .025));
    ctx.stroke();
  }
  ctx.font = `${weight} ${fontSize}px ${fontStack}`;
  ctx.textBaseline = 'top';
  ctx.direction = layer.rtl ? 'rtl' : 'ltr';
  ctx.textAlign = layer.align || 'center';
  const x = layer.align === 'left' ? padX : layer.align === 'right' ? w - padX : w / 2;
  ctx.shadowColor = 'rgba(0,0,0,.62)';
  ctx.shadowBlur = fontSize * .24;
  ctx.shadowOffsetY = fontSize * .07;
  lines.forEach((line, i) => {
    const y = padY + i * lineHeight;
    if (layer.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, fontSize * .075);
      ctx.strokeStyle = layer.outlineColor || '#100805';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = layer.color || '#ffb84d';
    ctx.fillText(line, x, y);
  });
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not render the text layer.');
  return { blob, width: w, height: h, fontSize };
}

export async function renderWatermark(file, outW, outH, scalePct, opacity) {
  const img = await loadImage(file);
  const targetW = Math.max(8, Math.round(outW * clamp(scalePct, .03, .6)));
  const targetH = Math.max(8, Math.round(targetW * img.naturalHeight / img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = clamp(opacity, .05, 1);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not render the watermark.');
  return { blob, width: targetW, height: targetH };
}

export async function audioPeaks(file, count = 128) {
  const fallback = Array.from({ length: count }, (_, i) => .18 + .16 * Math.abs(Math.sin(i * .21)));
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return fallback;
    const ctx = new AudioCtx();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / count));
    const peaks = [];
    for (let i = 0; i < count; i++) {
      let max = 0;
      const start = i * step;
      for (let j = 0; j < step; j += Math.max(1, Math.floor(step / 48))) max = Math.max(max, Math.abs(data[start + j] || 0));
      peaks.push(clamp(max, .02, 1));
    }
    const norm = Math.max(...peaks, .1);
    await ctx.close();
    return peaks.map(p => clamp(p / norm * .92, .04, 1));
  } catch (err) {
    console.warn('Waveform decode unavailable; using designed fallback.', err);
    return fallback;
  }
}

export function drawWaveform(canvas, peaks, { color = '#ffb84d', mint = '#4de6c3', background = true } = {}) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width || 600;
  const h = canvas.clientHeight || canvas.height || 92;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  if (background) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,184,77,.08)'); g.addColorStop(1, 'rgba(77,230,195,.04)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else ctx.clearRect(0, 0, w, h);
  const values = peaks?.length ? peaks : Array.from({ length: 96 }, (_, i) => .2 + .15 * Math.sin(i * .3));
  const gap = 2;
  const barW = Math.max(1, (w - gap * (values.length - 1)) / values.length);
  values.forEach((v, i) => {
    const bh = Math.max(2, v * h * .72);
    const x = i * (barW + gap);
    const grad = ctx.createLinearGradient(0, h / 2 - bh / 2, 0, h / 2 + bh / 2);
    grad.addColorStop(0, color); grad.addColorStop(1, mint);
    ctx.fillStyle = grad;
    ctx.globalAlpha = .35 + .65 * v;
    ctx.fillRect(x, h / 2 - bh / 2, barW, bh);
  });
  ctx.globalAlpha = 1;
}

export async function generateWaveformCover({ file, title = 'YOUR AUDIO', peaks, width = 1280, height = 720 }) {
  const values = peaks?.length ? peaks : await audioPeaks(file, 120);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#2b1a12'); bg.addColorStop(.48, '#150c08'); bg.addColorStop(1, '#311d14');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,220,180,.045)'; ctx.lineWidth = 2;
  for (let x = -height; x < width + height; x += 42) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + height, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, height); ctx.lineTo(x + height, 0); ctx.stroke();
  }
  const halo = ctx.createRadialGradient(width / 2, height * .42, 10, width / 2, height * .42, width * .55);
  halo.addColorStop(0, 'rgba(255,184,77,.18)'); halo.addColorStop(1, 'rgba(255,184,77,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);
  // Aperture mark
  ctx.save(); ctx.translate(width / 2, height * .38);
  ctx.strokeStyle = '#4de6c3'; ctx.globalAlpha = .65; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.arc(0, 0, 86, .2, Math.PI * 1.7); ctx.stroke();
  ctx.strokeStyle = '#ffb84d'; ctx.beginPath(); ctx.arc(0, 0, 86, Math.PI * 1.85, Math.PI * 2.15); ctx.stroke();
  ctx.fillStyle = '#ffb84d'; ctx.globalAlpha = .9;
  ctx.beginPath(); ctx.moveTo(-22, -34); ctx.lineTo(-22, 34); ctx.lineTo(42, 0); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Waveform
  const waveY = height * .67;
  const waveH = height * .20;
  const gap = 3;
  const barW = Math.max(1, (width * .82 - gap * (values.length - 1)) / values.length);
  const startX = width * .09;
  values.forEach((v, i) => {
    const bh = Math.max(3, v * waveH);
    const x = startX + i * (barW + gap);
    const grad = ctx.createLinearGradient(0, waveY - bh / 2, 0, waveY + bh / 2);
    grad.addColorStop(0, '#ffd180'); grad.addColorStop(.5, '#ffb84d'); grad.addColorStop(1, '#4de6c3');
    ctx.fillStyle = grad; ctx.globalAlpha = .55 + .45 * v;
    ctx.fillRect(x, waveY - bh / 2, barW, bh);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff3e2'; ctx.font = '700 54px "Space Grotesk", Inter, sans-serif';
  ctx.fillText(String(title).replace(/\.[^.]+$/, '').slice(0, 42).toUpperCase(), width / 2, height * .88);
  ctx.fillStyle = '#4de6c3'; ctx.font = '600 18px Inter, sans-serif';
  ctx.letterSpacing = '6px';
  ctx.fillText('Make it Fast Edit Arsenal  ·  AUDIO CANVAS', width / 2, height * .93);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not generate cover art.');
  return { blob, peaks: values };
}

export async function generateFilmstrip(url, duration, count = 8) {
  if (!url || !Number.isFinite(duration) || duration <= 0) return [];
  const video = document.createElement('video');
  video.src = url; video.muted = true; video.preload = 'metadata'; video.playsInline = true;
  const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 45;
  const ctx = canvas.getContext('2d');
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read preview frames'));
      setTimeout(() => reject(new Error('Preview frame timeout')), 5000);
    });
    const thumbs = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - .02, duration * (i + .5) / count);
      video.currentTime = t;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        video.onseeked = finish;
        setTimeout(finish, 400);
      });
      try { ctx.drawImage(video, 0, 0, 80, 45); } catch (_) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 80, 45); }
      thumbs.push(canvas.toDataURL('image/jpeg', .5));
    }
    return thumbs;
  } catch (err) {
    console.warn('Filmstrip unavailable', err);
    return [];
  } finally {
    video.removeAttribute('src'); video.load();
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
