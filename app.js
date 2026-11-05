/* Make it Fast Edit Arsenal — application state, editor interactions and render orchestration. */
import { VideoEngine } from './engine.js';
import {
  buildVideoPlan, buildExtractPlan, buildConcatPlan, segmentRanges, overlaysForRange,
  getOutputSize, normalizedCrop
} from './ffmpeg-plan.js';
import { LightPreview } from './player.js';
import './background.js';
import { createZip } from './zip.js';
import {
  clamp, even, snapEven, formatTime, parseTime, safeName, extensionOf, prettyBytes,
  blobToFile, loadImage as decodeImage, FONT_STACKS, renderTextLayer, renderWatermark,
  audioPeaks, drawWaveform, generateWaveformCover, generateFilmstrip, downloadBlob
} from './media-utils.js';


const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const clone = obj => JSON.parse(JSON.stringify(obj));

const MAX_SEGMENTS = 24;
const DEFAULT_OUTPUT = {
  qualityTier: 720, shape: 'original', customW: 16, customH: 9,
  width: 1280, height: 720, fps: 30, crf: 23, background: '#000000', qualityShort: 720
};
let lightPreview = null;
const VOLATILE_KEYS = new Set(['coverPromise', 'coverVersion', 'filmstrip', 'peaks', 'playing', 'currentTime']);
const EDITABLE_KEYS = [
  'trimStart', 'trimEnd', 'crop', 'cropRatio', 'texts', 'selectedTextId',
  'watermarkFile', 'watermarkURL', 'watermark', 'transform', 'color',
  'speed', 'volume', 'mute', 'output'
];
function makeProject(mode) {
  return {
    mode,
    videoFile: null, videoURL: null,
    audioFile: null, audioURL: null,
    imageFile: null, imageURL: null, generatedCover: false, coverVersion: 0, coverPromise: null,
    sourceW: 1280, sourceH: 720, duration: 0, currentTime: 0, playing: false,
    trimStart: 0, trimEnd: 0, filmstrip: [], peaks: null,
    crop: { x: 0, y: 0, w: 1280, h: 720 }, cropRatio: 'free',
    texts: [], selectedTextId: null,
    watermarkFile: null, watermarkURL: null,
    watermark: { scale: .18, opacity: .8, xPct: .92, yPct: .88 },
    transform: { rotate: 0, flipH: false, flipV: false },
    color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 },
    speed: 1, volume: 1, mute: false,
    output: clone(DEFAULT_OUTPUT), splitPoints: [], segments: [],
    activeSegmentId: null, globalEdits: null
  };
}

const state = {
  mode: 'video', activePanel: 'trim',
  projects: { video: makeProject('video'), audio: makeProject('audio') },
  results: [], busy: false, cancelled: false, stopAtTrimEnd: false,
  written: new Map()
};
const P = () => state.projects[state.mode];

const history = { past: [], future: [], limit: 90 };
let lastCommitted = null;
let historyMuted = false;

function cloneValue(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  // File / Blob objects are opaque and cannot survive JSON cloning. Preserve them
  // at any nesting depth so per-part edits and undo/redo keep watermark images.
  if (typeof File !== 'undefined' && value instanceof File) return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
  return out;
}
function fingerprint(snap) {
  return JSON.stringify(snap, (key, value) => {
    if (typeof File !== 'undefined' && value instanceof File) return `file:${value.name}:${value.size}:${value.lastModified || 0}`;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return `blob:${value.size}`;
    return value;
  });
}
function captureState() {
  const snap = { mode: state.mode, activePanel: state.activePanel, projects: {} };
  for (const mode of ['video', 'audio']) {
    const p = state.projects[mode], out = {};
    for (const [key, value] of Object.entries(p)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = cloneValue(value);
    }
    snap.projects[mode] = out;
  }
  return snap;
}
function syncMediaElements() {
  const p = P();
  videoEl.pause(); audioEl.pause();
  if (state.mode === 'video') {
    if (p.videoURL && videoEl.src !== p.videoURL) { videoEl.src = p.videoURL; videoEl.load(); }
  } else {
    if (p.imageURL) imageEl.src = p.imageURL;
    if (p.audioURL && audioEl.src !== p.audioURL) { audioEl.src = p.audioURL; audioEl.load(); }
  }
  updatePlayButton();
  lightPreview?.setMode();
}
function restoreState(snap) {
  historyMuted = true;
  state.mode = snap.mode || 'video';
  state.activePanel = snap.activePanel || 'trim';
  for (const mode of ['video', 'audio']) {
    const old = state.projects[mode], saved = snap.projects[mode] || {};
    const next = makeProject(mode);
    for (const [key, value] of Object.entries(saved)) next[key] = cloneValue(value);
    next.coverPromise = old.coverPromise;
    next.coverVersion = old.coverVersion;
    next.filmstrip = old.filmstrip ? [...old.filmstrip] : [];
    next.peaks = old.peaks ? [...old.peaks] : null;
    next.playing = old.playing;
    next.currentTime = old.currentTime;
    state.projects[mode] = next;
  }
  syncMediaElements();
  updateAll();
  historyMuted = false;
  lastCommitted = captureState();
  updateHistoryButtons();
}
function updateHistoryButtons() {
  const undo = $('undo-btn'), redo = $('redo-btn'), count = $('history-count');
  if (undo) { undo.disabled = !history.past.length; undo.title = history.past.at(-1)?.label ? `Undo: ${history.past.at(-1).label}` : 'Nothing to undo'; }
  if (redo) { redo.disabled = !history.future.length; redo.title = history.future.at(-1)?.label ? `Redo: ${history.future.at(-1).label}` : 'Nothing to redo'; }
  if (count) count.textContent = `${history.past.length}↶ / ${history.future.length}↷`;
}
function commitHistory(label = 'Edit') {
  if (historyMuted) return;
  const now = captureState();
  if (lastCommitted && fingerprint(now) === fingerprint(lastCommitted)) return;
  history.past.push({ snap: lastCommitted || now, label });
  if (history.past.length > history.limit) history.past.shift();
  history.future.length = 0;
  lastCommitted = now;
  if (!P().activeSegmentId) P().globalEdits = editableSnapshot(P());
  updateHistoryButtons();
}
function undo() {
  if (!history.past.length) return;
  history.future.push({ snap: captureState(), label: 'Redo' });
  const entry = history.past.pop();
  restoreState(entry.snap);
  toast('Undo', entry.label || 'Last edit restored');
}
function redo() {
  if (!history.future.length) return;
  history.past.push({ snap: captureState(), label: 'Undo' });
  const entry = history.future.pop();
  restoreState(entry.snap);
  toast('Redo', entry.label || 'Edit reapplied');
}

const SHAPE_RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3 };
const evenFloor = n => Math.max(2, Math.floor((Number(n) || 2) / 2) * 2);
function shapeRatio(p) {
  const shape = p.output?.shape || 'original';
  if (shape === 'original') return Math.max(1, p.crop.w) / Math.max(1, p.crop.h);
  if (shape === 'custom') return Math.max(.05, Number(p.output?.customW) || 16) / Math.max(.05, Number(p.output?.customH) || 9);
  return SHAPE_RATIOS[shape] || 16 / 9;
}
function computeOutputSize(p) {
  const tier = clamp(Number(p.output?.qualityTier) || 720, 360, 720);
  const ratio = shapeRatio(p);
  const sourceShort = Math.max(16, Math.min(p.crop.w, p.crop.h));
  const short = evenFloor(Math.min(tier, sourceShort));
  let width, height;
  if (ratio >= 1) { height = short; width = evenFloor(short * ratio); }
  else { width = short; height = evenFloor(short / ratio); }
  width = clamp(evenFloor(width), 16, 3840);
  height = clamp(evenFloor(height), 16, 3840);
  return { width, height, qualityShort: short };
}

const videoEl = $('preview-video');
const imageEl = $('preview-image');
const frameEl = $('media-frame');
const stageEl = $('stage');
const overlayEl = $('overlay-layer');
const cropOverlay = $('crop-overlay');
const cropBox = $('crop-box');
const audioEl = document.createElement('audio');
audioEl.preload = 'metadata'; audioEl.hidden = true;
document.body.appendChild(audioEl);

const engine = new VideoEngine({
  onProgress: (percent, label) => setProgress(percent, label),
  onLog: message => { if (/error/i.test(message)) console.debug('[ffmpeg]', message); }
});

/* ---------- feedback + results ---------- */
function toast(title, message = '', type = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
  const icon = type === 'success' ? '#i-check' : type === 'error' ? '#i-info' : '#i-sparkles';
  node.innerHTML = `<svg class="icon"><use href="${icon}"/></svg><div><b>${esc(title)}</b>${message ? `<span>${esc(message)}</span>` : ''}</div>`;
  $('toast-stack').appendChild(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 320); }, type === 'error' ? 6500 : 4200);
}

function setProgress(percent, label) {
  const block = $('progress-block');
  if (block.hidden && state.busy) block.hidden = false;
  const value = Math.round(clamp(percent, 0, 100));
  $('progress-bar').style.width = `${value}%`;
  $('progress-value').textContent = `${value}%`;
  if (label) $('progress-label').textContent = label;
}

const renderButtons = ['export-top', 'export-main-btn', 'split-export-btn', 'snapshot-btn', 'extract-btn', 'gif-btn', 'contact-btn'];
function setBusy(busy, label = 'Preparing…') {
  state.busy = busy;
  renderButtons.forEach(id => { const el = $(id); if (el) el.disabled = busy; });
  $('progress-block').hidden = !busy;
  if (busy) setProgress(0, label);
  $('cancel-export-btn').disabled = false;
}

function friendlyError(error) {
  const msg = String(error?.message || error || 'Unknown render error');
  if (/cancelled/i.test(msg)) return 'Render cancelled.';
  if (/no audio|matches no streams|stream map/i.test(msg)) return 'This source has no audio track to extract.';
  if (/unknown encoder|libmp3lame/i.test(msg)) return 'This browser build lacks the MP3 encoder; try the WAV fallback.';
  if (/invalid data|moov atom|unsupported/i.test(msg)) return 'The media format could not be decoded by the local engine. Try MP4 or WebM.';
  return msg.length > 180 ? `${msg.slice(0, 177)}…` : msg;
}

function addResult(blob, name, kind, download = true) {
  const url = URL.createObjectURL(blob);
  const result = { id: uid(), blob, name, kind, url, size: blob.size };
  state.results.unshift(result);
  if (state.results.length > 14) {
    const old = state.results.pop();
    URL.revokeObjectURL(old.url);
  }
  renderResults();
  if (download) downloadBlob(blob, name);
  return result;
}

function resultIcon(kind) {
  if (kind === 'video') return '#i-video';
  if (kind === 'image') return '#i-image';
  if (kind === 'audio') return '#i-file-audio';
  if (kind === 'zip') return '#i-zip';
  return '#i-download';
}

function renderResults() {
  const list = $('results-list');
  if (!state.results.length) {
    list.innerHTML = '<div class="results-empty"><svg class="icon"><use href="#i-download"/></svg><span>Rendered files will appear here with instant downloads.</span></div>';
    return;
  }
  list.innerHTML = state.results.map(r => {
    let thumb = `<span class="result-thumb"><svg class="icon"><use href="${resultIcon(r.kind)}"/></svg></span>`;
    if (r.kind === 'image') thumb = `<span class="result-thumb"><img src="${esc(r.url)}" alt=""></span>`;
    if (r.kind === 'video') thumb = `<span class="result-thumb"><video src="${esc(r.url)}#t=0.05" muted preload="metadata"></video></span>`;
    return `<div class="result-item">${thumb}<div class="result-meta"><b title="${esc(r.name)}">${esc(r.name)}</b><span>${prettyBytes(r.size)} · ready</span></div><button class="result-download" type="button" data-download="${r.id}" aria-label="Download ${esc(r.name)}"><svg class="icon"><use href="#i-download"/></svg></button></div>`;
  }).join('');
}

/* ---------- project / media loading ---------- */
function sourceReady(p = P()) {
  if (!p.duration || p.duration <= 0) return false;
  return state.mode === 'video' ? !!p.videoFile : !!(p.audioFile && p.imageFile);
}

function revokeIf(url) { if (url) URL.revokeObjectURL(url); }

