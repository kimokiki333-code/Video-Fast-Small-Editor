/* Lazy-loaded, single-thread FFmpeg.wasm engine.
   The 31 MB core is stored gzip-compressed (~10 MB), unpacked only on first render. */
import { FFmpeg } from './vendor/ffmpeg/index.js';

const CORE_JS = new URL('./engine/ffmpeg-core.js', document.baseURI).href;
const CORE_GZ = new URL('./engine/ffmpeg-core.wasm.gz', document.baseURI).href;

const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || a));

async function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('Unsupported file data');
}

export class VideoEngine {
  constructor({ onProgress = () => {}, onLog = () => {} } = {}) {
    this.ffmpeg = null;
    this.loaded = false;
    this.loading = null;
    this.files = new Set();
    this.logs = [];
    this.lastError = '';
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.progressFrom = 30;
    this.progressTo = 90;
    this.progressLabel = 'Rendering';
    this.cancelled = false;
    this.wasmURL = null;
  }

  report(percent, label) {
    this.onProgress(clamp(percent, 0, 100), label || this.progressLabel);
  }

  async wasmBlobURL() {
    if (this.wasmURL) return this.wasmURL;
    this.report(3, 'Unpacking local video engine');
    let response;
    try {
      response = await fetch(CORE_GZ, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Engine asset returned ${response.status}`);
    } catch (err) {
      throw new Error(`Could not load the bundled video engine: ${err.message}`);
    }
    if (!response.body || typeof DecompressionStream === 'undefined') {
      throw new Error('This browser needs DecompressionStream to unpack the bundled video engine.');
    }
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const counter = new TransformStream({
      transform: function (chunk, controller) {
        received += chunk.byteLength;
        if (total) this.report(3 + 10 * (received / total), 'Unpacking local video engine');
        controller.enqueue(chunk);
      }.bind(this)
    });
    const decompressed = await new Response(
      response.body.pipeThrough(counter).pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer();
    this.wasmURL = URL.createObjectURL(new Blob([decompressed], { type: 'application/wasm' }));
    this.report(15, 'Starting WebAssembly core');
    return this.wasmURL;
  }

  async ensure() {
    if (this.loaded && this.ffmpeg?.loaded) return this.ffmpeg;
    if (this.loading) return this.loading;
    this.cancelled = false;
    this.loading = (async () => {
      const wasmURL = await this.wasmBlobURL();
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        if (!message) return;
        this.logs.push(message);
        if (this.logs.length > 240) this.logs.shift();
        if (/error|invalid|failed|not found|no such|unsupported/i.test(message)) this.lastError = message;
        this.onLog(message);
      });
      ffmpeg.on('progress', ({ progress }) => {
        const p = clamp(progress, 0, 1);
        this.report(this.progressFrom + (this.progressTo - this.progressFrom) * p, this.progressLabel);
      });
      this.report(17, 'Starting WebAssembly core');
      await ffmpeg.load({ coreURL: CORE_JS, wasmURL });
      if (this.cancelled) throw new Error('Render cancelled');
      this.ffmpeg = ffmpeg;
      this.loaded = true;
      this.files.clear();
      this.report(24, 'Engine ready');
      return ffmpeg;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async write(name, data, { force = false } = {}) {
    const ffmpeg = await this.ensure();
    if (this.files.has(name) && !force) return;
    const bytes = await toUint8(data);
    await ffmpeg.writeFile(name, bytes);
    this.files.add(name);
  }

  async exec(args, { label = 'Rendering', from = 30, to = 88 } = {}) {
    const ffmpeg = await this.ensure();
    this.progressLabel = label;
    this.progressFrom = from;
    this.progressTo = to;
    this.lastError = '';
    this.report(from, label);
    let code;
    try {
      code = await ffmpeg.exec(args);
    } catch (err) {
      if (this.cancelled || /terminated/i.test(String(err?.message || err))) throw new Error('Render cancelled');
      throw new Error(this.lastError || err?.message || 'The video engine could not finish this command.');
    }
    if (code !== 0) throw new Error(this.lastError || `The video engine exited with code ${code}.`);
    this.report(to, label);
    return code;
  }

  async read(name, mime = 'application/octet-stream') {
    const ffmpeg = await this.ensure();
    const data = await ffmpeg.readFile(name);
    if (typeof data === 'string') return new Blob([data], { type: mime });
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return new Blob([copy], { type: mime });
  }

  async readBytes(name) {
    const ffmpeg = await this.ensure();
    const data = await ffmpeg.readFile(name);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return copy;
  }

  async remove(names = []) {
    if (!this.loaded || !this.ffmpeg) return;
    for (const name of names) {
      try { await this.ffmpeg.deleteFile(name); } catch (_) {}
      this.files.delete(name);
    }
  }

  cancel() {
    this.cancelled = true;
    if (this.ffmpeg) {
      try { this.ffmpeg.terminate(); } catch (_) {}
    }
    this.ffmpeg = null;
    this.loaded = false;
    this.loading = null;
    this.files.clear();
  }

  getLogTail(lines = 20) {
    return this.logs.slice(-lines).join('\n');
  }
}
