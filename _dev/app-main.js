'use strict';
/* ============================================================
   WEBP FORGE — APP v1.1 (UI, pipeline de conversión, cola, ZIP)
   Entradas: WebP (estático/animado), WebM, MP4
   ============================================================ */

// ---------- Capacidades del navegador ----------
const CAP = {
  canvas: !!document.createElement('canvas').getContext,
  offscreen: typeof OffscreenCanvas !== 'undefined',
  imageDecoder: typeof ImageDecoder !== 'undefined',
  webcodecs: typeof VideoEncoder !== 'undefined',
  mediaRecorder: typeof MediaRecorder !== 'undefined',
  worker: typeof Worker !== 'undefined',
  captureStream: typeof HTMLVideoElement !== 'undefined' && (HTMLVideoElement.prototype.captureStream || HTMLVideoElement.prototype.mozCaptureStream),
  mp4: false, webm: false, mp4Mime: '', webmMime: '', mp4AudioMime: '', webmAudioMime: ''
};
if (CAP.mediaRecorder) {
  for (const m of ['video/mp4;codecs="avc1.42E01E"', 'video/mp4;codecs=avc1', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) { CAP.mp4 = true; CAP.mp4Mime = m; break; }
  }
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) { CAP.webm = true; CAP.webmMime = m; break; }
  }
  // Variantes con audio para re-codificar videos conservando la pista de sonido
  for (const m of ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) { CAP.mp4AudioMime = m; break; }
  }
  for (const m of ['video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) { CAP.webmAudioMime = m; break; }
  }
}

// ---------- Estado ----------
const FILES = new Map();      // id -> entry
let nextId = 1;
let activeFilter = 'all';
let searchTerm = '';
let queueRunning = false;
const sessionPrefs = { format: '', quality: 80 }; // solo en memoria (privacidad)
const stats = { startedAt: 0, batchDone: 0, batchTotal: 0, times: [] };

// ---------- Helpers ----------
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
function humanSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg, kind, ms) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 450); }, ms || 3800);
}

// ---------- Chips de estado de APIs ----------
(function renderApiChips() {
  const chips = [
    ['Canvas', CAP.canvas, 'Canvas API — render y exportación de frames'],
    ['ImageDecoder', CAP.imageDecoder, 'Decodificación frame a frame de WebP animados (Chrome/Edge 94+)'],
    ['WebCodecs', CAP.webcodecs, 'VideoEncoder disponible'],
    ['MP4', CAP.mp4, CAP.mp4 ? 'MediaRecorder puede grabar MP4/H.264' : 'Este navegador no graba MP4 — se usará WebM como fallback'],
    ['WebM', CAP.webm, 'MediaRecorder puede grabar WebM (VP8/VP9)'],
  ];
  $('#api-status').innerHTML = chips.map(([n, ok, tip]) =>
    `<span class="chip ${ok ? 'on' : 'off'}" title="${escapeHtml(tip)}">${ok ? '✓' : '✗'} ${n}</span>`).join('');
  if (!CAP.imageDecoder) toast('⚠ Este navegador no soporta <b>ImageDecoder</b>: los WebP animados solo se convertirán usando su primer frame. Usa Chrome o Edge para animaciones completas.', 'warn', 9000);
})();

// ---------- Ingesta de archivos ----------
const ACCEPT_RE = /\.(webp|webm|mp4|m4v)$/i;
const ACCEPT_TYPES = ['image/webp', 'video/webm', 'video/mp4'];

async function entriesFromDataTransfer(dt) {
  const out = [];
  const walkers = [];
  // IMPORTANTE: leer todos los webkitGetAsEntry/getAsFile de forma SÍNCRONA;
  // los DataTransferItem se invalidan en cuanto el handler cede el control.
  if (dt.items && dt.items.length) {
    for (const it of [...dt.items]) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (entry) walkers.push(walkEntry(entry, out));
      else { const f = it.getAsFile(); if (f) out.push(f); }
    }
    await Promise.all(walkers);
  }
  // Fallback: algunos entornos no exponen items utilizables pero sí dt.files
  if (!out.length && dt.files && dt.files.length) out.push(...dt.files);
  return out;
}
async function walkEntry(entry, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
    if (f) out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) { // readEntries devuelve lotes de máx 100: hay que iterar hasta vaciar
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
      if (!batch.length) break;
      await Promise.all(batch.map(e => walkEntry(e, out)));
    }
  }
}

// Lee metadatos de un video con un elemento <video> (con timeout de seguridad)
function probeVideo(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout leyendo metadatos')); }, 15000);
    const cleanup = () => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => {
      const out = { width: v.videoWidth, height: v.videoHeight, durationMs: Math.round((v.duration || 0) * 1000) };
      cleanup();
      if (!out.width || !out.height) rej(new Error('el navegador no expone dimensiones de este códec'));
      else res(out);
    };
    v.onerror = () => { cleanup(); rej(new Error('códec no soportado por este navegador')); };
    v.src = url;
  });
}

function defaultFormatFor(entry) {
  if (sessionPrefs.format) return sessionPrefs.format;
  const i = entry.info;
  if (entry.kind === 'video') {
    // Convertir al "otro" contenedor por defecto; MP4 es lo más universal
    if (i.type !== 'mp4' && CAP.mp4) return 'mp4';
    if (i.type === 'mp4' && CAP.webm) return 'webm';
    return CAP.mp4 ? 'mp4' : (CAP.webm ? 'webm' : 'gif');
  }
  if (i.animated) {
    // Animaciones largas (clasificadas como VIDEO en la UI) → video, no GIF
    if (i.durationMs > 10000) return CAP.mp4 ? 'mp4' : (CAP.webm ? 'webm' : 'gif');
    return 'gif';
  }
  return 'png';
}