async function setMode(mode, { switchPanel = true } = {}) {
  if (!['video', 'audio'].includes(mode)) return;
  if (state.mode === mode) {
    if (switchPanel) activatePanel(mode === 'audio' ? 'audio' : 'trim', { syncMode: false });
    return;
  }
  pauseMedia();
  state.mode = mode;
  state.stopAtTrimEnd = false;
  const p = P();
  $$('#mode-switch button').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  $('mode-badge').textContent = mode === 'video' ? 'VIDEO' : 'MP3 + IMAGE';
  videoEl.hidden = mode !== 'video';
  imageEl.hidden = mode !== 'audio';
  if (mode === 'video') {
    audioEl.pause(); audioEl.removeAttribute('src');
    if (p.videoURL && videoEl.src !== p.videoURL) { videoEl.src = p.videoURL; videoEl.load(); }
  } else {
    videoEl.pause();
    if (p.imageURL) imageEl.src = p.imageURL;
    if (p.audioURL && audioEl.src !== p.audioURL) { audioEl.src = p.audioURL; audioEl.load(); }
  }
  if (switchPanel) activatePanel(mode === 'audio' ? 'audio' : 'trim', { syncMode: false });
  updateAll();
  lightPreview?.setMode();
  window.__MVS_BG__?.setMediaPlaying(false);
  requestAnimationFrame(() => { fitMediaFrame(); renderWaveform(); });
}

async function loadVideo(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name)) {
    toast('Unsupported file', 'Choose a video file.', 'error'); return;
  }
  await setMode('video');
  const p = P();
  revokeIf(p.videoURL);
  p.videoFile = file;
  p.videoURL = URL.createObjectURL(file);
  p.duration = 0; p.currentTime = 0; p.trimStart = 0; p.trimEnd = 0;
  p.filmstrip = []; p.splitPoints = []; p.segments = []; p.activeSegmentId = null; p.globalEdits = null;
  videoEl.src = p.videoURL;
  videoEl.load();
  updateProjectInfo();
  toast('Video loaded', `${file.name} · reading metadata`);
}

async function loadAudio(file) {
  if (!file) return;
  await setMode('audio', { switchPanel: true });
  const p = P();
  revokeIf(p.audioURL);
  p.audioFile = file;
  p.audioURL = URL.createObjectURL(file);
  p.duration = 0; p.currentTime = 0; p.trimStart = 0; p.trimEnd = 0;
  p.splitPoints = []; p.segments = []; p.activeSegmentId = null; p.globalEdits = null; p.peaks = null; p.coverVersion++;
  audioEl.src = p.audioURL; audioEl.load();
  // Immediate designed placeholder, then an actual waveform cover from decoded audio.
  const version = p.coverVersion;
  const fallbackPeaks = Array.from({ length: 120 }, (_, i) => .18 + .22 * Math.abs(Math.sin(i * .19)));
  p.coverPromise = (async () => {
    const first = await generateWaveformCover({ title: file.name, peaks: fallbackPeaks });
    if (p.coverVersion !== version || P() !== p) return;
    await setCoverFile(blobToFile(first.blob, 'mvs-auto-cover.png'), { generated: true, silent: true });
    p.peaks = await audioPeaks(file, 128);
    renderWaveform();
    const real = await generateWaveformCover({ title: file.name, peaks: p.peaks });
    if (p.coverVersion === version && P() === p && p.generatedCover) {
      await setCoverFile(blobToFile(real.blob, 'mvs-waveform-cover.png'), { generated: true, silent: true });
    }
  })().catch(err => console.warn('Cover generation fallback', err));
  updateProjectInfo();
  toast('Audio loaded', `${file.name} · preparing audio canvas`);
}

async function setCoverFile(file, { generated = false, silent = false } = {}) {
  const p = state.projects.audio;
  const img = await decodeImage(file);
  revokeIf(p.imageURL);
  p.imageFile = file;
  p.imageURL = URL.createObjectURL(file);
  p.generatedCover = generated;
  p.sourceW = img.naturalWidth || 1280;
  p.sourceH = img.naturalHeight || 720;
  p.crop = { x: 0, y: 0, w: even(p.sourceW), h: even(p.sourceH) };
  p.filmstrip = Array(8).fill(p.imageURL);
  Object.assign(p.output, computeOutputSize(p));
  imageEl.src = p.imageURL;
  lightPreview?.markDirty();
  if (state.mode === 'audio') {
    updateAll();
    requestAnimationFrame(fitMediaFrame);
  } else updateProjectInfo();
  if (!silent) {
    commitHistory(generated ? 'Generate cover' : 'Add cover');
    toast(generated ? 'Cover generated' : 'Cover added', generated ? 'A waveform cover was created from the audio.' : `${file.name} · ${p.sourceW}×${p.sourceH}`);
  }
}

async function loadImage(file) {
  if (!file) return;
  const p = state.projects.audio;
  p.coverVersion++;
  await setMode('audio', { switchPanel: true });
  await setCoverFile(file, { generated: false });
  if (!p.audioFile) toast('Now add audio', 'Choose an MP3 or audio file to pair with this cover.');
}

async function loadWatermark(file) {
  if (!file) return;
  const p = P();
  revokeIf(p.watermarkURL);
  p.watermarkFile = file;
  p.watermarkURL = URL.createObjectURL(file);
  $('watermark-label').textContent = file.name.length > 22 ? `${file.name.slice(0, 20)}…` : file.name;
  renderOverlayDOM(); commitHistory('Add logo');
  toast('Logo added', 'Drag it on the preview to position it.');
}

function updateProjectInfo() {
  const vp = state.projects.video, ap = state.projects.audio;
  $('video-file-name').textContent = vp.videoFile?.name || 'No video loaded';
  $('video-file-meta').textContent = vp.videoFile ? `${vp.sourceW}×${vp.sourceH} · ${prettyBytes(vp.videoFile.size)}` : 'MP4 · MOV · WEBM';
  $('audio-file-name').textContent = ap.audioFile?.name || 'No audio loaded';
  $('audio-file-meta').textContent = ap.audioFile ? `${formatTime(ap.duration)} · ${prettyBytes(ap.audioFile.size)}` : 'MP3 · WAV · M4A';
  $('image-file-name').textContent = ap.imageFile ? (ap.generatedCover ? 'Generated waveform cover' : ap.imageFile.name) : 'No cover loaded';
  $('image-file-meta').textContent = ap.imageFile ? `${ap.sourceW}×${ap.sourceH} · ${prettyBytes(ap.imageFile.size)}` : 'PNG · JPG · WEBP';
  $('audio-file-label').textContent = ap.audioFile?.name || 'No audio selected';
  $('image-file-label').textContent = ap.imageFile ? (ap.generatedCover ? 'Generated cover' : ap.imageFile.name) : 'No image selected';
  $('audio-duration-label').textContent = ap.duration ? formatTime(ap.duration) : '00:00.000';
  const has = sourceReady();
  $('empty-state').hidden = has;
  frameEl.hidden = !has;
  $('player-area').classList.toggle('disabled', !has);
  $('preview-badge').textContent = has ? (state.mode === 'video' ? `${vp.sourceW}×${vp.sourceH}` : `${ap.sourceW}×${ap.sourceH} COVER`) : 'NO MEDIA';
  videoEl.hidden = state.mode !== 'video';
  imageEl.hidden = state.mode !== 'audio';
  lightPreview?.markDirty();
}

videoEl.addEventListener('loadedmetadata', async () => {
  if (state.mode !== 'video' || !P().videoFile) return;
  const p = P();
  p.sourceW = videoEl.videoWidth || 1280;
  p.sourceH = videoEl.videoHeight || 720;
  p.duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  p.trimStart = 0; p.trimEnd = p.duration; p.currentTime = 0;
  p.crop = { x: 0, y: 0, w: even(p.sourceW), h: even(p.sourceH) };
  Object.assign(p.output, computeOutputSize(p));
  p.texts.forEach(layer => { if (layer.end > p.duration) layer.end = 0; });
  p.globalEdits = editableSnapshot(p);
  updateAll();
  commitHistory('Load video');
  requestAnimationFrame(fitMediaFrame);
  // Lazy, lightweight filmstrip: 8 thumbnails, generated after the UI is ready.
  const url = p.videoURL, duration = p.duration;
  const timer = setTimeout(async () => {
    if (p.videoURL !== url || state.projects.video !== p) return;
    p.filmstrip = await generateFilmstrip(url, duration, 8);
    renderFilmstripDOM();
  }, 600);
  p.filmstripTimer = timer;
});
audioEl.addEventListener('loadedmetadata', () => {
  if (state.mode !== 'audio' || !P().audioFile) return;
  const p = P();
  p.duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
  p.trimStart = 0; p.trimEnd = p.duration; p.currentTime = 0;
  Object.assign(p.output, computeOutputSize(p));
  p.globalEdits = editableSnapshot(p);
  updateAll();
  commitHistory('Load audio');
});
videoEl.addEventListener('timeupdate', () => {
  if (state.mode !== 'video') return;
  const p = P();
  p.currentTime = videoEl.currentTime;
  if (state.stopAtTrimEnd && p.currentTime >= p.trimEnd - .01) {
    videoEl.pause(); videoEl.currentTime = p.trimEnd; p.currentTime = p.trimEnd;
    p.playing = false; state.stopAtTrimEnd = false; updatePlayButton();
  }
  updateTimelineUI();
});
audioEl.addEventListener('timeupdate', () => {
  if (state.mode !== 'audio') return;
  const p = P();
  p.currentTime = audioEl.currentTime;
  if (state.stopAtTrimEnd && p.currentTime >= p.trimEnd - .01) {
    audioEl.pause(); audioEl.currentTime = p.trimEnd; p.currentTime = p.trimEnd;
    p.playing = false; state.stopAtTrimEnd = false; updatePlayButton();
  }
  updateTimelineUI();
});
[videoEl, audioEl].forEach(el => el.addEventListener('ended', () => { P().playing = false; state.stopAtTrimEnd = false; updatePlayButton(); lightPreview?.stop(); window.__MVS_BG__?.setMediaPlaying(false); }));
[videoEl, audioEl].forEach(el => { el.addEventListener('play', () => { lightPreview?.start(); window.__MVS_BG__?.setMediaPlaying(true); }); el.addEventListener('pause', () => { lightPreview?.stop(); window.__MVS_BG__?.setMediaPlaying(false); }); });
[videoEl, audioEl].forEach(el => el.addEventListener('error', () => { if (el.src) console.warn('Media decode warning', el.error?.message || ''); }));

