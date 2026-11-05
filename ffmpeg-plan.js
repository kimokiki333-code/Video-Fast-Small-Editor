/* Pure FFmpeg command builders for Make it Fast Edit Arsenal.
   No browser APIs here, so every export recipe can be unit-tested. */

export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(+n) ? +n : min));
export const even = n => Math.max(2, Math.round((Number(n) || 2) / 2) * 2);
export const snapEven = n => Math.max(0, Math.round((Number(n) || 0) / 2) * 2);
export const fnum = n => Number(clamp(n, -100000, 100000).toFixed(3)).toString();
export const hexColor = value => `0x${String(value || '#000000').replace('#', '').slice(0, 6).toUpperCase()}`;

export function normalizedCrop(ctx) {
  const sw = Math.max(2, Math.round(ctx.source?.width || 2));
  const sh = Math.max(2, Math.round(ctx.source?.height || 2));
  let x = snapEven(ctx.crop?.x ?? 0);
  let y = snapEven(ctx.crop?.y ?? 0);
  let w = even(ctx.crop?.w || sw);
  let h = even(ctx.crop?.h || sh);
  w = clamp(w, 16, even(sw));
  h = clamp(h, 16, even(sh));
  x = clamp(x, 0, Math.max(0, sw - w));
  y = clamp(y, 0, Math.max(0, sh - h));
  x = snapEven(x); y = snapEven(y);
  if (x + w > sw) w = even(sw - x);
  if (y + h > sh) h = even(sh - y);
  return { x, y, w: Math.max(2, w), h: Math.max(2, h) };
}

export function getOutputSize(ctx) {
  const crop = normalizedCrop(ctx);
  let w = Number(ctx.output?.width) || crop.w;
  let h = Number(ctx.output?.height) || crop.h;
  // Hard 720p cap and no upscaling past the cropped source's short side.
  const cap = Math.min(Number(ctx.output?.qualityShort) || 720, Math.min(crop.w, crop.h));
  const short = Math.min(w, h);
  if (short > cap) { const scale = cap / short; w *= scale; h *= scale; }
  w = clamp(even(w), 16, 3840);
  h = clamp(even(h), 16, 3840);
  return { width: w, height: h };
}

export function buildConcatPlan(listName, outputName) {
  if (!listName || !outputName) throw new Error('Missing concat list or output name');
  return {
    args: ['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', '-movflags', '+faststart', outputName]
  };
}

function transformFilters(ctx) {
  const t = ctx.transform || {};
  const filters = [];
  if (t.flipH) filters.push('hflip');
  if (t.flipV) filters.push('vflip');
  const r = Number(t.rotate || 0);
  if (r === 90) filters.push('transpose=1');
  if (r === 180) filters.push('transpose=1', 'transpose=1');
  if (r === 270) filters.push('transpose=2');
  return filters;
}

function colorFilters(ctx) {
  const c = ctx.color || {};
  const b = Number(c.brightness ?? 0);
  const contrast = Number(c.contrast ?? 1);
  const saturation = Number(c.saturation ?? 1);
  const gamma = Number(c.gamma ?? 1);
  if (Math.abs(b) < .001 && Math.abs(contrast - 1) < .001 && Math.abs(saturation - 1) < .001 && Math.abs(gamma - 1) < .001) return [];
  return [`eq=brightness=${fnum(b)}:contrast=${fnum(contrast)}:saturation=${fnum(saturation)}:gamma=${fnum(gamma)}`];
}