async function addFiles(fileList) {
  const all = [...fileList];
  const accepted = all.filter(f => ACCEPT_RE.test(f.name) || ACCEPT_TYPES.includes(f.type));
  const skipped = all.length - accepted.length;
  if (skipped > 0) toast(`Se omitieron <b>${skipped}</b> archivo(s) no soportados (acepto .webp, .webm, .mp4)`, 'warn');
  if (!accepted.length) { if (!skipped) toast('No se encontraron archivos WebP/WebM/MP4', 'warn'); return; }

  const prog = $('#analyze-progress');
  prog.style.display = 'block';
  const frag = document.createDocumentFragment();

  for (let i = 0; i < accepted.length; i++) {
    const file = accepted[i];
    prog.textContent = `Analizando ${i + 1} de ${accepted.length} archivos…`;
    const entry = {
      id: nextId++, file, name: file.name, size: file.size,
      kind: 'webp', info: null, selected: true, status: 'ready',
      format: '', quality: sessionPrefs.quality,
      blob: null, outName: '', outUrl: null, fallbackNote: '',
      error: '', errorStack: '', els: null
    };
    try {
      const head = await file.slice(0, 4096).arrayBuffer();
      const container = detectContainer(head);
      if (container === 'webp') {
        entry.kind = 'webp';
        let info = parseWebP(head, file.size);
        if (info.valid && info.animated) info = parseWebP(await file.arrayBuffer(), file.size);
        entry.info = info;
        if (!info.valid) { entry.status = 'invalid'; entry.error = info.reason; }
        else entry.format = defaultFormatFor(entry);
      } else if (container === 'webm' || container === 'mp4' || container === 'mkv') {
        entry.kind = 'video';
        try {
          const m = await probeVideo(file);
          entry.info = { valid: true, video: true, type: container, animated: true, frames: 0,
                         width: m.width, height: m.height, durationMs: m.durationMs,
                         loopCount: 0, hasAlpha: false, hasICC: false, hasEXIF: false, hasXMP: false, truncated: false };
          entry.format = defaultFormatFor(entry);
        } catch (err) {
          entry.status = 'invalid'; entry.info = { valid: false };
          entry.error = `Video ${container.toUpperCase()} detectado, pero no se puede decodificar: ${err.message}`;
        }
      } else {
        entry.status = 'invalid'; entry.info = { valid: false };
        entry.error = 'Formato no reconocido: ni WebP (RIFF), ni WebM (EBML), ni MP4 (ftyp)';
      }
    } catch (err) {
      entry.status = 'invalid'; entry.info = { valid: false };
      entry.error = 'No se pudo leer el archivo: ' + err.message;
    }
    if (file.size > 500 * 1048576) toast(`⚠ <b>${escapeHtml(file.name)}</b> pesa ${humanSize(file.size)} — puede agotar la memoria del navegador`, 'warn', 7000);
    FILES.set(entry.id, entry);
    frag.appendChild(buildCard(entry));
    if (i % 20 === 19) await raf(); // no bloquear la UI con lotes grandes
  }
  $('#list').appendChild(frag);
  prog.style.display = 'none';
  $('#controls').style.display = 'flex';
  $('#filters').style.display = 'flex';
  refreshCounters(); applyFilter();
  toast(`<b>${accepted.length}</b> archivo(s) añadidos`);
}

// ---------- Tarjetas ----------
const FORMATS = [['jpg','JPG'],['png','PNG'],['gif','GIF'],['mp4','MP4'],['webm','WebM'],['bmp','BMP']];

function badgeFor(entry) {
  const i = entry.info;
  if (!i || !i.valid) return '<span class="badge invalid">⛔ NO VÁLIDO</span>';
  if (entry.kind === 'video') {
    return `<span class="badge video">🟠 VIDEO ${i.type.toUpperCase()} · ${(i.durationMs/1000).toFixed(1)}s</span>`;
  }
  if (i.animated) {
    if (i.durationMs > 10000) return `<span class="badge video">🟠 VIDEO · ${i.frames} frames · ${(i.durationMs/1000).toFixed(1)}s</span>`;
    return `<span class="badge anim">🟣 ANIMADO · ${i.frames} frames</span>`;
  }
  return `<span class="badge static">🟦 ${i.type === 'lossy' ? 'LOSSY (VP8)' : i.type === 'lossless' ? 'LOSSLESS (VP8L)' : 'ESTÁTICO (VP8X)'}</span>`;
}
function metaFor(entry) {
  const i = entry.info;
  let s = `Tamaño: <b>${humanSize(entry.size)}</b>`;
  if (i && i.valid) {
    s += ` &nbsp;|&nbsp; <b>${i.width}×${i.height}</b>`;
    if (entry.kind === 'video') s += ` &nbsp;|&nbsp; <b>${(i.durationMs/1000).toFixed(2)}s</b> de video`;
    else if (i.animated) s += ` &nbsp;|&nbsp; <b>${i.frames}</b> frames · ${(i.durationMs/1000).toFixed(2)}s · loop ${i.loopCount === 0 ? '∞' : i.loopCount}`;
    const extra = [i.hasAlpha && 'alpha', i.hasICC && 'ICC', i.hasEXIF && 'EXIF', i.hasXMP && 'XMP'].filter(Boolean);
    if (extra.length) s += ` &nbsp;|&nbsp; ${extra.join(' · ')}`;
    if (i.truncated) s += ' &nbsp;|&nbsp; <span style="color:var(--warn)">⚠ truncado</span>';
  }
  return s;
}

function buildCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = entry.id;
  const invalid = entry.status === 'invalid';
  card.innerHTML = `
    <button class="card-x" data-act="remove" title="Quitar de la lista">✕</button>
    <div class="card-inner">
      <input type="checkbox" class="sel-box" data-act="sel" ${entry.selected && !invalid ? 'checked' : ''} ${invalid ? 'disabled' : ''}>
      <img class="thumb thumb-skel" alt="">
      <div class="card-body">
        <div class="card-top"><span class="fname" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>${badgeFor(entry)}</div>
        <div class="fmeta">${metaFor(entry)}</div>
        ${invalid ? `<div class="status-line error" style="display:block">⛔ ${escapeHtml(entry.error)}</div>` : `
        <div class="card-controls">
          <label style="font-size:12px;color:var(--text-2)">Convertir a:</label>
          <select class="fmt-select" data-act="fmt">${FORMATS.map(([v, l]) => `<option value="${v}" ${v === entry.format ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="q-wrap" style="${entry.format === 'jpg' ? '' : 'display:none'}">Calidad <input type="range" min="10" max="100" value="${entry.quality}" data-act="q"> <span class="qv">${entry.quality}%</span></span>
          <button class="btn btn-sm" data-act="convert">⚙ Convertir</button>
        </div>
        <div class="progress-row"><div class="pbar"><div class="pbar-fill"></div></div><span class="ptext"></span></div>
        <div class="status-line"></div>
        <div class="result-row">
          <button class="btn btn-sm btn-ok" data-act="dl">⬇ Descargar</button>
          <button class="btn btn-sm" data-act="preview">👁 Preview</button>
          <button class="btn btn-sm" data-act="reconvert">↻ Volver a convertir</button>
          <span class="savings"></span>
        </div>`}
      </div>
    </div>`;
  entry.els = {
    card,
    thumb: $('.thumb', card),
    progRow: $('.progress-row', card),
    pfill: $('.pbar-fill', card),
    ptext: $('.ptext', card),
    status: $('.status-line', card),
    resultRow: $('.result-row', card),
    savings: $('.savings', card),
    fmt: $('.fmt-select', card),
    qwrap: $('.q-wrap', card),
    convertBtn: $('[data-act=convert]', card),
    sel: $('.sel-box', card),
  };
  if (invalid) card.classList.add('err-card');
  thumbObserver.observe(card);
  return card;
}

// Miniaturas perezosas: solo se generan cuando la tarjeta entra al viewport
const thumbObserver = new IntersectionObserver(async (obs) => {
  for (const o of obs) {
    if (!o.isIntersecting) continue;
    thumbObserver.unobserve(o.target);
    const entry = FILES.get(+o.target.dataset.id);
    if (!entry) continue;
    try {
      let w, h, draw;
      if (entry.kind === 'video' && entry.info && entry.info.valid) {
        const { v, url } = await videoElement(entry);
        await seekTo(v, Math.min(0.1, (v.duration || 1) / 10));
        w = v.videoWidth; h = v.videoHeight; draw = v;
        const s = 74 / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(draw, 0, 0, c.width, c.height);
        entry.els.thumb.src = c.toDataURL('image/png');
        URL.revokeObjectURL(url);
      } else {
        const bmp = await createImageBitmap(entry.file); // primer frame del webp
        const s = 74 / Math.max(bmp.width, bmp.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * s));
        c.height = Math.max(1, Math.round(bmp.height * s));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        entry.els.thumb.src = c.toDataURL('image/png');
      }
    } catch { entry.els.thumb.alt = '✕'; }
    entry.els.thumb.classList.remove('thumb-skel');
  }
}, { rootMargin: '200px' });

// ---------- Eventos delegados de la lista ----------
$('#list').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const entry = FILES.get(+e.target.closest('.card').dataset.id);
  if (!entry) return;
  if (act === 'remove') removeEntry(entry);
  else if (act === 'convert' || act === 'reconvert') enqueue([entry]);
  else if (act === 'dl') downloadEntry(entry);
  else if (act === 'preview') openPreview(entry);
});
$('#list').addEventListener('change', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const entry = FILES.get(+e.target.closest('.card').dataset.id);
  if (!entry) return;
  if (act === 'sel') { entry.selected = e.target.checked; entry.els.card.classList.toggle('selected', entry.selected); refreshCounters(); }
  else if (act === 'fmt') {
    entry.format = e.target.value;
    sessionPrefs.format = '';
    entry.els.qwrap.style.display = entry.format === 'jpg' ? '' : 'none';
    if ((entry.format === 'mp4' && !CAP.mp4 && CAP.webm)) toast('Este navegador no graba MP4 — se generará <b>WebM</b> como fallback', 'warn');
  }
});
$('#list').addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'q') return;
  const entry = FILES.get(+e.target.closest('.card').dataset.id);
  entry.quality = +e.target.value;
  sessionPrefs.quality = entry.quality;
  $('.qv', entry.els.card).textContent = entry.quality + '%';
});

function removeEntry(entry) {
  if (entry.outUrl) URL.revokeObjectURL(entry.outUrl);
  entry.els.card.remove();
  FILES.delete(entry.id);
  refreshCounters();
  if (!FILES.size) { $('#controls').style.display = 'none'; $('#filters').style.display = 'none'; }
}

// ---------- Decodificación WebP ----------
async function decodeAllFrames(entry, onProg, firstOnly) {
  const buf = await entry.file.arrayBuffer();
  if (CAP.imageDecoder) {
    const dec = new ImageDecoder({ data: buf, type: 'image/webp' });
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const count = firstOnly ? 1 : (track.frameCount || 1);
    const frames = [];
    try {
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        // duration viene en microsegundos; los WebP sin duración usan 100ms por convención
        const delayMs = image.duration ? image.duration / 1000 : 100;
        const bmp = await createImageBitmap(image);
        image.close();
        frames.push({ bmp, delayMs });
        onProg && onProg(`Decodificando frame ${i + 1}/${count}`, 5 + (i + 1) / count * 30);
        if (i % 5 === 4) await raf();
      }
    } finally { dec.close(); }
    return frames;
  }
  // Fallback universal: createImageBitmap decodifica el primer frame
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
  onProg && onProg('Decodificado (primer frame)', 35);
  return [{ bmp, delayMs: 100 }];
}

function makeCanvas(w, h) {
  if (CAP.offscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function canvasToBlob(c, type, q) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob devolvió null — formato no soportado')), type, q));
}
function imageDataFrom(bmp, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// ---------- Decodificación de video (WebM/MP4) vía <video> ----------
async function videoElement(entry) {
  const url = URL.createObjectURL(entry.file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout cargando video')), 20000);
    v.onloadedmetadata = () => { clearTimeout(timer); res(); };
    v.onerror = () => { clearTimeout(timer); rej(new Error('no se pudo decodificar el video')); };
  });
  return { v, url };
}
function seekTo(v, t) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { v.removeEventListener('seeked', h); rej(new Error('timeout en seek')); }, 10000);
    const h = () => { clearTimeout(timer); v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.001));
  });
}

/**
 * Extrae frames RGBA de un video por seek (para GIF).
 * Limita FPS/frames/resolución: un GIF de 1080p×900 frames reventaría la memoria.
 */
async function videoFrames(entry, onProg) {
  const { v, url } = await videoElement(entry);
  try {
    const FPS = 10, MAX_FRAMES = 300, MAX_W = 640;
    const scale = Math.min(1, MAX_W / v.videoWidth);
    const W = Math.max(2, Math.round(v.videoWidth * scale) & ~1);
    const H = Math.max(2, Math.round(v.videoHeight * scale) & ~1);
    const total = Math.min(Math.ceil((v.duration || 0) * FPS), MAX_FRAMES);
    if (total < 1) throw new Error('duración de video inválida');
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < total; i++) {
      await seekTo(v, i / FPS);
      ctx.drawImage(v, 0, 0, W, H);
      frames.push({ data: ctx.getImageData(0, 0, W, H).data.buffer, delayMs: 1000 / FPS });
      onProg(`Capturando frame ${i + 1}/${total}`, 5 + (i + 1) / total * 45);
    }
    const note = [];
    if (scale < 1) note.push(`reescalado a ${W}×${H}`);
    if ((v.duration || 0) * FPS > MAX_FRAMES) note.push(`recortado a ${MAX_FRAMES / FPS}s`);
    return { frames, W, H, note: note.join(', ') };
  } finally { URL.revokeObjectURL(url); }
}

// Primer frame de un video como ImageData (para PNG/JPG/BMP)
async function videoFirstFrame(entry) {
  const { v, url } = await videoElement(entry);
  try {
    await seekTo(v, 0);
    const W = v.videoWidth, H = v.videoHeight;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0);
    return { imageData: ctx.getImageData(0, 0, W, H), W, H, canvas: c };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Re-codifica un video a MP4/WebM con MediaRecorder sobre captureStream del
 * propio <video> (conserva audio y resolución; en tiempo real).
 */
async function videoToVideo(entry, wantMp4, onProg) {
  if (!CAP.mediaRecorder || (!CAP.mp4 && !CAP.webm)) throw new Error('MediaRecorder no está disponible en este navegador');
  if (!CAP.captureStream) throw new Error('captureStream no está disponible en este navegador');
  const { v, url } = await videoElement(entry);
  try {
    const useMp4 = wantMp4 && CAP.mp4;
    const ext = useMp4 ? 'mp4' : 'webm';
    const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
    const hasAudio = stream.getAudioTracks().length > 0;
    let mime = useMp4 ? (hasAudio && CAP.mp4AudioMime ? CAP.mp4AudioMime : CAP.mp4Mime)
                      : (hasAudio && CAP.webmAudioMime ? CAP.webmAudioMime : CAP.webmMime);
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 }); }
    catch { // códec de audio no soportado → quitar audio y reintentar solo con video
      stream.getAudioTracks().forEach(t => stream.removeTrack(t));
      mime = useMp4 ? CAP.mp4Mime : CAP.webmMime;
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    await v.play();
    await new Promise((res, rej) => {
      v.onended = res;
      v.onerror = () => rej(new Error('error reproduciendo el video'));
      const iv = setInterval(() => {
        if (v.ended) { clearInterval(iv); return; }
        onProg(`Re-codificando a ${ext.toUpperCase()} — ${v.currentTime.toFixed(1)}s / ${(v.duration || 0).toFixed(1)}s (tiempo real)`, 5 + (v.currentTime / (v.duration || 1)) * 90);
      }, 250);
    });
    await sleep(150);
    rec.stop();
    await stopped;
    stream.getTracks().forEach(t => t.stop());
    if (!chunks.length) throw new Error('MediaRecorder no produjo datos — códec posiblemente no soportado');
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext, fellBack: wantMp4 && !useMp4 };
  } finally { URL.revokeObjectURL(url); }
}

// ---------- GIF en Web Worker (no congela la UI) ----------
let gifWorkerUrl = null;
function getGifWorkerUrl() {
  if (gifWorkerUrl) return gifWorkerUrl;
  const src = [quantize, lzwEncode, buildGifBuffer].map(f => f.toString()).join('\n') + `
self.onmessage = (e) => {
  const { frames, width, height, loop } = e.data;
  try {
    const fr = frames.map(f => ({ data: new Uint8Array(f.data), delayMs: f.delayMs }));
    const out = buildGifBuffer(fr, width, height, loop, (i, n) => postMessage({ p: i / n }));
    postMessage({ done: out.buffer }, [out.buffer]);
  } catch (err) { postMessage({ error: String((err && err.stack) || err) }); }
};`;
  gifWorkerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return gifWorkerUrl;
}
function encodeGifInWorker(frames, w, h, loop, onProg) {
  if (!CAP.worker) { // fallback síncrono (raro)
    return Promise.resolve(new Blob([buildGifBuffer(frames.map(f => ({ data: new Uint8Array(f.data), delayMs: f.delayMs })), w, h, loop, onProg)], { type: 'image/gif' }));
  }
  return new Promise((res, rej) => {
    const wk = new Worker(getGifWorkerUrl());
    wk.onmessage = (e) => {
      if (e.data.p !== undefined) onProg && onProg(e.data.p);
      else if (e.data.done) { res(new Blob([e.data.done], { type: 'image/gif' })); wk.terminate(); }
      else if (e.data.error) { rej(new Error(e.data.error)); wk.terminate(); }
    };
    wk.onerror = (e) => { rej(new Error(e.message || 'Error en worker GIF')); wk.terminate(); };
    wk.postMessage({ frames, width: w, height: h, loop }, frames.map(f => f.data));
  });
}

// ---------- Video desde frames (WebP animado → MP4/WebM, tiempo real) ----------
async function framesToVideo(frames, w, h, wantMp4, onProg) {
  if (!CAP.mediaRecorder || (!CAP.mp4 && !CAP.webm)) throw new Error('MediaRecorder no está disponible en este navegador');
  const useMp4 = wantMp4 && CAP.mp4;
  const mime = useMp4 ? CAP.mp4Mime : CAP.webmMime;
  const ext = useMp4 ? 'mp4' : 'webm';
  // H.264 exige dimensiones pares
  const W = Math.max(2, w & ~1), H = Math.max(2, h & ~1);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  const canReq = track && typeof track.requestFrame === 'function';
  if (!canReq) { stream = canvas.captureStream(30); track = stream.getVideoTracks()[0]; }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(200);

  // La grabación es en tiempo real: dura lo que dura la animación (limitación de MediaRecorder)
  const isStatic = frames.length === 1;
  const total = isStatic ? 3000 : frames.reduce((a, f) => a + Math.max(f.delayMs, 33), 0);
  let elapsed = 0;
  for (let i = 0; i < frames.length; i++) {
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(frames[i].bmp, 0, 0, W, H);
    if (canReq) track.requestFrame();
    const hold = isStatic ? 3000 : Math.max(frames[i].delayMs, 33);
    // Para frames largos refrescamos la captura periódicamente
    let t = 0;
    while (t < hold) {
      const step = Math.min(100, hold - t);
      await sleep(step); t += step; elapsed += step;
      if (canReq) track.requestFrame();
      onProg && onProg(`Grabando ${ext.toUpperCase()} — frame ${i + 1}/${frames.length}`, 40 + (elapsed / total) * 55);
    }
  }
  await sleep(150);
  rec.stop();
  await stopped;
  track.stop();
  if (!chunks.length) throw new Error('MediaRecorder no produjo datos — códec posiblemente no soportado');
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext, fellBack: wantMp4 && !useMp4 };
}

// ---------- Pipeline de conversión ----------
function setProgress(entry, text, pct) {
  entry.els.progRow.style.display = 'flex';
  entry.els.ptext.textContent = text;
  entry.els.pfill.style.width = Math.min(100, Math.round(pct)) + '%';
}
function baseName(n) { return n.replace(/\.(webp|webm|mp4|m4v)$/i, ''); }

async function convertEntry(entry) {
  if (entry.status === 'processing' || entry.status === 'invalid') return;
  const els = entry.els;
  entry.status = 'processing';
  entry.fallbackNote = '';
  els.card.classList.add('processing');
  els.card.classList.remove('done-card', 'err-card');
  els.status.style.display = 'none'; els.status.className = 'status-line';
  els.resultRow.style.display = 'none';
  els.convertBtn.disabled = true;
  if (entry.outUrl) { URL.revokeObjectURL(entry.outUrl); entry.outUrl = null; }
  refreshCounters(); updateStatsPanel();
  const t0 = performance.now();
  let frames = [];
  try {
    const fmt = entry.format;
    let blob, ext = fmt;

    if (entry.kind === 'video') {
      // ===== Entrada de VIDEO (WebM/MP4) =====
      if (fmt === 'mp4' || fmt === 'webm') {
        setProgress(entry, `Re-codificando video (~${(entry.info.durationMs/1000).toFixed(1)}s, tiempo real)…`, 4);
        const r = await videoToVideo(entry, fmt === 'mp4', (t, p) => setProgress(entry, t, p));
        blob = r.blob; ext = r.ext;
        if (r.fellBack) entry.fallbackNote = 'Este navegador no graba MP4: se generó WebM.';
      } else if (fmt === 'gif') {
        const r = await videoFrames(entry, (t, p) => setProgress(entry, t, p));
        setProgress(entry, 'Cuantizando y codificando GIF (LZW)…', 52);
        blob = await encodeGifInWorker(r.frames, r.W, r.H, 0,
          (p) => setProgress(entry, `Codificando GIF ${Math.round(p * 100)}% (LZW)`, 52 + p * 45));
        if (r.note) entry.fallbackNote = 'GIF ' + r.note + ' para controlar memoria y tamaño.';
      } else { // png / jpg / bmp → primer frame
        setProgress(entry, `Extrayendo primer frame…`, 30);
        const r = await videoFirstFrame(entry);
        setProgress(entry, `Codificando ${fmt.toUpperCase()}…`, 60);
        if (fmt === 'bmp') blob = new Blob([encodeBMP(r.imageData.data, r.W, r.H)], { type: 'image/bmp' });
        else {
          const c = makeCanvas(r.W, r.H);
          const ctx = c.getContext('2d');
          if (fmt === 'jpg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, r.W, r.H); }
          ctx.putImageData ? ctx.putImageData(r.imageData, 0, 0) : null;
          if (fmt === 'jpg') { // putImageData pisa el fondo; recomponer
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, r.W, r.H);
            ctx.drawImage(r.canvas, 0, 0);
          }
          blob = await canvasToBlob(c, fmt === 'png' ? 'image/png' : 'image/jpeg', entry.quality / 100);
        }
        entry.fallbackNote = 'Se usó el primer frame del video.';
      }
    } else {
      // ===== Entrada WEBP =====
      const needAllFrames = (fmt === 'gif' || fmt === 'mp4' || fmt === 'webm') && entry.info.animated;
      setProgress(entry, 'Leyendo archivo…', 2);
      frames = await decodeAllFrames(entry, (t, p) => setProgress(entry, t, p), !needAllFrames);
      if (needAllFrames && frames.length === 1 && entry.info.frames > 1) {
        entry.fallbackNote = 'Sin ImageDecoder: solo se usó el primer frame.';
      }
      const W = frames[0].bmp.width, H = frames[0].bmp.height;

      if (fmt === 'png' || fmt === 'jpg') {
        setProgress(entry, `Codificando ${fmt.toUpperCase()}…`, 60);
        const c = makeCanvas(W, H);
        const ctx = c.getContext('2d');
        if (fmt === 'jpg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H); } // JPG no tiene alpha
        ctx.drawImage(frames[0].bmp, 0, 0);
        blob = await canvasToBlob(c, fmt === 'png' ? 'image/png' : 'image/jpeg', entry.quality / 100);
      } else if (fmt === 'bmp') {
        setProgress(entry, 'Codificando BMP…', 60);
        const id = imageDataFrom(frames[0].bmp, W, H);
        blob = new Blob([encodeBMP(id.data, W, H)], { type: 'image/bmp' });
      } else if (fmt === 'gif') {
        // Extraer RGBA de cada frame y delegar cuantización+LZW al worker
        const payload = [];
        for (let i = 0; i < frames.length; i++) {
          setProgress(entry, `Extrayendo píxeles ${i + 1}/${frames.length}`, 36 + (i / frames.length) * 14);
          const id = imageDataFrom(frames[i].bmp, W, H);
          payload.push({ data: id.data.buffer, delayMs: frames[i].delayMs });
          if (i % 4 === 3) await raf();
        }
        setProgress(entry, 'Cuantizando y codificando GIF (LZW)…', 52);
        blob = await encodeGifInWorker(payload, W, H, entry.info.loopCount || 0,
          (p) => setProgress(entry, `Codificando frame ${Math.round(p * frames.length)}/${frames.length} (LZW)`, 52 + p * 45));
      } else if (fmt === 'mp4' || fmt === 'webm') {
        const secs = entry.info.animated ? (frames.reduce((a, f) => a + Math.max(f.delayMs, 33), 0) / 1000).toFixed(1) : 3;
        setProgress(entry, `Grabando video en tiempo real (~${secs}s)…`, 40);
        const r = await framesToVideo(frames, W, H, fmt === 'mp4', (t, p) => setProgress(entry, t, p));
        blob = r.blob; ext = r.ext;
        if (r.fellBack) entry.fallbackNote = 'Este navegador no graba MP4: se generó WebM (puedes convertirlo a MP4 con cualquier herramienta local).';
      } else {
        throw new Error('Formato desconocido: ' + fmt);
      }
    }

    entry.blob = blob;
    entry.outName = baseName(entry.name) + '.' + ext;
    entry.outUrl = URL.createObjectURL(blob);
    entry.status = 'done';
    setProgress(entry, 'Completado', 100);
    const delta = entry.size - blob.size;
    const pct = entry.size ? Math.abs(delta / entry.size * 100).toFixed(0) : 0;
    els.savings.innerHTML = `${humanSize(entry.size)} → <b style="color:var(--text)">${humanSize(blob.size)}</b> ` +
      (delta >= 0 ? `<span class="pos">(−${pct}%)</span>` : `<span class="neg">(+${pct}%)</span>`);
    els.status.className = 'status-line ok';
    els.status.style.display = 'block';
    els.status.textContent = `✅ ${entry.outName} listo en ${((performance.now() - t0) / 1000).toFixed(1)}s` + (entry.fallbackNote ? ' — ⚠ ' + entry.fallbackNote : '');
    els.resultRow.style.display = 'flex';
    els.card.classList.add('done-card');
    stats.times.push(performance.now() - t0);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || String(err);
    entry.errorStack = err.stack || '';
    els.progRow.style.display = 'none';
    els.status.className = 'status-line error';
    els.status.style.display = 'block';
    els.status.innerHTML = `⛔ Error: ${escapeHtml(entry.error)} <button class="btn btn-sm" data-act="convert" style="margin-left:8px">↻ Reintentar</button>` +
      (entry.errorStack ? `<details class="stack"><summary>Detalles técnicos</summary><pre>${escapeHtml(entry.errorStack)}</pre></details>` : '');
    els.card.classList.add('err-card');
  } finally {
    frames.forEach(f => { try { f.bmp.close(); } catch {} });
    els.card.classList.remove('processing');
    els.convertBtn.disabled = false;
    refreshCounters(); applyFilter(); updateStatsPanel();
  }
}

// ---------- Cola con concurrencia configurable ----------
const queue = [];
async function enqueue(entries) {
  const fresh = entries.filter(e => e.status !== 'processing' && e.status !== 'invalid' && !queue.includes(e));
  queue.push(...fresh);
  if (queueRunning) return;
  queueRunning = true;
  stats.startedAt = performance.now(); stats.batchDone = 0; stats.batchTotal = queue.length; stats.times = [];
  $('#stats').style.display = 'block';
  const limit = +$('#parallel').value || 4;
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const e = queue.shift();
      stats.batchTotal = Math.max(stats.batchTotal, stats.batchDone + queue.length + 1);
      await convertEntry(e);
      stats.batchDone++; updateStatsPanel();
    }
  });
  await Promise.all(workers);
  queueRunning = false;
  updateStatsPanel(true);
  const done = [...FILES.values()].filter(e => e.status === 'done').length;
  const errs = [...FILES.values()].filter(e => e.status === 'error').length;
  toast(`🏁 Lote terminado: <b>${done}</b> completados${errs ? `, <b style="color:var(--err)">${errs}</b> con error` : ''}`);
  notifyDone(done, errs);
  setTimeout(() => { if (!queueRunning) $('#stats').style.display = 'none'; }, 6000);
}

function notifyDone(done, errs) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try { new Notification('WEBP FORGE', { body: `Conversión terminada: ${done} archivos listos${errs ? `, ${errs} errores` : ''}` }); } catch {}
}

// ---------- Descargas ----------
function downloadEntry(entry) {
  if (!entry.blob) return;
  const a = document.createElement('a');
  a.href = entry.outUrl || URL.createObjectURL(entry.blob);
  a.download = entry.outName;
  a.click();
}
async function downloadZip() {
  const done = [...FILES.values()].filter(e => e.status === 'done' && e.blob);
  if (!done.length) return;
  const btn = $('#btn-zip');
  btn.disabled = true;
  const used = new Set();
  const entries = [];
  for (let i = 0; i < done.length; i++) {
    btn.textContent = `📦 Empaquetando ${i + 1}/${done.length}…`;
    let name = done[i].outName;
    // evitar nombres duplicados dentro del ZIP
    if (used.has(name)) { const d = name.lastIndexOf('.'); name = name.slice(0, d) + ` (${done[i].id})` + name.slice(d); }
    used.add(name);
    entries.push({ name, data: new Uint8Array(await done[i].blob.arrayBuffer()) });
    await raf();
  }
  btn.textContent = '📦 Generando ZIP…';
  await raf();
  const zip = buildZip(entries);
  const blob = new Blob([zip], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'webp-forge-convertidos.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  btn.textContent = '⬇ Descargar todos (ZIP)';
  btn.disabled = false;
  toast(`📦 ZIP generado con <b>${entries.length}</b> archivos (${humanSize(blob.size)})`);
}

// ---------- Preview ----------
let modalEntry = null;
function openPreview(entry) {
  if (!entry.blob) return;
  modalEntry = entry;
  $('#modal-title').textContent = entry.name + '  →  ' + entry.outName;
  const orig = $('#pane-orig'), res = $('#pane-res');
  orig.innerHTML = ''; res.innerHTML = '';
  if (entry.kind === 'video') {
    const ov = document.createElement('video');
    ov.src = URL.createObjectURL(entry.file); ov.controls = true; ov.loop = true; ov.muted = true;
    orig.appendChild(ov);
  } else {
    const oimg = new Image();
    oimg.src = URL.createObjectURL(entry.file);
    orig.appendChild(oimg);
  }
  $('#sz-orig').innerHTML = `<b>${humanSize(entry.size)}</b> · ${entry.info.width}×${entry.info.height}${entry.info.animated && entry.kind === 'webp' ? ' · ' + entry.info.frames + ' frames' : ''}`;
  const isVideo = /\.(mp4|webm)$/.test(entry.outName);
  $('#pane-res-title').textContent = 'RESULTADO (' + entry.outName.split('.').pop().toUpperCase() + ')';
  if (isVideo) {
    const v = document.createElement('video');
    v.src = entry.outUrl; v.controls = true; v.autoplay = true; v.loop = true; v.muted = true;
    res.appendChild(v);
  } else {
    const im = new Image(); im.src = entry.outUrl; res.appendChild(im);
  }
  $('#sz-res').innerHTML = `<b>${humanSize(entry.blob.size)}</b>`;
  $('#modal').classList.add('open');
}
function closeModal() {
  $('#modal').classList.remove('open');
  $$('#modal video').forEach(v => { v.pause(); if (v.src.startsWith('blob:') && v.closest('#pane-orig')) URL.revokeObjectURL(v.src); });
  modalEntry = null;
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#modal-dl').addEventListener('click', () => { if (modalEntry) downloadEntry(modalEntry); });

// ---------- Filtros, búsqueda, contadores ----------
function entryMatchesFilter(e, f) {
  switch (f) {
    case 'all': return true;
    case 'static': return e.kind === 'webp' && e.info && e.info.valid && !e.info.animated;
    case 'anim': return e.kind === 'webp' && e.info && e.info.valid && e.info.animated && e.info.durationMs <= 10000;
    case 'video': return (e.kind === 'video' && e.info && e.info.valid) || (e.kind === 'webp' && e.info && e.info.valid && e.info.animated && e.info.durationMs > 10000);
    case 'done': return e.status === 'done';
    case 'error': return e.status === 'error' || e.status === 'invalid';
  }
}
function applyFilter() {
  let visible = 0;
  for (const e of FILES.values()) {
    const show = entryMatchesFilter(e, activeFilter) && (!searchTerm || e.name.toLowerCase().includes(searchTerm));
    e.els.card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  $('#empty-filter').style.display = (FILES.size && !visible) ? 'block' : 'none';
  for (const chip of $$('.filter-chip')) {
    const n = [...FILES.values()].filter(e => entryMatchesFilter(e, chip.dataset.f)).length;
    $('.n', chip).textContent = n ? `(${n})` : '';
  }
}
$$('.filter-chip').forEach(c => c.addEventListener('click', () => {
  $$('.filter-chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  activeFilter = c.dataset.f;
  applyFilter();
}));
$('#search').addEventListener('input', (e) => { searchTerm = e.target.value.toLowerCase().trim(); applyFilter(); });

function refreshCounters() {
  const all = [...FILES.values()];
  const done = all.filter(e => e.status === 'done').length;
  const proc = all.filter(e => e.status === 'processing').length;
  $('#global-counter').innerHTML = `<b>${all.length}</b> archivos &nbsp;|&nbsp; <b>${done}</b> completados &nbsp;|&nbsp; <b>${proc}</b> procesando`;
  $('#btn-zip').disabled = !done;
  const sel = all.filter(e => e.selected && e.status !== 'invalid').length;
  $('#btn-selall').textContent = (sel === all.filter(e => e.status !== 'invalid').length && sel > 0) ? 'Deseleccionar todo' : 'Seleccionar todo';
}
function updateStatsPanel(final) {
  const all = [...FILES.values()];
  $('#st-done').textContent = stats.batchDone + '/' + stats.batchTotal;
  $('#st-proc').textContent = all.filter(e => e.status === 'processing').length;
  const elapsedMin = (performance.now() - stats.startedAt) / 60000;
  $('#st-speed').textContent = stats.batchDone && elapsedMin > 0 ? (stats.batchDone / elapsedMin).toFixed(1) + '/min' : '—';
  const saved = all.filter(e => e.status === 'done').reduce((a, e) => a + (e.size - e.blob.size), 0);
  $('#st-save').textContent = (saved >= 0 ? '−' : '+') + humanSize(Math.abs(saved));
  if (final) { $('#st-eta').textContent = '✓ terminado'; return; }
  const avg = stats.times.length ? stats.times.reduce((a, b) => a + b, 0) / stats.times.length : 0;
  const remaining = stats.batchTotal - stats.batchDone;
  $('#st-eta').textContent = avg && remaining ? Math.ceil(avg * remaining / +$('#parallel').value / 1000) + 's' : '—';
}

// ---------- Controles globales ----------
$('#btn-selall').addEventListener('click', () => {
  const valid = [...FILES.values()].filter(e => e.status !== 'invalid');
  const allSel = valid.every(e => e.selected) && valid.length > 0;
  valid.forEach(e => { e.selected = !allSel; e.els.sel.checked = !allSel; e.els.card.classList.toggle('selected', !allSel); });
  refreshCounters();
});
$('#global-format').addEventListener('change', (e) => {
  const f = e.target.value;
  if (!f) return;
  sessionPrefs.format = f;
  for (const en of FILES.values()) {
    if (en.status === 'invalid' || !en.selected) continue;
    en.format = f;
    if (en.els.fmt) en.els.fmt.value = f;
    if (en.els.qwrap) en.els.qwrap.style.display = f === 'jpg' ? '' : 'none';
  }
  if (f === 'mp4' && !CAP.mp4 && CAP.webm) toast('Este navegador no graba MP4 — se generará <b>WebM</b> como fallback', 'warn');
});
$('#btn-convert').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  const sel = [...FILES.values()].filter(e => e.selected && e.status !== 'invalid');
  if (!sel.length) { toast('No hay archivos seleccionados', 'warn'); return; }
  enqueue(sel);
});
$('#btn-zip').addEventListener('click', downloadZip);
$('#btn-clear').addEventListener('click', () => {
  for (const e of [...FILES.values()]) removeEntry(e);
});

// ---------- Drop zone ----------
const dz = $('#dropzone');
dz.addEventListener('click', (e) => { if (e.target === dz || e.target.closest('.dz-icon, h2, p')) $('#file-input').click(); });
$('#btn-pick').addEventListener('click', (e) => { e.stopPropagation(); $('#file-input').click(); });
$('#btn-pick-dir').addEventListener('click', (e) => { e.stopPropagation(); $('#dir-input').click(); });
$('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#dir-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

// Manejo de arrastre a nivel de documento (soltar en cualquier parte de la página)
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('drag'); });
document.addEventListener('dragover', (e) => {
  e.preventDefault(); // imprescindible: sin esto el navegador NO permite el drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  dz.classList.add('drag');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dz.classList.remove('drag');
});
async function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  dz.classList.remove('drag');
  if (!e.dataTransfer) return;
  try {
    const files = await entriesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
    else toast('No se detectaron archivos en el arrastre', 'warn');
  } catch (err) {
    toast('Error procesando el arrastre: ' + escapeHtml(err.message), 'err');
  }
}
document.addEventListener('drop', handleDrop);
dz.addEventListener('drop', handleDrop); // redundante a propósito: garantiza captura en la zona

// ---------- Atajos de teclado ----------
document.addEventListener('keydown', (e) => {
  const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox';
  if (e.key === 'Escape') { closeModal(); return; }
  if (inInput) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); $('#btn-selall').click(); }
  else if (e.key === 'Enter' && FILES.size) { e.preventDefault(); $('#btn-convert').click(); }
  else if (e.key === ' ' && FILES.size) {
    const first = [...FILES.values()].find(x => x.selected && x.status === 'done');
    if (first) { e.preventDefault(); openPreview(first); }
  }
});

// Liberar recursos al cerrar
window.addEventListener('beforeunload', () => {
  for (const e of FILES.values()) if (e.outUrl) URL.revokeObjectURL(e.outUrl);
});

// Hook de depuración/integración (consola): window.WEBPFORGE
window.WEBPFORGE = { version: '1.1.0', FILES, CAP, addFiles, parseWebP, detectContainer };