/* ---------- layout, preview and overlays ---------- */
function renderFilmstripDOM() {
  const p = P();
  const strip = $('filmstrip');
  if (!p.filmstrip?.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = p.filmstrip.map(src => `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`).join('');
}

function fitMediaFrame() {
  const p = P();
  if (!sourceReady(p)) return;
  const cs = getComputedStyle(stageEl);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availableW = Math.max(120, stageEl.clientWidth - padX);
  const availableH = Math.max(100, stageEl.clientHeight - padY);
  const sw = Math.max(2, p.sourceW), sh = Math.max(2, p.sourceH);
  const scale = Math.min(availableW / sw, availableH / sh, 2.2);
  frameEl.style.width = `${Math.round(sw * scale)}px`;
  frameEl.style.height = `${Math.round(sh * scale)}px`;
  applyPreviewTransform();
  applyPreviewFilters();
  updateCropOverlay();
  positionOverlays();
  lightPreview?.resize();
}

function applyPreviewTransform() {
  const p = P(), t = p.transform;
  const ratio = p.sourceW / Math.max(1, p.sourceH);
  const fit = (t.rotate === 90 || t.rotate === 270) ? Math.min(ratio, 1 / ratio) : 1;
  const transform = `rotate(${t.rotate || 0}deg) scale(${(t.flipH ? -1 : 1) * fit}, ${(t.flipV ? -1 : 1) * fit})`;
  videoEl.style.transformOrigin = 'center'; imageEl.style.transformOrigin = 'center';
  videoEl.style.transform = transform; imageEl.style.transform = transform;
}
function applyPreviewFilters() {
  const c = P().color;
  const filter = `brightness(${clamp(1 + c.brightness, .5, 1.6)}) contrast(${c.contrast}) saturate(${c.saturation})`;
  videoEl.style.filter = filter; imageEl.style.filter = filter;
}
function updatePlayButton() {
  const playing = P().playing;
  const use = $('play-btn').querySelector('use');
  if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function playMedia() {
  const el = state.mode === 'video' ? videoEl : audioEl;
  if (!sourceReady()) { toast('Add media first', 'Load a video or an audio + cover pair.', 'error'); return; }
  el.play().then(() => { P().playing = true; updatePlayButton(); lightPreview?.start(); window.__MVS_BG__?.setMediaPlaying(true); }).catch(err => toast('Playback blocked', err.message || 'Tap play again.', 'error'));
}
function pauseMedia() {
  videoEl.pause(); audioEl.pause();
  state.projects.video.playing = false; state.projects.audio.playing = false;
  updatePlayButton();
  lightPreview?.stop();
  window.__MVS_BG__?.setMediaPlaying(false);
}
function togglePlay() { P().playing ? pauseMedia() : playMedia(); }
function seekMedia(time, fromUser = false) {
  const p = P();
  const t = clamp(time, 0, Math.max(0, p.duration - .001));
  p.currentTime = t;
  const el = state.mode === 'video' ? videoEl : audioEl;
  try { el.currentTime = t; } catch (_) {}
  if (fromUser) state.stopAtTrimEnd = false;
  updateTimelineUI();
  lightPreview?.markDirty();
}

function layerEnd(p, layer) { return layer.end > 0 ? Math.min(layer.end, p.duration || layer.end) : (p.duration || 0); }

function renderOverlayDOM() {
  const p = P();
  overlayEl.innerHTML = '';
  if (!sourceReady(p)) return;
  p.texts.forEach(layer => {
    const el = document.createElement('div');
    el.className = `text-preview${layer.outline ? ' outlined' : ''}${p.selectedTextId === layer.id ? ' selected' : ''}`;
    el.dataset.textId = layer.id;
    el.textContent = layer.text || 'Your text';
    el.style.fontFamily = FONT_STACKS[layer.font] || FONT_STACKS.space;
    el.style.fontWeight = layer.weight || 700;
    el.style.fontSize = `${Math.max(10, frameEl.clientHeight * clamp(layer.sizePct, .018, .22))}px`;
    el.style.lineHeight = '1.12';
    el.style.textAlign = layer.align || 'center';
    el.style.direction = layer.rtl ? 'rtl' : 'ltr';
    el.style.color = layer.color || '#ffb84d';
    el.style.background = layer.background ? (layer.bgColor || '#000000') : 'transparent';
    el.style.setProperty('--text-opacity', clamp(layer.opacity ?? 1, .05, 1));
    el.style.webkitTextStroke = layer.outline ? '2px rgba(10,5,3,.86)' : '0';
    overlayEl.appendChild(el);
  });
  if (p.watermarkFile && p.watermarkURL) {
    const img = document.createElement('img');
    img.className = `watermark-preview${state.activePanel === 'effects' ? ' selected' : ''}`;
    img.dataset.watermark = '1';
    img.src = p.watermarkURL;
    img.alt = 'Watermark';
    img.style.width = `${clamp(p.watermark.scale, .03, .6) * 100}%`;
    img.style.height = 'auto';
    img.style.opacity = clamp(p.watermark.opacity, .05, 1);
    overlayEl.appendChild(img);
  }
  lightPreview?.markDirty();
  requestAnimationFrame(() => { positionOverlays(); updateOverlayVisibility(); });
}

function positionOverlays() {
  const p = P();
  const fw = frameEl.clientWidth, fh = frameEl.clientHeight;
  if (!fw || !fh) return;
  [...overlayEl.children].forEach(el => {
    const isWatermark = el.dataset.watermark === '1';
    const xPct = isWatermark ? p.watermark.xPct : (p.texts.find(l => l.id === el.dataset.textId)?.xPct ?? .5);
    const yPct = isWatermark ? p.watermark.yPct : (p.texts.find(l => l.id === el.dataset.textId)?.yPct ?? .5);
    el.style.left = `${clamp(xPct, 0, 1) * Math.max(0, fw - el.offsetWidth)}px`;
    el.style.top = `${clamp(yPct, 0, 1) * Math.max(0, fh - el.offsetHeight)}px`;
  });
}

function updateOverlayVisibility() {
  const p = P();
  [...overlayEl.querySelectorAll('.text-preview')].forEach(el => {
    const layer = p.texts.find(l => l.id === el.dataset.textId);
    if (!layer) return;
    const active = p.currentTime >= layer.start - .001 && p.currentTime <= layerEnd(p, layer) + .001;
    el.classList.toggle('inactive', !active);
  });
}

let overlayDrag = null;
overlayEl.addEventListener('pointerdown', event => {
  if (!overlayEl.classList.contains('editable')) return;
  const el = event.target.closest('.text-preview, .watermark-preview');
  if (!el) return;
  event.preventDefault();
  const p = P();
  const isWatermark = el.dataset.watermark === '1';
  const source = isWatermark ? p.watermark : p.texts.find(l => l.id === el.dataset.textId);
  if (!source) return;
  if (!isWatermark) {
    p.selectedTextId = source.id; renderTextCards();
    overlayEl.querySelectorAll('.text-preview').forEach(node => node.classList.toggle('selected', node.dataset.textId === source.id));
  }
  overlayDrag = {
    el, isWatermark, id: el.dataset.textId, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    startLeft: parseFloat(el.style.left) || 0, startTop: parseFloat(el.style.top) || 0
  };
  try { overlayEl.setPointerCapture(event.pointerId); } catch (_) {}
});
overlayEl.addEventListener('pointermove', event => {
  if (!overlayDrag || overlayDrag.pointerId !== event.pointerId) return;
  const p = P();
  const fw = frameEl.clientWidth, fh = frameEl.clientHeight;
  const el = overlayDrag.el;
  const dx = event.clientX - overlayDrag.startX, dy = event.clientY - overlayDrag.startY;
  const left = overlayDrag.startLeft + dx, top = overlayDrag.startTop + dy;
  const xPct = clamp(left / Math.max(1, fw - el.offsetWidth), 0, 1);
  const yPct = clamp(top / Math.max(1, fh - el.offsetHeight), 0, 1);
  if (overlayDrag.isWatermark) {
    p.watermark.xPct = xPct; p.watermark.yPct = yPct;
    $('watermark-x').value = Math.round(xPct * 100); $('watermark-y').value = Math.round(yPct * 100);
  } else {
    const layer = p.texts.find(l => l.id === overlayDrag.id);
    if (layer) { layer.xPct = xPct; layer.yPct = yPct; }
  }
  el.style.left = `${xPct * Math.max(0, fw - el.offsetWidth)}px`;
  el.style.top = `${yPct * Math.max(0, fh - el.offsetHeight)}px`;
});
function endOverlayDrag(event) {
  if (overlayDrag && (!event || overlayDrag.pointerId === event.pointerId)) {
    try { overlayEl.releasePointerCapture(overlayDrag.pointerId); } catch (_) {}
    overlayDrag = null; commitHistory('Move overlay');
  }
}
overlayEl.addEventListener('pointerup', endOverlayDrag);
overlayEl.addEventListener('pointercancel', endOverlayDrag);

/* ---------- timeline / trim ---------- */
function selectedRange(p = P()) {
  const start = clamp(p.trimStart, 0, Math.max(0, p.duration - .05));
  const end = clamp(p.trimEnd || p.duration, start + .05, p.duration);
  return { start, end, duration: Math.max(.05, end - start) };
}

function updateTimelineUI() {
  const p = P();
  const dur = p.duration || 1;
  const range = selectedRange(p);
  const startPct = clamp(range.start / dur * 100, 0, 100);
  const endPct = clamp(range.end / dur * 100, 0, 100);
  const playPct = clamp(p.currentTime / dur * 100, 0, 100);
  $('trim-selection').style.left = `${startPct}%`;
  $('trim-selection').style.width = `${Math.max(0, endPct - startPct)}%`;
  $('trim-shade-left').style.width = `${startPct}%`;
  $('trim-shade-right').style.width = `${100 - endPct}%`;
  $('trim-handle-start').style.left = `${startPct}%`;
  $('trim-handle-end').style.left = `${endPct}%`;
  $('trim-handle-start').setAttribute('aria-valuenow', range.start.toFixed(3));
  $('trim-handle-end').setAttribute('aria-valuenow', range.end.toFixed(3));
  $('trim-playhead').style.left = `${playPct}%`;
  $('seek-bar').max = p.duration || 1;
  $('seek-bar').value = clamp(p.currentTime, 0, p.duration || 1);
  $('seek-progress').style.width = `${playPct}%`;
  $('time-current').textContent = formatTime(p.currentTime);
  $('time-total').textContent = formatTime(p.duration);
  if (document.activeElement !== $('trim-start-input')) $('trim-start-input').value = formatTime(range.start);
  if (document.activeElement !== $('trim-end-input')) $('trim-end-input').value = formatTime(range.end);
  $('trim-duration-readout').textContent = formatTime(range.duration);
  $('trim-speed-readout').textContent = formatTime(range.duration / clamp(p.speed, .5, 2));
  $('trim-frames-readout').textContent = String(Math.round(range.duration / clamp(p.speed, .5, 2) * p.output.fps));
  $('strip-duration').textContent = `${formatTime(range.duration)} selected`;
  renderSplitMarkers();
  updateOverlayVisibility();
}

function renderSplitMarkers() {
  const p = P(), dur = p.duration || 1;
  $('split-markers').innerHTML = p.splitPoints.map(t => `<div class="split-marker" style="left:${clamp(t / dur * 100, 0, 100)}%" title="${formatTime(t)}"></div>`).join('');
}

function setTrimValues(start, end, { updateMedia = false } = {}) {
  const p = P();
  if (!p.duration) { toast('Load media first', 'Timecodes become available after metadata is read.', 'error'); return; }
  p.trimStart = clamp(start, 0, p.duration - .05);
  p.trimEnd = clamp(end, p.trimStart + .05, p.duration);
  if (updateMedia) seekMedia(p.trimStart);
  updateTimelineUI();
  renderSplitUI();
}

let trimDrag = null;
function timeFromPointer(event) {
  const rect = $('trim-strip').getBoundingClientRect();
  return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * (P().duration || 1);
}
$('trim-strip').addEventListener('pointerdown', event => {
  const p = P();
  if (!sourceReady(p)) return;
  event.preventDefault();
  const t = timeFromPointer(event);
  const range = selectedRange(p);
  let mode;
  if (event.target.closest('#trim-handle-start')) mode = 'start';
  else if (event.target.closest('#trim-handle-end')) mode = 'end';
  else if (event.target.closest('#trim-selection')) mode = 'move';
  else mode = t < range.start || t > range.end ? (Math.abs(t - range.start) < Math.abs(t - range.end) ? 'start' : 'end') : 'seek';
  trimDrag = { mode, pointerId: event.pointerId, t, start: range.start, end: range.end, duration: range.duration };
  if (mode === 'start') setTrimValues(t, range.end, { updateMedia: true });
  if (mode === 'end') setTrimValues(range.start, t, { updateMedia: true });
  if (mode === 'seek') seekMedia(t, true);
  try { $('trim-strip').setPointerCapture(event.pointerId); } catch (_) {}
});
$('trim-strip').addEventListener('pointermove', event => {
  if (!trimDrag || trimDrag.pointerId !== event.pointerId) return;
  const t = timeFromPointer(event);
  const dt = t - trimDrag.t;
  const p = P();
  if (trimDrag.mode === 'start') { p.trimStart = clamp(t, 0, p.trimEnd - .05); seekMedia(p.trimStart, true); }
  else if (trimDrag.mode === 'end') { p.trimEnd = clamp(t, p.trimStart + .05, p.duration); seekMedia(p.trimEnd, true); }
  else if (trimDrag.mode === 'move') {
    const len = trimDrag.duration;
    const start = clamp(trimDrag.start + dt, 0, p.duration - len);
    p.trimStart = start; p.trimEnd = start + len;
    seekMedia(start, true);
  } else if (trimDrag.mode === 'seek') seekMedia(t, true);
  updateTimelineUI(); renderSplitUI();
});
function endTrimDrag(event) {
  if (trimDrag && (!event || trimDrag.pointerId === event.pointerId)) {
    try { $('trim-strip').releasePointerCapture(trimDrag.pointerId); } catch (_) {}
    trimDrag = null; renderSplitUI(); commitHistory('Trim drag');
  }
}
$('trim-strip').addEventListener('pointerup', endTrimDrag);
$('trim-strip').addEventListener('pointercancel', endTrimDrag);

function handleTrimKey(event, which) {
  const step = event.shiftKey ? 1 : 1 / (P().output.fps || 30);
  const range = selectedRange(P());
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault();
    if (which === 'start') setTrimValues(range.start - step, range.end, { updateMedia: true });
    else setTrimValues(range.start, range.end - step, { updateMedia: true });
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (which === 'start') setTrimValues(range.start + step, range.end, { updateMedia: true });
    else setTrimValues(range.start, range.end + step, { updateMedia: true });
  } else if (event.key === 'Home') {
    event.preventDefault(); setTrimValues(which === 'start' ? 0 : range.start + .05, which === 'start' ? range.end : range.end, { updateMedia: true });
  } else if (event.key === 'End') {
    event.preventDefault(); setTrimValues(which === 'start' ? range.end - .05 : range.start, which === 'start' ? range.end : P().duration, { updateMedia: true });
  }
  commitHistory('Trim key');
}

/* ---------- crop ---------- */
function ratioValue(p, key) {
  if (key === 'free' || !key) return null;
  if (key === 'original') return p.sourceW / Math.max(1, p.sourceH);
  if (key === 'output') return p.output.width / Math.max(1, p.output.height);
  const [a, b] = key.split(':').map(Number);
  return a && b ? a / b : null;
}
function normalizeCropValues(c, p, ratio = null) {
  const sw = even(p.sourceW), sh = even(p.sourceH);
  const minW = Math.max(16, even(sw * .06)), minH = Math.max(16, even(sh * .06));
  let x = clamp(c.x ?? 0, 0, Math.max(0, sw - minW));
  let y = clamp(c.y ?? 0, 0, Math.max(0, sh - minH));
  let w = clamp(c.w ?? sw, minW, sw - x);
  let h = clamp(c.h ?? sh, minH, sh - y);
  if (ratio) {
    if (w / h > ratio) h = w / ratio; else w = h * ratio;
    const scale = Math.min(1, (sw - x) / w, (sh - y) / h);
    w *= scale; h *= scale;
  }
  w = even(w); h = even(h); x = snapEven(x); y = snapEven(y);
  if (x + w > sw) w = even(sw - x);
  if (y + h > sh) h = even(sh - y);
  return { x, y, w: Math.max(2, w), h: Math.max(2, h) };
}
function applyCropRatio(key, { center = true } = {}) {
  const p = P();
  p.cropRatio = key;
  $$('#ratio-row .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.ratio === key));
  const ratio = ratioValue(p, key);
  if (!ratio) { updateCropOverlay(); return; }
  const cx = center ? p.crop.x + p.crop.w / 2 : p.sourceW / 2;
  const cy = center ? p.crop.y + p.crop.h / 2 : p.sourceH / 2;
  let w = Math.min(p.sourceW, p.sourceH * ratio);
  let h = w / ratio;
  if (h > p.sourceH) { h = p.sourceH; w = h * ratio; }
  let x = clamp(cx - w / 2, 0, p.sourceW - w);
  let y = clamp(cy - h / 2, 0, p.sourceH - h);
  p.crop = normalizeCropValues({ x, y, w, h }, p, ratio);
  refreshOutputSize(); updateCropOverlay();
}
function updateCropOverlay() {
  const p = P();
  const active = state.activePanel === 'crop';
  cropOverlay.hidden = !active || !sourceReady(p);
  overlayEl.classList.toggle('editable', state.activePanel === 'text' || state.activePanel === 'effects');
  if (cropOverlay.hidden) return;
  p.crop = normalizeCropValues(p.crop, p);
  cropBox.style.left = `${p.crop.x / p.sourceW * 100}%`;
  cropBox.style.top = `${p.crop.y / p.sourceH * 100}%`;
  cropBox.style.width = `${p.crop.w / p.sourceW * 100}%`;
  cropBox.style.height = `${p.crop.h / p.sourceH * 100}%`;
  $('crop-size').textContent = `${p.crop.w} × ${p.crop.h}`;
  $('crop-grid').classList.toggle('off', !$('crop-grid-toggle').checked);
  $('crop-x').value = p.crop.x; $('crop-y').value = p.crop.y;
  $('crop-w').value = p.crop.w; $('crop-h').value = p.crop.h;
}

let cropDrag = null;
function sourcePoint(event) {
  const rect = frameEl.getBoundingClientRect();
  const p = P();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1) * p.sourceW,
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1) * p.sourceH
  };
}
cropOverlay.addEventListener('pointerdown', event => {
  const p = P();
  if (!sourceReady(p)) return;
  event.preventDefault();
  const handle = event.target.closest('.crop-handle')?.dataset.handle;
  const inside = cropBox.contains(event.target);
  const start = sourcePoint(event);
  cropDrag = {
    pointerId: event.pointerId, handle,
    mode: handle ? 'resize' : inside ? 'move' : 'draw',
    startClientX: event.clientX, startClientY: event.clientY,
    start, startCrop: { ...p.crop }
  };
  try { cropOverlay.setPointerCapture(event.pointerId); } catch (_) {}
});
cropOverlay.addEventListener('pointermove', event => {
  if (!cropDrag || cropDrag.pointerId !== event.pointerId) return;
  const p = P();
  const rect = frameEl.getBoundingClientRect();
  const dx = (event.clientX - cropDrag.startClientX) / rect.width * p.sourceW;
  const dy = (event.clientY - cropDrag.startClientY) / rect.height * p.sourceH;
  const c = { ...cropDrag.startCrop };
  const ratio = ratioValue(p, p.cropRatio);
  if (cropDrag.mode === 'move') {
    c.x = cropDrag.startCrop.x + dx; c.y = cropDrag.startCrop.y + dy;
    c.x = clamp(c.x, 0, p.sourceW - c.w); c.y = clamp(c.y, 0, p.sourceH - c.h);
  } else if (cropDrag.mode === 'draw') {
    const end = { x: clamp(cropDrag.start.x + dx, 0, p.sourceW), y: clamp(cropDrag.start.y + dy, 0, p.sourceH) };
    c.x = Math.min(cropDrag.start.x, end.x); c.y = Math.min(cropDrag.start.y, end.y);
    c.w = Math.abs(end.x - cropDrag.start.x); c.h = Math.abs(end.y - cropDrag.start.y);
  } else {
    const h = cropDrag.handle;
    let left = cropDrag.startCrop.x, top = cropDrag.startCrop.y;
    let right = left + c.w, bottom = top + c.h;
    if (h.includes('w')) left = clamp(left + dx, 0, right - 16);
    if (h.includes('e')) right = clamp(right + dx, left + 16, p.sourceW);
    if (h.includes('n')) top = clamp(top + dy, 0, bottom - 16);
    if (h.includes('s')) bottom = clamp(bottom + dy, top + 16, p.sourceH);
    c.x = left; c.y = top; c.w = right - left; c.h = bottom - top;
  }
  p.crop = normalizeCropValues(c, p, ratio);
  updateCropOverlay();
});
function endCropDrag(event) {
  if (cropDrag && (!event || cropDrag.pointerId === event.pointerId)) {
    try { cropOverlay.releasePointerCapture(cropDrag.pointerId); } catch (_) {}
    cropDrag = null; refreshOutputSize(); updateCropOverlay(); commitHistory('Crop drag');
  }
}
cropOverlay.addEventListener('pointerup', endCropDrag);
cropOverlay.addEventListener('pointercancel', endCropDrag);