function baseChain(ctx, opts) {
  const crop = normalizedCrop(ctx);
  const full = crop.x === 0 && crop.y === 0 && crop.w >= ctx.source.width && crop.h >= ctx.source.height;
  const filters = [];
  if (!full) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  const speed = clamp(ctx.speed ?? 1, .5, 2);
  filters.push(Math.abs(speed - 1) < .001 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${fnum(speed)}`);
  filters.push(...transformFilters(ctx));
  filters.push(...colorFilters(ctx));
  filters.push(`scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease:flags=lanczos`);
  filters.push(`pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:color=${hexColor(ctx.output?.background)}`);
  filters.push('setsar=1', `fps=${opts.fps}`, `format=${opts.pixelFormat}`);
  return filters.join(',');
}

function audioFilter(ctx) {
  const speed = clamp(ctx.speed ?? 1, .5, 2);
  const volume = ctx.mute ? 0 : clamp(ctx.volume ?? 1, 0, 2);
  const filters = [];
  if (Math.abs(volume - 1) > .001) filters.push(`volume=${fnum(volume)}`);
  if (Math.abs(speed - 1) > .001) filters.push(`atempo=${fnum(speed)}`);
  if (!filters.length) filters.push('anull');
  return filters.join(',');
}

function timedOverlays(ctx, outputDuration) {
  return (ctx.overlays || []).map((ov, index) => {
    const start = clamp(ov.start ?? 0, 0, outputDuration);
    const end = clamp(Number.isFinite(ov.end) ? ov.end : outputDuration, 0, outputDuration);
    return { ...ov, start, end, index };
  }).filter((ov, i) => ov.end > ov.start + .001 || ctx.overlayMode === 'static');
}

function buildGraph(ctx, opts) {
  const { overlayStart, outputDuration, width, height, fps, pixelFormat, post } = opts;
  const overlays = timedOverlays(ctx, outputDuration);
  let graph = `[0:v]${baseChain(ctx, { width, height, fps, pixelFormat })}[v0]`;
  let label = 'v0';
  overlays.forEach((ov, i) => {
    const input = overlayStart + ov.index;
    const outLabel = `v${i + 1}`;
    const ow = Math.max(1, Math.round(ov.width || 1));
    const oh = Math.max(1, Math.round(ov.height || 1));
    const x = Math.round(clamp(ov.xPct ?? .5, 0, 1) * Math.max(0, width - ow));
    const y = Math.round(clamp(ov.yPct ?? .5, 0, 1) * Math.max(0, height - oh));
    const enable = ctx.overlayMode === 'static' ? '' : `:enable='between(t,${fnum(ov.start)},${fnum(ov.end)})'`;
    graph += `;[${input}:v]format=rgba[ov${i}];[${label}][ov${i}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=1${enable}[${outLabel}]`;
    label = outLabel;
  });
  if (post === 'gif') {
    graph += `;[${label}]split[gbase][gpalette];[gpalette]palettegen=stats_mode=diff[pal];[gbase][pal]paletteuse=dither=bayer:bayer_scale=3[vout]`;
    label = 'vout';
  } else if (post === 'contact') {
    graph += `;[${label}]tile=3x3:padding=10:margin=10:color=${hexColor(ctx.output?.background)}[vout]`;
    label = 'vout';
  }
  return { graph, label };
}

function inputArgs(ctx, opts) {
  const { sourceDuration, outputDuration, withAudio } = opts;
  const inputFps = clamp(ctx.output?.fps || 30, 1, 60);
  const args = [];
  let overlayStart = 1;
  let audioIndex = 0;
  const rangeStart = clamp(ctx.range?.start ?? 0, 0, 100000);
  if (ctx.mode === 'audio') {
    args.push('-loop', '1', '-framerate', fnum(inputFps), '-t', fnum(outputDuration), '-i', ctx.coverName);
    if (withAudio) {
      args.push('-ss', fnum(rangeStart), '-t', fnum(sourceDuration), '-i', ctx.audioName);
      audioIndex = 1;
      overlayStart = 2;
    }
  } else {
    args.push('-ss', fnum(rangeStart), '-t', fnum(sourceDuration), '-i', ctx.videoName);
  }
  (ctx.overlays || []).forEach(ov => {
    args.push('-loop', '1', '-framerate', fnum(inputFps), '-t', fnum(outputDuration), '-i', ov.name);
  });
  return { args, overlayStart, audioIndex };
}

export function buildVideoPlan(ctx, kind = 'mp4') {
  if (!ctx.outputName) throw new Error('Missing output name');
  const speed = clamp(ctx.speed ?? 1, .5, 2);
  const requestedDuration = clamp(ctx.range?.duration ?? 1, .04, 36000);
  const maxGifSource = 6 * speed;
  const sourceDuration = kind === 'gif' ? Math.min(requestedDuration, maxGifSource) : requestedDuration;
  const outputDuration = Math.max(.033, sourceDuration / speed);
  const out = getOutputSize(ctx);
  let width = out.width, height = out.height, fps = Number(ctx.output?.fps || 30);
  if (kind === 'gif') {
    width = 480;
    height = even(Math.round(480 * out.height / out.width));
    fps = 12;
  }
  if (kind === 'contact') {
    width = 480;
    height = even(Math.round(480 * out.height / out.width));
    fps = Math.max(.05, 9 / outputDuration);
  }
  const withAudio = kind === 'mp4';
  const inputs = inputArgs(ctx, { sourceDuration, outputDuration, withAudio, fps });
  const graph = buildGraph(ctx, {
    overlayStart: inputs.overlayStart,
    outputDuration,
    width,
    height,
    fps: fnum(fps),
    pixelFormat: kind === 'mp4' ? 'yuv420p' : 'rgb24',
    post: kind === 'gif' ? 'gif' : kind === 'contact' ? 'contact' : null
  });
  const args = [...inputs.args, '-filter_complex', graph.graph, '-map', `[${graph.label}]`];

  if (kind === 'mp4') {
    args.push('-map', `${inputs.audioIndex}:a:0?`, '-map_metadata', '-1', '-map_chapters', '-1');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(ctx.output?.crf || 23));
    args.push('-pix_fmt', 'yuv420p', '-r', fnum(ctx.output?.fps || 30), '-threads', '1');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-af', audioFilter(ctx));
    args.push('-t', fnum(outputDuration), '-shortest', '-movflags', '+faststart');
  } else if (kind === 'gif') {
    args.push('-an', '-loop', '0', '-t', fnum(outputDuration));
  } else if (kind === 'contact') {
    args.push('-an', '-frames:v', '1', '-update', '1', '-c:v', 'png');
  } else if (kind === 'snapshot') {
    args.push('-an', '-frames:v', '1', '-update', '1', '-c:v', 'png', '-pix_fmt', 'rgba');
  }
  args.push(ctx.outputName);
  return { args, outputName: ctx.outputName, mime: kind === 'mp4' ? 'video/mp4' : kind === 'gif' ? 'image/gif' : 'image/png', outputDuration };
}

export function buildExtractPlan(ctx, format = 'mp3') {
  if (!ctx.outputName) throw new Error('Missing output name');
  const speed = clamp(ctx.speed ?? 1, .5, 2);
  const sourceDuration = clamp(ctx.range?.duration ?? 1, .04, 36000);
  const outputDuration = sourceDuration / speed;
  const input = ctx.mode === 'audio' ? ctx.audioName : ctx.videoName;
  const wav = format === 'wav';
  const args = [
    '-ss', fnum(ctx.range?.start ?? 0), '-t', fnum(sourceDuration), '-i', input,
    '-vn', '-map', '0:a:0', '-af', audioFilter(ctx),
    '-t', fnum(outputDuration),
    ...(wav ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-q:a', '3']),
    '-ar', '44100', '-ac', '2',
    ctx.outputName
  ];
  return { args, outputName: ctx.outputName, mime: wav ? 'audio/wav' : 'audio/mpeg', outputDuration };
}

export function segmentRanges(points, start, end, cap = 12) {
  const minGap = .05;
  const cuts = [...new Set((points || []).map(Number).filter(Number.isFinite))]
    .filter(t => t > start + minGap && t < end - minGap)
    .sort((a, b) => a - b)
    .slice(0, cap - 1);
  const boundaries = [start, ...cuts, end];
  const ranges = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i], e = boundaries[i + 1];
    if (e - s >= minGap) ranges.push({ start: s, end: e, duration: e - s, index: i + 1 });
  }
  return ranges;
}

export function overlaysForRange(overlays, rangeStart, rangeEnd, speed = 1, mode = 'timed') {
  const duration = Math.max(0, (rangeEnd - rangeStart) / clamp(speed, .5, 2));
  return (overlays || []).map((ov, index) => {
    const absStart = Number.isFinite(ov.start) ? ov.start : 0;
    const absEnd = Number.isFinite(ov.end) ? ov.end : rangeEnd;
    const start = clamp((absStart - rangeStart) / speed, 0, duration);
    const end = clamp((absEnd - rangeStart) / speed, 0, duration);
    return { ...ov, index, start, end };
  }).filter(ov => mode === 'static' || ov.end > ov.start + .001);
}