/* ---------- text layers ---------- */
function makeTextLayer(preset = 'custom') {
  const p = P();
  const base = {
    id: uid(), text: 'Your text', font: 'space', weight: 700,
    sizePct: .065, color: '#ffd180', background: false, bgColor: '#000000',
    outline: true, outlineColor: '#100805', opacity: 1, align: 'center', rtl: false,
    xPct: .5, yPct: .5, start: 0, end: 0
  };
  if (preset === 'title') Object.assign(base, { text: 'A NEW CHAPTER', sizePct: .095, color: '#ffd180', xPct: .5, yPct: .10, background: false, outline: true, start: 0, end: Math.min(p.duration || 3, 3) });
  if (preset === 'caption') Object.assign(base, { text: 'Type your caption here', font: 'inter', weight: 600, sizePct: .045, color: '#ffffff', xPct: .5, yPct: .82, background: true, bgColor: '#000000', outline: false, opacity: .95, start: 0, end: 0 });
  return base;
}
function addTextLayer(preset = 'custom') {
  const p = P();
  if (p.texts.length >= 10) { toast('Layer limit', 'Up to 10 text layers are supported.', 'error'); return; }
  const layer = makeTextLayer(preset);
  p.texts.push(layer); p.selectedTextId = layer.id;
  renderTextCards(); renderOverlayDOM(); commitHistory('Add text layer');
  toast('Text layer added', 'Drag it on the preview, then fine-tune the card.');
}
function selected(value, key) { return String(value) === String(key) ? 'selected' : ''; }
function renderTextCards() {
  const p = P();
  const host = $('text-layers');
  if (!p.texts.length) {
    host.innerHTML = '<div class="text-layer-empty"><svg class="icon"><use href="#i-type"/></svg><div>No text layers yet.<br>Add one and drag it directly on the preview.</div></div>';
    return;
  }
  host.innerHTML = p.texts.map((l, i) => `
    <div class="text-layer-card${p.selectedTextId === l.id ? ' selected' : ''}" data-id="${l.id}">
      <div class="layer-head"><span class="layer-index">${String(i + 1).padStart(2, '0')}</span><span class="layer-title">${esc((l.text || 'Text layer').split('\n')[0].slice(0, 38))}</span><div class="layer-actions"><button class="mini-btn" data-action="duplicate" title="Duplicate"><svg class="icon"><use href="#i-copy"/></svg></button><button class="mini-btn danger" data-action="delete" title="Delete"><svg class="icon"><use href="#i-trash"/></svg></button></div></div>
      <div class="layer-form">
        <div class="layer-grid">
          <label class="field"><span>Text</span><textarea data-k="text" spellcheck="false">${esc(l.text)}</textarea></label>
          <label class="field"><span>Font</span><select data-k="font"><option value="space" ${selected(l.font, 'space')}>Space Grotesk</option><option value="inter" ${selected(l.font, 'inter')}>Inter</option><option value="arabic" ${selected(l.font, 'arabic')}>Noto Arabic</option><option value="mono" ${selected(l.font, 'mono')}>Monospace</option></select></label>
          <label class="field"><span>Weight</span><select data-k="weight"><option value="400" ${selected(l.weight, 400)}>Regular</option><option value="600" ${selected(l.weight, 600)}>Semibold</option><option value="700" ${selected(l.weight, 700)}>Bold</option><option value="800" ${selected(l.weight, 800)}>Extra</option></select></label>
        </div>
        <div class="layer-controls">
          <label class="range-field"><span>Size <b data-value-for="sizePct">${Math.round(l.sizePct * 1000) / 10}%</b></span><input data-k="sizePct" type="range" min="0.02" max="0.18" step="0.005" value="${l.sizePct}"></label>
          <label class="field"><span>Color</span><div class="color-input"><input data-k="color" type="color" value="${esc(l.color)}"><code>${esc(l.color.toUpperCase())}</code></div></label>
          <label class="range-field"><span>Opacity <b data-value-for="opacity">${Math.round(l.opacity * 100)}%</b></span><input data-k="opacity" type="range" min="0.1" max="1" step="0.01" value="${l.opacity}"></label>
        </div>
        <div class="layer-controls">
          <button class="toggle-btn${l.background ? ' active' : ''}" data-action="toggle-bg" type="button"><svg class="icon"><use href="#i-image"/></svg> Background</button>
          <button class="toggle-btn${l.outline ? ' active' : ''}" data-action="toggle-outline" type="button"><svg class="icon"><use href="#i-type"/></svg> Outline</button>
          <label class="field"><span>Align</span><select data-k="align"><option value="left" ${selected(l.align, 'left')}>Left</option><option value="center" ${selected(l.align, 'center')}>Center</option><option value="right" ${selected(l.align, 'right')}>Right</option></select></label>
        </div>
        <div class="layer-bottom">
          <label class="field"><span>Visible from</span><input data-k="start" type="text" inputmode="decimal" value="${formatTime(l.start)}"></label>
          <label class="field"><span>Until <small>(END = full)</small></span><input data-k="end" type="text" inputmode="decimal" value="${l.end > 0 ? formatTime(l.end) : 'END'}"></label>
          <div class="position-presets"><button type="button" data-x="0.5" data-y="0.08" title="Top center">↑</button><button type="button" data-x="0.5" data-y="0.5" title="Center">•</button><button type="button" data-x="0.5" data-y="0.86" title="Bottom center">↓</button></div>
        </div>
      </div>
    </div>`).join('');
}
function cardLayer(card) { return card ? P().texts.find(l => l.id === card.dataset.id) : null; }
$('text-layers').addEventListener('input', event => {
  const card = event.target.closest('.text-layer-card'); const layer = cardLayer(card);
  const k = event.target.dataset.k;
  if (!layer || !k || k === 'start' || k === 'end') return;
  const numeric = ['sizePct', 'opacity', 'weight'].includes(k);
  layer[k] = numeric ? Number(event.target.value) : event.target.value;
  if (k === 'sizePct') card.querySelector('[data-value-for="sizePct"]').textContent = `${Math.round(layer.sizePct * 1000) / 10}%`;
  if (k === 'opacity') card.querySelector('[data-value-for="opacity"]').textContent = `${Math.round(layer.opacity * 100)}%`;
  if (k === 'color') card.querySelector('code').textContent = layer.color.toUpperCase();
  if (k === 'text') card.querySelector('.layer-title').textContent = (layer.text || 'Text layer').split('\n')[0].slice(0, 38);
  renderOverlayDOM();
});
$('text-layers').addEventListener('change', event => {
  const card = event.target.closest('.text-layer-card'); const layer = cardLayer(card);
  const k = event.target.dataset.k;
  if (!layer || (k !== 'start' && k !== 'end')) return;
  if (k === 'start') {
    const value = parseTime(event.target.value, NaN);
    layer.start = Number.isFinite(value) ? clamp(value, 0, P().duration || 0) : 0;
  } else {
    const raw = event.target.value.trim().toLowerCase();
    const value = raw === 'end' || raw === '' ? 0 : parseTime(raw, NaN);
    layer.end = Number.isFinite(value) ? clamp(value, 0, P().duration || 0) : 0;
  }
  renderTextCards(); renderOverlayDOM(); updateTimelineUI();
});
$('text-layers').addEventListener('click', event => {
  const card = event.target.closest('.text-layer-card');
  if (!card) return;
  const layer = cardLayer(card);
  const p = P();
  p.selectedTextId = layer?.id || null;
  const action = event.target.closest('[data-action]')?.dataset.action;
  const pos = event.target.closest('[data-x]');
  if (pos && layer) { layer.xPct = Number(pos.dataset.x); layer.yPct = Number(pos.dataset.y); }
  if (action === 'duplicate' && layer) {
    const copy = { ...layer, id: uid(), xPct: clamp(layer.xPct + .04, 0, 1), yPct: clamp(layer.yPct + .04, 0, 1) };
    p.texts.push(copy); p.selectedTextId = copy.id;
  }
  if (action === 'delete' && layer) {
    p.texts = p.texts.filter(l => l.id !== layer.id);
    p.selectedTextId = p.texts[0]?.id || null;
  }
  if (action === 'toggle-bg' && layer) layer.background = !layer.background;
  if (action === 'toggle-outline' && layer) layer.outline = !layer.outline;
  renderTextCards(); renderOverlayDOM();
});

/* ---------- segment state, delete options, per-part editing ---------- */
function editableSnapshot(p) {
  const out = {};
  for (const key of EDITABLE_KEYS) out[key] = cloneValue(p[key]);
  return out;
}
function applyEditable(p, edits) {
  for (const key of EDITABLE_KEYS) if (key in edits) p[key] = cloneValue(edits[key]);
}
function saveActiveSegment(p) {
  if (!p.activeSegmentId || !p.segments) return;
  const seg = p.segments.find(s => s.id === p.activeSegmentId);
  if (seg) seg.overrides = editableSnapshot(p);
}
function syncSegments(p = P()) {
  saveActiveSegment(p);
  const range = selectedRange(p);
  const ranges = segmentRanges(p.splitPoints, range.start, range.end, MAX_SEGMENTS);
  const old = p.segments || [];
  const next = ranges.map((r, i) => {
    const key = `${Math.round(r.start * 1000)}-${Math.round(r.end * 1000)}`;
    let found = old.find(s => s.key === key);
    if (!found && old[i] && Math.abs(old[i].start - r.start) < .3) found = old[i];
    return {
      id: found?.id || uid(), key, start: r.start, end: r.end, duration: r.duration,
      removed: !!found?.removed, overrides: found?.overrides ? cloneValue(found.overrides) : null
    };
  });
  p.segments = next;
  if (p.activeSegmentId && !next.some(s => s.id === p.activeSegmentId)) p.activeSegmentId = null;
  if (p.activeSegmentId) {
    const seg = next.find(s => s.id === p.activeSegmentId);
    if (seg) {
      p.trimStart = clamp(p.trimStart, seg.start, seg.end - .05);
      p.trimEnd = clamp(p.trimEnd, p.trimStart + .05, seg.end);
    }
  }
  return next;
}
function keptSegments(p = P()) { syncSegments(p); return p.segments.filter(s => !s.removed); }
function segmentProject(p, seg) {
  const base = cloneValue(p.globalEdits || editableSnapshot(p));
  const edits = seg.overrides ? cloneValue(seg.overrides) : base;
  const q = { ...p };
  applyEditable(q, edits);
  q.trimStart = seg.start; q.trimEnd = seg.end;
  q.splitPoints = []; q.segments = []; q.activeSegmentId = null; q.globalEdits = null;
  Object.assign(q.output, computeOutputSize(q));
  return q;
}
function focusSegment(id, { commit = true } = {}) {
  const p = P();
  syncSegments(p);
  saveActiveSegment(p);
  if (!p.globalEdits) p.globalEdits = editableSnapshot(p);
  const seg = id ? p.segments.find(s => s.id === id && !s.removed) : null;
  p.activeSegmentId = seg?.id || null;
  const edits = seg?.overrides ? cloneValue(seg.overrides) : cloneValue(p.globalEdits);
  if (seg) {
    edits.trimStart = clamp(edits.trimStart ?? seg.start, seg.start, seg.end - .05);
    edits.trimEnd = clamp(edits.trimEnd ?? seg.end, edits.trimStart + .05, seg.end);
  }
  applyEditable(p, edits);
  updateAll();
  if (commit) commitHistory(seg ? `Edit part ${p.segments.findIndex(s => s.id === seg.id) + 1}` : 'Edit all parts');
}
function removeSegment(id, { commit = true } = {}) {
  const p = P();
  syncSegments(p);
  const seg = p.segments.find(s => s.id === id);
  if (!seg) return;
  const kept = p.segments.filter(s => !s.removed).length;
  if (!seg.removed && kept <= 1) { toast('Keep one part', 'At least one part must stay in the timeline.', 'error'); return; }
  saveActiveSegment(p);
  seg.removed = !seg.removed;
  if (seg.removed && p.activeSegmentId === seg.id) focusSegment(null, { commit: false });
  updateAll();
  if (commit) commitHistory(seg.removed ? 'Remove part' : 'Restore part');
}
function restoreSegment(id, opts = {}) { removeSegment(id, opts); }
function resetSegmentEdits(id, { commit = true } = {}) {
  const p = P(); syncSegments(p);
  const seg = p.segments.find(s => s.id === id);
  if (!seg) return;
  saveActiveSegment(p);
  seg.overrides = null;
  if (p.activeSegmentId === seg.id) focusSegment(null, { commit: false });
  updateAll();
  if (commit) commitHistory('Reset part edits');
}
function deleteBeforeCut(index) {
  const p = P(); const t = p.splitPoints[index];
  if (!Number.isFinite(t)) return;
  syncSegments(p);
  if (p.activeSegmentId) focusSegment(null, { commit: false });
  const range = selectedRange(p);
  const start = clamp(t, range.start, range.end - .05);
  p.trimStart = start;
  p.trimEnd = clamp(Math.max(p.trimEnd, start + .05), start + .05, p.duration || start + .05);
  p.splitPoints = p.splitPoints.filter(x => x > start + .05);
  syncSegments(p); updateAll(); commitHistory('Delete before cut');
  toast('Before cut removed', `Timeline now starts at ${formatTime(start)}.`);
}
function deleteAfterCut(index) {
  const p = P(); const t = p.splitPoints[index];
  if (!Number.isFinite(t)) return;
  syncSegments(p);
  if (p.activeSegmentId) focusSegment(null, { commit: false });
  const range = selectedRange(p);
  const end = clamp(t, range.start + .05, range.end);
  p.trimEnd = end;
  p.trimStart = clamp(Math.min(p.trimStart, end - .05), 0, end - .05);
  p.splitPoints = p.splitPoints.filter(x => x < end - .05);
  syncSegments(p); updateAll(); commitHistory('Delete after cut');
  toast('After cut removed', `Timeline now ends at ${formatTime(end)}.`);
}
function renderSegmentUI(p) {
  const segs = p.segments || [];
  const kept = segs.filter(s => !s.removed);
  const host = $('segment-list');
  if (host) host.innerHTML = segs.map((s, i) => `
    <div class="segment-card${s.removed ? ' removed' : ''}${p.activeSegmentId === s.id ? ' focused' : ''}" data-seg="${esc(s.id)}">
      <div class="segment-head"><b>PART ${String(i + 1).padStart(2, '0')}</b><span>${formatTime(s.start)} → ${formatTime(s.end)} · ${formatTime(s.duration)}</span><em>${s.removed ? 'REMOVED' : 'KEPT'}</em></div>
      <div class="segment-actions">
        <button type="button" data-seg-action="focus" ${s.removed ? 'disabled' : ''}>Edit this part</button>
        <button type="button" data-seg-action="reset">Reset part</button>
        <button type="button" data-seg-action="remove" class="${s.removed ? 'restore' : 'danger'}">${s.removed ? 'Restore part' : 'Remove part'}</button>
      </div>
      <small>${s.overrides ? 'Independent edits saved' : 'Uses all-part edits'} · all 7 modules available</small>
    </div>`).join('');
  const focusHost = $('segment-focus-buttons');
  if (focusHost) focusHost.innerHTML = `<button type="button" data-focus="" class="${!p.activeSegmentId ? 'active' : ''}">All parts</button>` +
    segs.map((s, i) => `<button type="button" data-focus="${esc(s.id)}" class="${p.activeSegmentId === s.id ? 'active' : ''}" ${s.removed ? 'disabled' : ''}>P${i + 1}</button>`).join('');
  const activeIndex = segs.findIndex(s => s.id === p.activeSegmentId);
  if ($('segment-focus-label')) $('segment-focus-label').textContent = activeIndex >= 0 ? `Part ${activeIndex + 1}` : 'All parts';
  if ($('segment-focus-chip')) $('segment-focus-chip').textContent = activeIndex >= 0 ? `EDITING PART ${activeIndex + 1}` : 'EDITING ALL PARTS';
  if ($('segment-count')) $('segment-count').textContent = String(kept.length);
  if ($('split-summary')) $('split-summary').textContent = `${kept.length} kept part${kept.length === 1 ? '' : 's'} of ${segs.length}`;
  if ($('split-scope')) $('split-scope').textContent = 'Delete any part, or edit one part with all modules';
}
function renderSplitUI() {
  const p = P();
  syncSegments(p);
  const range = selectedRange(p);
  $('split-count').textContent = String(p.splitPoints.length);
  const points = $('split-points');
  points.innerHTML = p.splitPoints.length ? p.splitPoints.map((t, i) => `<div class="split-point" data-index="${i}"><i></i><input type="text" value="${formatTime(t)}" aria-label="Cut ${i + 1} time"><div class="cut-actions"><button type="button" data-cut-action="before" title="Delete everything before this cut">Del before</button><button type="button" data-cut-action="after" title="Delete everything after this cut">Del after</button><button type="button" data-remove="${i}" aria-label="Remove cut"><svg class="icon tiny"><use href="#i-close"/></svg></button></div></div>`).join('') : '<p class="empty-mini">No cuts yet. Move the playhead, then add a marker.</p>';
  $('segment-preview').innerHTML = (p.segments || []).map((s, i) => `<div class="segment-row${s.removed ? ' removed' : ''}"><b>${String(i + 1).padStart(2, '0')}</b><span>${formatTime(s.start)} → ${formatTime(s.end)} · ${formatTime(s.duration)}</span><em>${s.removed ? 'REMOVED' : 'KEPT'}</em></div>`).join('');
  renderSegmentUI(p);
}
function addSplitAt(time = P().currentTime) {
  const p = P(), range = selectedRange(p);
  if (!sourceReady(p)) { toast('Load media first', 'Split markers need a loaded timeline.', 'error'); return; }
  const t = clamp(time, range.start, range.end);
  if (t <= range.start + .05 || t >= range.end - .05) { toast('Move inside the range', 'A cut must sit between the trim handles.', 'error'); return; }
  if (p.splitPoints.some(existing => Math.abs(existing - t) < .08)) { toast('Cut already here', 'Move the playhead a little and try again.'); return; }
  if (p.splitPoints.length >= MAX_SEGMENTS - 1) { toast('Segment limit', `A ZIP can contain up to ${MAX_SEGMENTS} segments.`, 'error'); return; }
  p.splitPoints.push(t); p.splitPoints.sort((a, b) => a - b);
  syncSegments(p); updateTimelineUI(); renderSplitUI();
  commitHistory('Add split');
  toast('Part created', `${p.segments.length} separate parts · remove or edit any part below.`);
}
function autoSplit() {
  const p = P(), range = selectedRange(p);
  const seconds = clamp(Number($('auto-split-seconds').value) || 5, .5, 3600);
  const points = [];
  for (let t = range.start + seconds; t < range.end - .05; t += seconds) {
    if (points.length >= MAX_SEGMENTS - 1) break;
    points.push(Number(t.toFixed(3)));
  }
  if (!points.length) { toast('Range is too short', 'Use a smaller interval or a longer selection.', 'error'); return; }
  p.splitPoints = points;
  syncSegments(p); updateTimelineUI(); renderSplitUI();
  commitHistory('Auto split');
  toast('Cuts generated', `${points.length} markers · ${p.segments.length} separate parts`);
}

/* ---------- effects + output ---------- */
function syncOutputFromDOM({ render = true } = {}) {
  const p = P();
  const tier = clamp(Number($('output-quality-tier')?.value) || 720, 360, 720);
  const shape = $('output-shape')?.value || 'original';
  const customW = clamp(Number($('ratio-w')?.value) || 16, 1, 99);
  const customH = clamp(Number($('ratio-h')?.value) || 9, 1, 99);
  const fps = clamp(Number($('output-fps')?.value) || 30, 1, 60);
  const crf = Number($('output-quality')?.value) || 23;
  const background = $('output-bg')?.value || '#000000';
  Object.assign(p.output, { qualityTier: tier, shape, customW, customH, fps, crf, background });
  Object.assign(p.output, computeOutputSize(p));
  if (render) updateOutputUI();
}
function updateOutputUI() {
  const p = P(), o = p.output;
  if ($('output-quality-tier')) $('output-quality-tier').value = String(o.qualityTier || 720);
  if ($('output-shape')) $('output-shape').value = o.shape || 'original';
  if ($('ratio-w')) $('ratio-w').value = o.customW || 16;
  if ($('ratio-h')) $('ratio-h').value = o.customH || 9;
  if ($('custom-ratio')) $('custom-ratio').hidden = o.shape !== 'custom';
  if ($('output-preset')) $('output-preset').value = 'shape';
  if ($('output-width')) $('output-width').value = o.width;
  if ($('output-height')) $('output-height').value = o.height;
  if ($('output-fps')) $('output-fps').value = String(o.fps);
  if ($('output-quality')) $('output-quality').value = String(o.crf);
  if ($('output-bg')) $('output-bg').value = o.background;
  if ($('output-bg-code')) $('output-bg-code').textContent = (o.background || '#000000').toUpperCase();
  if ($('custom-size')) $('custom-size').hidden = true;
  if ($('output-size-readout')) $('output-size-readout').textContent = `${o.width}×${o.height} · ${o.qualityTier}p cap`;
  if ($('resolution-pill')) $('resolution-pill').textContent = `${o.width}×${o.height} · ${o.fps}fps`;
}
function refreshOutputSize() {
  syncOutputFromDOM({ render: true });
  renderOverlayDOM();
  lightPreview?.markDirty();
}

function syncEffectsFromDOM({ render = true } = {}) {
  const p = P();
  p.speed = clamp(Number($('speed-range').value) || 1, .5, 2);
  p.volume = clamp(Number($('volume-range').value) / 100 || 0, 0, 2);
  p.color = {
    brightness: Number($('brightness-range').value),
    contrast: Number($('contrast-range').value),
    saturation: Number($('saturation-range').value),
    gamma: Number($('gamma-range').value)
  };
  p.watermark.scale = clamp(Number($('watermark-scale').value) / 100 || .18, .03, .6);
  p.watermark.opacity = clamp(Number($('watermark-opacity').value) / 100 || .8, .05, 1);
  p.watermark.xPct = clamp(Number($('watermark-x').value) / 100 || 0, 0, 1);
  p.watermark.yPct = clamp(Number($('watermark-y').value) / 100 || 0, 0, 1);
  if (render) updateEffectsUI();
}
function updateEffectsUI() {
  const p = P();
  $('speed-range').value = p.speed; $('volume-range').value = Math.round(p.volume * 100);
  $('speed-value').textContent = `${p.speed.toFixed(2)}×`; $('volume-value').textContent = `${Math.round(p.volume * 100)}%`;
  $('brightness-range').value = p.color.brightness; $('contrast-range').value = p.color.contrast;
  $('saturation-range').value = p.color.saturation; $('gamma-range').value = p.color.gamma;
  $('brightness-value').textContent = p.color.brightness.toFixed(2); $('contrast-value').textContent = p.color.contrast.toFixed(2);
  $('saturation-value').textContent = p.color.saturation.toFixed(2); $('gamma-value').textContent = p.color.gamma.toFixed(2);
  $('watermark-scale').value = Math.round(p.watermark.scale * 100); $('watermark-opacity').value = Math.round(p.watermark.opacity * 100);
  $('watermark-x').value = Math.round(p.watermark.xPct * 100); $('watermark-y').value = Math.round(p.watermark.yPct * 100);
  $('watermark-scale-value').textContent = `${Math.round(p.watermark.scale * 100)}%`;
  $('watermark-opacity-value').textContent = `${Math.round(p.watermark.opacity * 100)}%`;
  $('watermark-label').textContent = p.watermarkFile ? (p.watermarkFile.name.length > 22 ? `${p.watermarkFile.name.slice(0, 20)}…` : p.watermarkFile.name) : 'Choose PNG / JPG';
  $$('#rotate-row .chip').forEach(chip => chip.classList.toggle('active', Number(chip.dataset.rotate) === p.transform.rotate));
  $('flip-h-btn').classList.toggle('active', p.transform.flipH);
  $('flip-v-btn').classList.toggle('active', p.transform.flipV);
  $('mute-btn').classList.toggle('active', p.mute);
  $('mute-btn').innerHTML = `<svg class="icon"><use href="#i-${p.mute ? 'mute' : 'volume'}"/></svg> ${p.mute ? 'Unmute output' : 'Mute output'}`;
  videoEl.playbackRate = p.speed; audioEl.playbackRate = p.speed;
  videoEl.muted = p.mute; audioEl.muted = p.mute;
  videoEl.volume = clamp(p.volume, 0, 1); audioEl.volume = clamp(p.volume, 0, 1);
  applyPreviewTransform(); applyPreviewFilters();
  lightPreview?.markDirty();
}

function renderWaveform() {
  const p = state.projects.audio;
  drawWaveform($('waveform-canvas'), p.peaks);
  $('audio-duration-label').textContent = formatTime(p.duration);
}

/* ---------- render assets + FFmpeg contexts ---------- */
function fileKey(file) {
  return safeName(`${file?.name || 'file'}-${file?.size || 0}-${file?.lastModified || 0}`).replace(/[^a-z0-9_-]/gi, '');
}
async function writeSource(file, role, fallback) {
  if (!file) throw new Error(`Missing ${role} file`);
  const name = `mvs-${role}-${fileKey(file)}${extensionOf(file, fallback)}`;
  if (!state.written.has(file)) {
    await engine.write(name, file, { force: true });
    state.written.set(file, name);
  }
  return state.written.get(file);
}
async function prepareSourceNames(p) {
  if (state.mode === 'video') {
    return { videoName: await writeSource(p.videoFile, 'video', '.mp4') };
  }
  if (p.coverPromise) await p.coverPromise;
  if (!p.imageFile) throw new Error('Add or generate a cover image first.');
  return {
    audioName: await writeSource(p.audioFile, 'audio', '.mp3'),
    coverName: await writeSource(p.imageFile, 'cover', '.png')
  };
}
function renderSizeFor(kind, p) {
  const out = computeOutputSize(p);
  if (kind === 'gif' || kind === 'contact') {
    const ratio = out.height / Math.max(1, out.width);
    return { width: 480, height: even(Math.round(480 * ratio)) };
  }
  return { width: out.width, height: out.height };
}
async function prepareOverlayAssets(p, width, height) {
  const defs = [];
  const names = [];
  for (const layer of p.texts) {
    const rendered = await renderTextLayer(layer, width, height);
    const name = `mvs-text-${layer.id.replace(/[^a-z0-9-]/gi, '')}.png`;
    await engine.write(name, rendered.blob, { force: true });
    names.push(name);
    defs.push({
      name, width: rendered.width, height: rendered.height,
      xPct: layer.xPct, yPct: layer.yPct,
      start: clamp(layer.start, 0, p.duration || 0),
      end: layer.end > 0 ? clamp(layer.end, 0, p.duration || 0) : (p.duration || 0)
    });
  }
  if (p.watermarkFile) {
    const rendered = await renderWatermark(p.watermarkFile, width, height, p.watermark.scale, p.watermark.opacity);
    const name = `mvs-logo-${fileKey(p.watermarkFile)}-${width}x${height}.png`;
    await engine.write(name, rendered.blob, { force: true });
    names.push(name);
    defs.push({
      name, width: rendered.width, height: rendered.height,
      xPct: p.watermark.xPct, yPct: p.watermark.yPct,
      start: 0, end: p.duration || 0
    });
  }
  return { defs, names };
}
function makeContext(p, options) {
  const { range, kind, outputName, overlayMode = 'timed', staticTime = 0, sourceNames = {}, overlayAssets = { defs: [] } } = options;
  const speed = kind === 'snapshot' ? 1 : clamp(p.speed, .5, 2);
  let overlays;
  if (overlayMode === 'static') {
    overlays = overlayAssets.defs
      .filter(def => staticTime >= def.start - .001 && staticTime <= (def.end || p.duration) + .001)
      .map((def, index) => ({ ...def, index, start: 0, end: 1 }));
  } else {
    overlays = overlaysForRange(overlayAssets.defs, range.start, range.start + range.duration, speed, 'timed');
  }
  return {
    mode: state.mode === 'audio' ? 'audio' : 'video',
    videoName: sourceNames.videoName, audioName: sourceNames.audioName, coverName: sourceNames.coverName,
    range: { start: range.start, duration: range.duration },
    source: { width: p.sourceW, height: p.sourceH, duration: p.duration },
    crop: { ...p.crop }, transform: { ...p.transform }, color: { ...p.color },
    speed, volume: p.volume, mute: p.mute,
    output: { ...p.output, qualityShort: p.output?.qualityShort || computeOutputSize(p).qualityShort }, overlays, overlayMode, outputName
  };
}
async function ensureMedia(p = P()) {
  if (state.mode === 'video') {
    if (!p.videoFile || !p.duration) throw new Error('Load a video before rendering.');
  } else {
    if (!p.audioFile || !p.duration) throw new Error('Load an audio file before rendering.');
    if (p.coverPromise) await p.coverPromise;
    if (!p.imageFile) throw new Error('Add or generate a cover image first.');
  }
  const range = selectedRange(p);
  if (range.duration < .06) throw new Error('Select at least 0.06 seconds in the trim range.');
}

async function withExport(label, fn) {
  if (state.busy) { toast('Already rendering', 'Wait for the current export to finish.'); return; }
  state.cancelled = false;
  setBusy(true, label);
  try {
    await fn();
    setProgress(100, 'Complete');
    setTimeout(() => { if (!state.busy) $('progress-block').hidden = true; }, 1200);
  } catch (error) {
    console.error('[MVS export]', error, engine.getLogTail());
    if (/cancelled/i.test(String(error?.message))) toast('Render cancelled', 'The local engine was reset.', 'info');
    else toast('Render could not finish', friendlyError(error), 'error');
  } finally {
    state.busy = false;
    renderButtons.forEach(id => { const el = $(id); if (el) el.disabled = false; });
    $('cancel-export-btn').disabled = false;
  }
}

async function renderSegmentFile(p, seg, index, sourceNames, size, label) {
  const q = segmentProject(p, seg);
  const range = { start: seg.start, duration: seg.duration };
  setProgress(27, 'Preparing text and logo layers');
  const overlayAssets = await prepareOverlayAssets(q, size.width, size.height);
  const outputName = `mvs_seg_${Date.now()}_${index}.mp4`;
  const ctx = makeContext(q, { range, kind: 'mp4', outputName, sourceNames, overlayAssets });
  const plan = buildVideoPlan(ctx, 'mp4');
  await engine.exec(plan.args, { label, from: 30, to: 86 });
  const bytes = await engine.readBytes(outputName);
  if (bytes.length < 512) throw new Error(`${label} was empty.`);
  return { name: outputName, bytes, overlayNames: overlayAssets.names };
}

async function exportMp4() {
  await withExport('Preparing MP4 render', async () => {
    const p = P(); await ensureMedia(p);
    syncSegments(p); saveActiveSegment(p);
    const sourceNames = await prepareSourceNames(p);
    const size = renderSizeFor('mp4', p);
    const all = p.segments || [];
    const kept = all.filter(s => !s.removed);
    const hasOverrides = all.some(s => s.overrides);
    const stitch = state.mode === 'video' && p.splitPoints.length > 0 && (kept.length !== all.length || hasOverrides);

    if (!stitch) {
      setProgress(27, 'Preparing text and logo layers');
      const overlayAssets = await prepareOverlayAssets(p, size.width, size.height);
      const outputName = `mvs_out_${Date.now()}.mp4`;
      const ctx = makeContext(p, { range: selectedRange(p), kind: 'mp4', outputName, sourceNames, overlayAssets });
      const plan = buildVideoPlan(ctx, 'mp4');
      await engine.exec(plan.args, { label: 'Rendering MP4', from: 30, to: 90 });
      setProgress(93, 'Finalizing MP4');
      const blob = await engine.read(outputName, 'video/mp4');
      if (blob.size < 512) throw new Error('The MP4 output was empty.');
      await engine.remove([outputName, ...overlayAssets.names]);
      addResult(blob, `Make-It-Fast-Edit-Arsenal-${stamp()}.mp4`, 'video', true);
      toast('MP4 is ready', `Saved at ${size.width}×${size.height} with H.264 + AAC.`, 'success');
      return;
    }

    if (!kept.length) throw new Error('Restore at least one part before rendering.');
    const finalName = `mvs_out_${Date.now()}.mp4`;
    const listName = `mvs_concat_${Date.now()}.txt`;
    const tempNames = [];
    try {
      for (let i = 0; i < kept.length; i++) {
        if (state.cancelled) throw new Error('Render cancelled');
        const out = await renderSegmentFile(p, kept[i], i, sourceNames, size, `Part ${i + 1} of ${kept.length}`);
        tempNames.push(out.name);
        await engine.remove(out.overlayNames);
        setProgress(28 + (i + 1) / kept.length * 58, `Prepared part ${i + 1} of ${kept.length}`);
      }
      const list = tempNames.map(name => `file '${name}'`).join('\n') + '\n';
      await engine.write(listName, list, { force: true });
      await engine.exec(buildConcatPlan(listName, finalName).args, { label: 'Joining kept parts', from: 88, to: 95 });
      const blob = await engine.read(finalName, 'video/mp4');
      if (blob.size < 512) throw new Error('The MP4 output was empty.');
      addResult(blob, `Make-It-Fast-Edit-Arsenal-${stamp()}.mp4`, 'video', true);
      toast('MP4 is ready', `${kept.length} kept parts joined · H.264 + AAC.`, 'success');
    } finally {
      await engine.remove([finalName, listName, ...tempNames]);
    }
  });
}

async function exportSplitZip() {
  await withExport('Preparing split render', async () => {
    const p = P(); await ensureMedia(p);
    syncSegments(p); saveActiveSegment(p);
    if (!p.splitPoints.length) { toast('Add a cut first', 'Place at least one marker inside the selected range.'); return; }
    const kept = (p.segments || []).filter(s => !s.removed);
    if (!kept.length) throw new Error('Restore at least one part before rendering.');
    const sourceNames = await prepareSourceNames(p);
    const size = renderSizeFor('mp4', p);
    const files = [];
    const tempNames = [];
    try {
      for (let i = 0; i < kept.length; i++) {
        if (state.cancelled) throw new Error('Render cancelled');
        const r = kept[i];
        const out = await renderSegmentFile(p, r, i, sourceNames, size, `Part ${i + 1} of ${kept.length}`);
        tempNames.push(out.name);
        await engine.remove(out.overlayNames);
        const name = `${String(i + 1).padStart(2, '0')}-${formatTime(r.start, false).replace(/:/g, '-')}-${formatTime(r.end, false).replace(/:/g, '-')}.mp4`;
        files.push({ name, data: out.bytes });
        setProgress(28 + (i + 1) / kept.length * 62, `Prepared part ${i + 1} of ${kept.length}`);
      }
      setProgress(93, 'Building segment ZIP');
      const zip = createZip(files);
      addResult(zip, `Make-It-Fast-Edit-Arsenal-Split-${stamp()}.zip`, 'zip', true);
      files.forEach(file => addResult(new Blob([file.data], { type: 'video/mp4' }), file.name, 'video', false));
      toast('Split complete', `${kept.length} kept parts · removed parts were skipped.`, 'success');
    } finally {
      await engine.remove(tempNames);
    }
  });
}

async function exportSnapshot() {
  await withExport('Preparing snapshot', async () => {
    const p = P(); await ensureMedia(p);
    const time = clamp(p.currentTime, 0, Math.max(0, p.duration - .02));
    const range = { start: time, duration: 1 / Math.max(1, p.output.fps) };
    const sourceNames = await prepareSourceNames(p);
    const size = renderSizeFor('snapshot', p);
    const overlayAssets = await prepareOverlayAssets(p, size.width, size.height);
    const outputName = `mvs_snap_${Date.now()}.png`;
    const ctx = makeContext(p, { range, kind: 'snapshot', outputName, overlayMode: 'static', staticTime: time, sourceNames, overlayAssets });
    const plan = buildVideoPlan(ctx, 'snapshot');
    await engine.exec(plan.args, { label: 'Rendering PNG frame', from: 32, to: 90 });
    const blob = await engine.read(outputName, 'image/png');
    if (blob.size < 100) throw new Error('The PNG output was empty.');
    await engine.remove([outputName, ...overlayAssets.names]);
    addResult(blob, `Make-It-Fast-Edit-Arsenal-Snapshot-${stamp()}.png`, 'image', true);
    toast('Snapshot saved', 'Full output resolution, with active overlays.', 'success');
  });
}

async function exportExtractAudio() {
  await withExport('Preparing audio export', async () => {
    const p = P(); await ensureMedia(p);
    const range = selectedRange(p);
    const sourceNames = await prepareSourceNames(p);
    const outputName = `mvs_audio_${Date.now()}.mp3`;
    const base = makeContext(p, { range, kind: 'audio', outputName, sourceNames });
    let plan = buildExtractPlan(base, 'mp3');
    let blob, actualName = outputName, mime = 'audio/mpeg', kind = 'audio';
    try {
      await engine.exec(plan.args, { label: 'Extracting MP3', from: 30, to: 90 });
      blob = await engine.read(outputName, 'audio/mpeg');
    } catch (err) {
      if (!/encoder|mp3|invalid|failed/i.test(String(err?.message || err))) throw err;
      const wavName = `mvs_audio_${Date.now()}.wav`;
      const wavCtx = makeContext(p, { range, kind: 'audio', outputName: wavName, sourceNames });
      plan = buildExtractPlan(wavCtx, 'wav');
      await engine.exec(plan.args, { label: 'Extracting WAV fallback', from: 35, to: 90 });
      blob = await engine.read(wavName, 'audio/wav');
      actualName = wavName; mime = 'audio/wav'; kind = 'audio';
      toast('WAV fallback', 'This engine build preferred WAV; the audio is still exact.');
    }
    if (blob.size < 100) throw new Error('The audio output was empty.');
    await engine.remove([actualName]);
    const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
    addResult(blob, `Make-It-Fast-Edit-Arsenal-Audio-${stamp()}.${ext}`, kind, true);
    toast('Audio extracted', `Saved the selected range as ${ext.toUpperCase()}.`, 'success');
  });
}

async function exportGif() {
  await withExport('Preparing GIF', async () => {
    const p = P(); await ensureMedia(p);
    const full = selectedRange(p);
    const range = { start: full.start, duration: Math.min(full.duration, 6 * clamp(p.speed, .5, 2)) };
    const sourceNames = await prepareSourceNames(p);
    const size = renderSizeFor('gif', p);
    const overlayAssets = await prepareOverlayAssets(p, size.width, size.height);
    const outputName = `mvs_anim_${Date.now()}.gif`;
    const ctx = makeContext(p, { range, kind: 'gif', outputName, sourceNames, overlayAssets });
    const plan = buildVideoPlan(ctx, 'gif');
    await engine.exec(plan.args, { label: 'Rendering animated GIF', from: 30, to: 90 });
    const blob = await engine.read(outputName, 'image/gif');
    if (blob.size < 100) throw new Error('The GIF output was empty.');
    await engine.remove([outputName, ...overlayAssets.names]);
    addResult(blob, `Make-It-Fast-Edit-Arsenal-Loop-${stamp()}.gif`, 'image', true);
    toast('GIF is ready', 'A 480px looping version of the selected range.', 'success');
  });
}

async function exportContactSheet() {
  await withExport('Preparing frame sheet', async () => {
    const p = P(); await ensureMedia(p);
    const full = selectedRange(p);
    const range = { start: full.start, duration: Math.min(full.duration, 45) };
    const sourceNames = await prepareSourceNames(p);
    const size = renderSizeFor('contact', p);
    const overlayAssets = await prepareOverlayAssets(p, size.width, size.height);
    const outputName = `mvs_sheet_${Date.now()}.png`;
    const ctx = makeContext(p, { range, kind: 'contact', outputName, sourceNames, overlayAssets });
    const plan = buildVideoPlan(ctx, 'contact');
    await engine.exec(plan.args, { label: 'Rendering 3×3 frame sheet', from: 30, to: 90 });
    const blob = await engine.read(outputName, 'image/png');
    if (blob.size < 100) throw new Error('The contact sheet output was empty.');
    await engine.remove([outputName, ...overlayAssets.names]);
    addResult(blob, `Make-It-Fast-Edit-Arsenal-Frame-Sheet-${stamp()}.png`, 'image', true);
    toast('Frame sheet saved', 'Nine moments from the selected range.', 'success');
  });
}

/* ---------- panels and full UI refresh ---------- */
function activatePanel(name, { syncMode = true } = {}) {
  if (syncMode && name === 'audio' && state.mode !== 'audio') setMode('audio', { switchPanel: false });
  state.activePanel = name;
  $$('.tool-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.panel === name));
  $$('.tool-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
  overlayEl.classList.toggle('editable', name === 'text' || name === 'effects');
  updateCropOverlay();
  if (name === 'audio') requestAnimationFrame(renderWaveform);
  lightPreview?.markDirty();
  requestAnimationFrame(() => { fitMediaFrame(); renderOverlayDOM(); });
}
function updateToolVisibility() { updateCropOverlay(); }

function updateAll() {
  updateProjectInfo();
  updateOutputUI();
  updateEffectsUI();
  updateTimelineUI();
  renderFilmstripDOM();
  renderTextCards();
  renderSplitUI();
  updateCropOverlay();
  renderResults();
  renderWaveform();
  updatePlayButton();
  fitMediaFrame();
  renderOverlayDOM();
  lightPreview?.markDirty();
}

/* ---------- event wiring ---------- */
$$('.tool-tab').forEach(tab => tab.addEventListener('click', () => activatePanel(tab.dataset.panel)));
$$('#mode-switch button').forEach(btn => btn.addEventListener('click', async () => { await setMode(btn.dataset.mode); commitHistory('Switch mode'); }));
$('activate-audio-mode').addEventListener('click', async () => { await setMode('audio', { switchPanel: true }); commitHistory('Switch to audio mode'); });
$('help-btn').addEventListener('click', () => { const d = $('help-dialog'); typeof d.showModal === 'function' ? d.showModal() : d.setAttribute('open', ''); });
$('undo-btn').addEventListener('click', undo);
$('redo-btn').addEventListener('click', redo);
$('play-btn').addEventListener('click', togglePlay);
$('seek-bar').addEventListener('input', e => seekMedia(Number(e.target.value), true));
$('fit-btn').addEventListener('click', () => { fitMediaFrame(); toast('Preview refitted', 'The frame now matches the available stage.'); });
$('reset-view-btn').addEventListener('click', () => { const p = P(); p.transform = { rotate: 0, flipH: false, flipV: false }; p.color = { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }; updateEffectsUI(); commitHistory('Reset view'); toast('Preview reset', 'Rotation, flips and color preview were reset.'); });

const openers = [
  ['open-top', 'file-video'], ['empty-video-btn', 'file-video'], ['replace-video-btn', 'file-video'],
  ['empty-audio-btn', 'file-audio'], ['audio-drop', 'file-audio'], ['replace-audio-btn', 'file-audio'],
  ['image-drop', 'file-image'], ['replace-image-btn', 'file-image'],
  ['watermark-btn', 'file-watermark']
];
openers.forEach(([button, input]) => $(button)?.addEventListener('click', () => $(input).click()));
$('file-video').addEventListener('change', e => loadVideo(e.target.files[0]));
$('file-audio').addEventListener('change', e => loadAudio(e.target.files[0]));
$('file-image').addEventListener('change', e => loadImage(e.target.files[0]));
$('file-watermark').addEventListener('change', e => loadWatermark(e.target.files[0]));

$('trim-start-input').addEventListener('change', () => {
  const start = parseTime($('trim-start-input').value, NaN);
  if (!Number.isFinite(start)) { toast('Invalid timecode', 'Use MM:SS.mmm or HH:MM:SS.mmm.', 'error'); updateTimelineUI(); return; }
  setTrimValues(start, P().trimEnd); commitHistory('Trim start');
});
$('trim-end-input').addEventListener('change', () => {
  const raw = $('trim-end-input').value.trim().toLowerCase();
  const end = raw === 'end' ? P().duration : parseTime(raw, NaN);
  if (!Number.isFinite(end)) { toast('Invalid timecode', 'Use MM:SS.mmm, END, or seconds.', 'error'); updateTimelineUI(); return; }
  setTrimValues(P().trimStart, end); commitHistory('Trim end');
});
$('set-start-btn').addEventListener('click', () => {
  const p = P(), t = clamp(p.currentTime, 0, Math.max(0, p.duration - .06));
  setTrimValues(t, Math.max(p.trimEnd, t + .06), { updateMedia: true }); commitHistory('Set trim start');
});
$('set-end-btn').addEventListener('click', () => {
  const p = P(), t = clamp(p.currentTime, Math.min(p.duration, p.trimStart + .06), p.duration);
  setTrimValues(p.trimStart, t, { updateMedia: true }); commitHistory('Set trim end');
});
$('trim-reset-btn').addEventListener('click', () => { setTrimValues(0, P().duration); commitHistory('Reset trim'); });
$('trim-play-btn').addEventListener('click', () => {
  const p = P(); if (!sourceReady(p)) { toast('Load media first', '', 'error'); return; }
  state.stopAtTrimEnd = true; seekMedia(p.trimStart); playMedia();
});
$('trim-handle-start').addEventListener('keydown', e => handleTrimKey(e, 'start'));
$('trim-handle-end').addEventListener('keydown', e => handleTrimKey(e, 'end'));

$$('#ratio-row .chip').forEach(chip => chip.addEventListener('click', () => { applyCropRatio(chip.dataset.ratio); commitHistory('Crop ratio'); }));
['crop-x', 'crop-y', 'crop-w', 'crop-h'].forEach(id => $(id).addEventListener('change', () => {
  const p = P();
  p.cropRatio = 'free';
  $$('#ratio-row .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.ratio === 'free'));
  p.crop = normalizeCropValues({
    x: Number($('crop-x').value), y: Number($('crop-y').value),
    w: Number($('crop-w').value), h: Number($('crop-h').value)
  }, p);
  refreshOutputSize(); updateCropOverlay(); commitHistory('Manual crop');
}));
$('crop-grid-toggle').addEventListener('change', updateCropOverlay);
$('crop-full-btn').addEventListener('click', () => { const p = P(); p.crop = { x: 0, y: 0, w: even(p.sourceW), h: even(p.sourceH) }; applyCropRatio('original', { center: false }); commitHistory('Full crop'); });
$('crop-center-btn').addEventListener('click', () => { const p = P(); p.crop.x = Math.round((p.sourceW - p.crop.w) / 2 / 2) * 2; p.crop.y = Math.round((p.sourceH - p.crop.h) / 2 / 2) * 2; updateCropOverlay(); commitHistory('Center crop'); });
$('crop-match-btn').addEventListener('click', () => { applyCropRatio('output'); commitHistory('Match output ratio'); });

$('add-text-btn').addEventListener('click', () => addTextLayer('custom'));
$('add-title-btn').addEventListener('click', () => addTextLayer('title'));
$('add-caption-btn').addEventListener('click', () => addTextLayer('caption'));
$('text-layers').addEventListener('change', () => commitHistory('Text layer'));
$('text-layers').addEventListener('click', () => commitHistory('Text layer'));

$('add-split-btn').addEventListener('click', () => addSplitAt());
$('auto-split-btn').addEventListener('click', autoSplit);
$('clear-split-btn').addEventListener('click', () => { P().splitPoints = []; syncSegments(P()); updateTimelineUI(); renderSplitUI(); commitHistory('Clear cuts'); });
$('split-points').addEventListener('change', e => {
  if (!e.target.matches('input')) return;
  const index = Number(e.target.closest('.split-point')?.dataset.index);
  const value = parseTime(e.target.value, NaN);
  if (Number.isFinite(value) && Number.isInteger(index)) {
    const p = P(), range = selectedRange(p);
    p.splitPoints[index] = clamp(value, range.start + .05, range.end - .05);
    p.splitPoints.sort((a, b) => a - b);
    syncSegments(p); updateTimelineUI(); renderSplitUI(); commitHistory('Move cut');
  } else renderSplitUI();
});
$('split-points').addEventListener('click', e => {
  const point = e.target.closest('.split-point');
  const cut = e.target.closest('[data-cut-action]');
  if (cut && point) {
    const index = Number(point.dataset.index);
    if (cut.dataset.cutAction === 'before') deleteBeforeCut(index);
    else deleteAfterCut(index);
    return;
  }
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  P().splitPoints.splice(Number(btn.dataset.remove), 1);
  syncSegments(P()); updateTimelineUI(); renderSplitUI(); commitHistory('Remove cut');
});
$('segment-list')?.addEventListener('click', e => {
  const card = e.target.closest('.segment-card');
  const btn = e.target.closest('[data-seg-action]');
  if (!card || !btn) return;
  const id = card.dataset.seg, action = btn.dataset.segAction;
  if (action === 'focus') focusSegment(id);
  else if (action === 'remove') removeSegment(id);
  else if (action === 'reset') resetSegmentEdits(id);
});
$('segment-focus-buttons')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-focus]');
  if (btn) focusSegment(btn.dataset.focus || null);
});

$$('#rotate-row .chip').forEach(chip => chip.addEventListener('click', () => { P().transform.rotate = Number(chip.dataset.rotate); updateEffectsUI(); commitHistory('Rotate'); }));
$('flip-h-btn').addEventListener('click', () => { const p = P(); p.transform.flipH = !p.transform.flipH; updateEffectsUI(); commitHistory('Flip horizontal'); });
$('flip-v-btn').addEventListener('click', () => { const p = P(); p.transform.flipV = !p.transform.flipV; updateEffectsUI(); commitHistory('Flip vertical'); });
$('mute-btn').addEventListener('click', () => { const p = P(); p.mute = !p.mute; updateEffectsUI(); commitHistory('Mute output'); });
['speed-range', 'volume-range', 'brightness-range', 'contrast-range', 'saturation-range', 'gamma-range', 'watermark-scale', 'watermark-opacity', 'watermark-x', 'watermark-y'].forEach(id => {
  $(id).addEventListener('input', () => { syncEffectsFromDOM({ render: false }); updateEffectsUI(); renderOverlayDOM(); updateTimelineUI(); });
  $(id).addEventListener('change', () => { syncEffectsFromDOM(); renderOverlayDOM(); updateTimelineUI(); commitHistory('Effect'); });
});
$('color-reset-btn').addEventListener('click', () => { const p = P(); p.color = { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }; updateEffectsUI(); commitHistory('Reset color'); });
$('watermark-remove-btn').addEventListener('click', () => { const p = P(); revokeIf(p.watermarkURL); p.watermarkFile = null; p.watermarkURL = null; updateEffectsUI(); renderOverlayDOM(); commitHistory('Remove logo'); toast('Logo removed'); });
['output-quality-tier', 'output-shape', 'ratio-w', 'ratio-h', 'output-quality', 'output-fps', 'output-bg'].forEach(id => {
  $(id)?.addEventListener('input', () => { syncOutputFromDOM({ render: false }); updateOutputUI(); updateTimelineUI(); });
  $(id)?.addEventListener('change', () => { refreshOutputSize(); commitHistory('Output settings'); });
});
$('generate-cover-btn').addEventListener('click', async () => {
  const p = state.projects.audio;
  if (!p.audioFile) { toast('Add audio first', 'A waveform cover is generated from your audio file.', 'error'); return; }
  p.coverVersion++;
  const version = p.coverVersion;
  toast('Generating cover', 'Reading the waveform and drawing artwork…');
  const peaks = p.peaks || await audioPeaks(p.audioFile, 120);
  const cover = await generateWaveformCover({ title: p.audioFile.name, peaks });
  if (p.coverVersion !== version) return;
  p.peaks = peaks; renderWaveform();
  await setCoverFile(blobToFile(cover.blob, 'mvs-waveform-cover.png'), { generated: true });
  commitHistory('Generate cover');
});
$('reset-project-btn').addEventListener('click', () => {
  if (!confirm('Reset the current project? This clears edits and loaded media for this mode.')) return;
  const old = P();
  [old.videoURL, old.audioURL, old.imageURL, old.watermarkURL].forEach(revokeIf);
  state.projects[state.mode] = makeProject(state.mode);
  videoEl.removeAttribute('src'); imageEl.removeAttribute('src'); audioEl.removeAttribute('src');
  videoEl.load(); audioEl.load();
  updateAll(); commitHistory('Reset project'); toast('Project reset', 'A fresh canvas is ready.');
});
$('clear-results-btn').addEventListener('click', () => {
  state.results.forEach(r => URL.revokeObjectURL(r.url));
  state.results = []; renderResults();
});
$('results-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-download]');
  if (!btn) return;
  const result = state.results.find(r => r.id === btn.dataset.download);
  if (result) downloadBlob(result.blob, result.name);
});

$('export-top').addEventListener('click', exportMp4);
$('export-main-btn').addEventListener('click', exportMp4);
$('split-export-btn').addEventListener('click', exportSplitZip);
$('snapshot-btn').addEventListener('click', exportSnapshot);
$('extract-btn').addEventListener('click', exportExtractAudio);
$('gif-btn').addEventListener('click', exportGif);
$('contact-btn').addEventListener('click', exportContactSheet);
$('cancel-export-btn').addEventListener('click', () => {
  state.cancelled = true;
  engine.cancel();
  state.written.clear();
  state.busy = false;
  renderButtons.forEach(id => { const el = $(id); if (el) el.disabled = false; });
  $('progress-block').hidden = true;
  toast('Render cancelled', 'The engine was reset; you can start again.');
});

window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag-over'); });
window.addEventListener('dragleave', e => { if (e.clientX === 0 && e.clientY === 0) document.body.classList.remove('drag-over'); });
window.addEventListener('drop', async e => {
  e.preventDefault(); document.body.classList.remove('drag-over');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const video = files.find(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f.name));
  const audio = files.find(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  const image = files.find(f => f.type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(f.name));
  if (audio || image) {
    if (audio) await loadAudio(audio);
    if (image) await loadImage(image);
    else if (!state.projects.audio.audioFile) toast('Add audio next', 'The cover is ready for an MP3.');
  } else if (video) await loadVideo(video);
  else toast('Unsupported drop', 'Use a video, audio file, or image.', 'error');
  commitHistory('Drop media');
});
window.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  const mod = e.ctrlKey || e.metaKey;
  if (!typing && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (!typing && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (!typing && e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (!typing && (e.key === 's' || e.key === 'S')) addSplitAt();
});
window.addEventListener('resize', () => { fitMediaFrame(); renderWaveform(); lightPreview?.resize(); });
new ResizeObserver(() => fitMediaFrame()).observe(stageEl);
window.addEventListener('beforeunload', () => state.results.forEach(r => URL.revokeObjectURL(r.url)));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(err => console.warn('Service worker unavailable', err));
}

/* Small hook used by the bundled smoke tests and future Capacitor diagnostics. */
window.__MVS__ = {
  state, P, engine, setMode, activatePanel, loadVideo, loadAudio, loadImage, loadWatermark,
  addTextLayer, addSplitAt, autoSplit, seekMedia, setTrimValues, refreshOutputSize,
  updateAll, exportMp4, exportSplitZip, exportSnapshot, exportExtractAudio, exportGif, exportContactSheet,
  buildVideoPlan, buildExtractPlan, buildConcatPlan, segmentRanges, getOutputSize, normalizedCrop,
  generateWaveformCover, toast,
  undo, redo, getHistoryState: () => ({ past: history.past.length, future: history.future.length, muted: historyMuted }),
  getSegments: () => { syncSegments(P()); return P().segments.map(s => ({ id: s.id, start: s.start, end: s.end, duration: s.duration, removed: s.removed, hasOverrides: !!s.overrides })); },
  removeSegment, restoreSegment, focusSegment, resetSegmentEdits, deleteBeforeCut, deleteAfterCut,
  setQualityTier: tier => {
    const p = P();
    p.output.qualityTier = clamp(Number(tier) || 720, 360, 720);
    Object.assign(p.output, computeOutputSize(p));
    updateOutputUI(); refreshOutputSize(); commitHistory('Save quality');
  },
  setShape: (shape, customW = 16, customH = 9) => {
    const p = P();
    Object.assign(p.output, { shape, customW, customH });
    Object.assign(p.output, computeOutputSize(p));
    updateOutputUI(); refreshOutputSize(); commitHistory('Output shape');
  },
  computeOutputSize: () => computeOutputSize(P()),
  getOutputSettings: () => ({ ...P().output }),
  getLightPreview: () => lightPreview?.state() || null,
  getBackground: () => window.__MVS_BG__?.state() || null,
  MAX_SEGMENTS
};

lightPreview = new LightPreview({ video: videoEl, image: imageEl, frame: frameEl, stage: stageEl, getState: () => state, getProject: () => P() });
syncOutputFromDOM({ render: false });
Object.assign(P().output, computeOutputSize(P()));
updateAll();
for (const mode of ['video', 'audio']) state.projects[mode].globalEdits = editableSnapshot(state.projects[mode]);
lastCommitted = captureState();
updateHistoryButtons();
lightPreview?.resize();
const initialTool = new URLSearchParams(location.search).get('tool');
const validTools = ['trim', 'crop', 'text', 'split', 'audio', 'effects', 'lab'];
if (initialTool === 'audio') {
  setMode('audio', { switchPanel: false }).then(() => activatePanel('audio', { syncMode: false }));
} else if (validTools.includes(initialTool)) {
  activatePanel(initialTool, { syncMode: false });
}
