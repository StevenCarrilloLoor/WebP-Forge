'use strict';
/* ============================================================
   WEBP FORGE — APP v1.5 (UI, pipeline de conversión, cola, ZIP)
   Entradas: WebP, GIF, PNG, JPG, BMP, WebM, MP4, ZIP
   v1.5: videos BUSCABLES (Cues/moov + remux post-MediaRecorder),
   MP4 acelerado con WebCodecs H.264 + muxer ISO BMFF propio,
   rediseño completo de la interfaz.
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
  webpEnc: false, mp4: false, webm: false, mp4Mime: '', webmMime: '', mp4AudioMime: '', webmAudioMime: ''
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
// ¿Puede el canvas exportar WebP? (Chrome/Edge/Opera sí; Firefox/Safari no)
try { CAP.webpEnc = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); } catch { CAP.webpEnc = false; }
// Electron NO incluye el encoder H.264 (licencias): isTypeSupported('video/mp4')
// devuelve true pero MediaRecorder no produce datos. Desconfiar de MP4 ahi.
const IS_ELECTRON = /\bElectron\b/i.test(navigator.userAgent);
if (IS_ELECTRON) { CAP.mp4 = false; CAP.mp4Mime = ''; CAP.mp4AudioMime = ''; }

// ---------- Estado ----------
const FILES = new Map();      // id -> entry
let nextId = 1;
let activeFilter = 'all';
let searchTerm = '';
let queueRunning = false;
const sessionPrefs = { format: '', quality: 100 }; // política: máxima calidad por defecto
// Opciones del usuario (toggles de la barra de controles)
const SETTINGS = { gpu: true, fidelity: true };
const stats = { startedAt: 0, batchDone: 0, batchTotal: 0, times: [] };

// ---------- Helpers ----------
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// requestAnimationFrame NO dispara con la pestaña en segundo plano: sin el
// fallback por timer, las conversiones se CONGELABAN al minimizar la ventana.
const raf = () => new Promise(r => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);
});
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
    ['WebP-out', CAP.webpEnc, CAP.webpEnc ? 'Canvas puede codificar WebP de salida (estático y animado)' : 'Este navegador no codifica WebP de salida'],
  ];
  $('#api-status').innerHTML = chips.map(([n, ok, tip]) =>
    `<span class="chip ${ok ? 'on' : 'off'}" title="${escapeHtml(tip)}">${ok ? '✓' : '✗'} ${n}</span>`).join('');
  if (!CAP.imageDecoder) toast('⚠ Este navegador no soporta <b>ImageDecoder</b>: los WebP animados solo se convertirán usando su primer frame. Usa Chrome o Edge para animaciones completas.', 'warn', 9000);
})();

// ---------- Detección de GPU (nombre real + encoder por hardware) ----------
async function detectGPU() {
  let name = '';
  // En equipos HÍBRIDOS (Intel integrada + NVIDIA/AMD dedicada) Chromium corre
  // por defecto en la integrada: hay que pedir EXPLÍCITAMENTE el adaptador de
  // alto rendimiento para ver la GPU dedicada del equipo.
  // WebGPU: adapter.info (Chrome 121+) da vendor/description
  try {
    if (navigator.gpu) {
      const ad = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) || (await navigator.gpu.requestAdapter());
      const info = ad && (ad.info || (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : null));
      if (info) name = info.description || info.device || info.vendor || '';
    }
  } catch {}
  // WebGL: UNMASKED_RENDERER suele dar el modelo exacto ("ANGLE (NVIDIA, NVIDIA GeForce RTX 5080...)")
  try {
    let gl = null;
    for (const type of ['webgl2', 'webgl']) {
      gl = document.createElement('canvas').getContext(type, { powerPreference: 'high-performance' });
      if (gl) break;
    }
    if (!gl) for (const type of ['webgl2', 'webgl']) { gl = document.createElement('canvas').getContext(type); if (gl) break; }
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
      // Preferir el nombre de la GPU DEDICADA si aparece y, entre candidatos
      // equivalentes, el MÁS DESCRIPTIVO (WebGPU a veces solo da "nvidia")
      const esDedicada = /NVIDIA|GeForce|RTX|GTX|Radeon(?! .*Graphics)/i;
      if (esDedicada.test(r) && (!esDedicada.test(name) || r.length > name.length)) name = r;
      else if (!esDedicada.test(name) && r.length > name.length) name = r;
    }
  } catch {}
  // Limpiar envoltorio ANGLE y sufijos de API: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Direct3D11...)" → "NVIDIA GeForce RTX 5080"
  // Nota: el nombre puede contener paréntesis ("Intel(R)"), así que NO se puede
  // cortar en el primer ")": se separa por comas de nivel superior.
  let pretty = name;
  const angle = /^ANGLE \((.+)\)$/.exec(name.trim());
  if (angle) {
    const parts = angle[1].split(', ');
    if (parts.length >= 3) pretty = parts.slice(1, -1).join(', ');
    else if (parts.length === 2) pretty = parts[1];
  }
  pretty = pretty.replace(/\s*\(0x[0-9A-Fa-f]+\)/g, '').replace(/\s+(Direct3D|D3D|OpenGL|Vulkan|Metal).*$/i, '').trim();
  return pretty;
}
(async function gpuInit() {
  const pretty = await detectGPU();
  let hwEncode = false;
  // ¿Expone el navegador el encoder de video por HARDWARE de esta GPU?
  try {
    if (typeof VideoEncoder !== 'undefined') {
      for (const c of ['vp09.00.10.08', 'vp8']) {
        const s = await VideoEncoder.isConfigSupported({ codec: c, width: 1280, height: 720, hardwareAcceleration: 'prefer-hardware' });
        if (s && s.supported) { hwEncode = true; break; }
      }
    }
  } catch {}
  // ¿Hay H.264 vía WebCodecs? Permite MP4 REAL incluso donde MediaRecorder no
  // lo graba (p. ej. Electron con encoder por hardware de la GPU).
  CAP.mp4Fast = false;
  try {
    if (typeof VideoEncoder !== 'undefined') {
      for (const c of ['avc1.640033', 'avc1.4D0033', 'avc1.42E01E']) {
        const s = await VideoEncoder.isConfigSupported({ codec: c, width: 1280, height: 720, avc: { format: 'avc' } });
        if (s && s.supported) { CAP.mp4Fast = true; break; }
      }
    }
  } catch {}
  if (CAP.mp4Fast && !CAP.mp4) {
    const chip = [...document.querySelectorAll('#api-status .chip')].find(c => c.textContent.trim().endsWith('MP4'));
    if (chip) {
      chip.classList.remove('off');
      chip.classList.add('on');
      chip.textContent = '✓ MP4';
      chip.title = 'MP4 disponible vía WebCodecs H.264 (muxer propio, acelerado). MediaRecorder no lo graba en este entorno, pero la app no lo necesita.';
    }
  }
  CAP.gpuName = pretty;
  CAP.hwEncode = hwEncode;
  const short = pretty ? (pretty.length > 26 ? pretty.slice(0, 24) + '…' : pretty) : 'GPU no identificada';
  const chip = document.createElement('span');
  chip.id = 'gpu-chip';
  chip.className = 'chip ' + (pretty ? 'on' : 'off');
  chip.title = (pretty || 'No se pudo identificar la GPU') + ' — encoder de video por hardware: ' +
    (hwEncode ? 'DISPONIBLE ✓ (la opción más rápida, ya activada)' : 'no expuesto por el navegador para VP8/VP9; se usará WebCodecs por software (también muy rápido)') +
    '. En equipos con dos GPU, Windows decide en cuál corre la app: Configuración > Sistema > Pantalla > Gráficos.';
  chip.textContent = '🎮 ' + short + (hwEncode ? ' · HW✓' : '');
  $('#api-status').appendChild(chip);
  const optLabel = $('#opt-gpu') && $('#opt-gpu').closest('label');
  if (optLabel) optLabel.title = 'Aceleración por hardware con tu GPU' + (pretty ? ' (' + pretty + ')' : '') + '. ' +
    (hwEncode ? 'Encoder por hardware verificado: la app ya pide prefer-hardware automáticamente — esta ES la opción más rápida.' :
                'Tu navegador no expone el encoder por hardware para VP8/VP9; con el toggle activo se usa WebCodecs por software, mucho más rápido que el método clásico igualmente.');
  if (pretty) toast(`🎮 GPU detectada: <b>${escapeHtml(pretty)}</b>${hwEncode ? ' — encoder por hardware listo ⚡' : ''}`, '', 6000);
})();

// ---------- Ingesta de archivos ----------
const ACCEPT_RE = /\.(webp|webm|mp4|m4v|gif|png|jpe?g|bmp)$/i;
const ACCEPT_TYPES = ['image/webp', 'video/webm', 'video/mp4', 'image/gif', 'image/png', 'image/jpeg', 'image/bmp'];
const ZIP_RE = /\.zip$/i;

async function entriesFromDataTransfer(dt) {
  const out = [];
  const walkers = [];
  // IMPORTANTE: leer todos los webkitGetAsEntry/getAsFile de forma SÍNCRONA;
  // los DataTransferItem se invalidan en cuanto el handler cede el control.
  if (dt.items && dt.items.length) {
    for (const it of [...dt.items]) {
      if (it.kind !== 'file') continue;
      let entry = null;
      try { entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; } catch {}
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

// Lee metadatos de un video con un elemento <video> (con timeout de seguridad).
// preload='auto' + play() silencioso: en pestañas en segundo plano Chrome
// APLAZA la carga de <video> y loadedmetadata no llegaba nunca (timeout).
function probeVideo(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout leyendo metadatos')); }, 6000);
    const cleanup = () => { clearTimeout(timer); try { v.pause(); } catch {} URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); };
    v.preload = 'auto'; v.muted = true; v.playsInline = true;
    v.onloadedmetadata = () => {
      const out = { width: v.videoWidth, height: v.videoHeight, durationMs: Math.round((v.duration || 0) * 1000) };
      cleanup();
      if (!out.width || !out.height) rej(new Error('el navegador no expone dimensiones de este códec'));
      else res(out);
    };
    v.onerror = () => { cleanup(); rej(new Error('códec no soportado por este navegador')); };
    v.src = url;
    v.load();
    const p = v.play();
    if (p && p.catch) p.catch(() => {}); // solo fuerza la carga; el autoplay puede fallar sin problema
  });
}

// Plan B BINARIO de metadatos: en algunas máquinas el <video> se cuelga y no
// entrega loadedmetadata (visto en uso real). Los metadatos salen entonces del
// CONTENEDOR con los parsers propios — el análisis nunca depende solo del
// pipeline de medios del navegador.
async function probeVideoBinary(file, container) {
  if (container === 'webm' || container === 'mkv') {
    let meta = null;
    try { meta = webmQuickMeta(new Uint8Array(await file.slice(0, 8 * 1048576).arrayBuffer())); } catch {}
    if (meta && meta.durationMs != null) return meta;
    // Sin Duration en la cabecera (típico de grabaciones): recorrer los bloques
    const ext = extractWebMVideoBlocks(new Uint8Array(await file.arrayBuffer()));
    return { width: ext.W, height: ext.H, durationMs: Math.round(ext.durationMs) };
  }
  if (container === 'mp4') {
    let off = 0;
    for (let hops = 0; hops < 64 && off + 16 <= file.size; hops++) {
      const hdr = new DataView(await file.slice(off, off + 16).arrayBuffer());
      let size = hdr.getUint32(0);
      const typ = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
      if (size === 1) size = Number(hdr.getBigUint64(8));
      else if (size === 0) size = file.size - off;
      if (size < 8) break;
      if (typ === 'moov') return mp4QuickMeta(new Uint8Array(await file.slice(off, off + Math.min(size, 32 * 1048576)).arrayBuffer()));
      off += size;
    }
  }
  throw new Error('sin metadatos binarios');
}

// ¿Tiene el video pista de AUDIO? Se lee del CONTENEDOR (exacto, sin depender
// de APIs de reproducción): WebM/MKV → elemento Tracks; MP4 → hdlr 'soun' del
// moov, saltando de box en box con slices para no cargar el archivo entero.
async function hasAudioTrack(file, container) {
  try {
    if (container === 'webm' || container === 'mkv') {
      return webmHasAudio(new Uint8Array(await file.slice(0, 4 * 1048576).arrayBuffer()));
    }
    if (container === 'mp4') {
      let off = 0;
      for (let hops = 0; hops < 64 && off + 16 <= file.size; hops++) {
        const hdr = new DataView(await file.slice(off, off + 16).arrayBuffer());
        let size = hdr.getUint32(0);
        const typ = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
        if (size === 1) size = Number(hdr.getBigUint64(8));
        else if (size === 0) size = file.size - off;
        if (size < 8) break;
        if (typ === 'moov') {
          return mp4HasAudio(new Uint8Array(await file.slice(off, off + Math.min(size, 32 * 1048576)).arrayBuffer()));
        }
        off += size;
      }
    }
  } catch {}
  return false;
}

function defaultFormatFor(entry) {
  if (sessionPrefs.format) return sessionPrefs.format;
  const i = entry.info;
  const mp4Ok = CAP.mp4 || CAP.mp4Fast; // MediaRecorder O WebCodecs H.264
  if (entry.kind === 'video') {
    // Video corto (≤10 s) y SIN audio: el sonido no pinta nada, así que el
    // destino natural es GIF (comportamiento de animación).
    if (i.durationMs <= 10000 && !i.hasAudio) return 'gif';
    // Convertir al "otro" contenedor por defecto; MP4 es lo más universal
    if (i.type !== 'mp4' && mp4Ok) return 'mp4';
    if (i.type === 'mp4' && CAP.webm) return 'webm';
    return mp4Ok ? 'mp4' : (CAP.webm ? 'webm' : 'gif');
  }
  if (entry.kind === 'gif') {
    // GIF animado → WebP animado (mucho más pequeño); sin encoder WebP → video
    if (CAP.webpEnc) return 'webp';
    return mp4Ok ? 'mp4' : (CAP.webm ? 'webm' : 'gif');
  }
  if (entry.kind === 'image') {
    // Imagen "normal" → WebP es la conversión típica
    if (CAP.webpEnc) return 'webp';
    return i.type === 'png' ? 'jpg' : 'png';
  }
  // Entrada WebP
  if (i.animated) {
    if (i.durationMs > 10000) return mp4Ok ? 'mp4' : (CAP.webm ? 'webm' : 'gif');
    return 'gif';
  }
  // Estático → PNG siempre: política de MÁXIMA CALIDAD (preferencia del usuario).
  // PNG re-codifica sin ninguna pérdida adicional y conserva transparencia;
  // el tamaño no es prioridad. (JPG sigue disponible en el selector.)
  return 'png';
}

// Expande ZIPs: extrae los archivos compatibles que contengan (DecompressionStream nativo)
async function expandZips(files) {
  const out = [];
  for (const f of files) {
    const looksZip = ZIP_RE.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
    if (!looksZip) { out.push(f); continue; }
    try {
      const buf = await f.arrayBuffer();
      if (detectContainer(buf) !== 'zip') throw new Error('no tiene firma ZIP válida');
      const entries = listZipEntries(buf);
      const sup = entries.filter(e => ACCEPT_RE.test(e.name));
      if (!sup.length) { toast(`📦 <b>${escapeHtml(f.name)}</b>: no contiene archivos compatibles`, 'warn'); continue; }
      toast(`📦 Extrayendo <b>${sup.length}</b> archivo(s) de ${escapeHtml(f.name)}…`);
      for (const e of sup) {
        try {
          const data = await extractZipEntry(buf, e);
          out.push(new File([data], e.name.split('/').pop()));
        } catch (err) { toast(`⛔ ${escapeHtml(e.name)}: ${escapeHtml(err.message)}`, 'err'); }
      }
    } catch (err) { toast(`⛔ ZIP ${escapeHtml(f.name)}: ${escapeHtml(err.message)}`, 'err', 6000); }
  }
  return out;
}

async function addFiles(fileList) {
  const all = await expandZips([...fileList]);
  const accepted = all.filter(f => ACCEPT_RE.test(f.name) || ACCEPT_TYPES.includes(f.type));
  const skipped = all.length - accepted.length;
  if (skipped > 0) toast(`Se omitieron <b>${skipped}</b> archivo(s) no soportados (acepto .webp, .webm, .mp4)`, 'warn');
  if (!accepted.length) { if (!skipped) toast('No se encontraron archivos compatibles (WebP, GIF, PNG, JPG, BMP, WebM, MP4, ZIP)', 'warn'); return; }

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
      const blank = { hasAlpha: false, hasICC: false, hasEXIF: false, hasXMP: false, truncated: false, loopCount: 0, durationMs: 0 };
      if (container === 'webp') {
        entry.kind = 'webp';
        let info = parseWebP(head, file.size);
        if (info.valid && info.animated) info = parseWebP(await file.arrayBuffer(), file.size);
        entry.info = info;
        if (!info.valid) { entry.status = 'invalid'; entry.error = info.reason; }
      } else if (container === 'gif') {
        const g = parseGIF(await file.arrayBuffer());
        entry.kind = g.animated ? 'gif' : 'image';
        entry.info = { ...blank, valid: g.width > 0 && g.height > 0, type: 'gif', animated: g.animated,
                       frames: g.frames, width: g.width, height: g.height, durationMs: g.durationMs, loopCount: g.loopCount };
        if (!entry.info.valid) { entry.status = 'invalid'; entry.error = 'GIF con header inválido'; }
      } else if (container === 'png' || container === 'jpg' || container === 'bmp') {
        entry.kind = 'image';
        let dims = container === 'png' ? parsePNG(head)
                 : container === 'bmp' ? parseBMP(head)
                 : parseJPEG(await file.slice(0, 1048576).arrayBuffer());
        if (!dims || !dims.width || !dims.height) {
          // Fallback: que el navegador decodifique las dimensiones
          try { const bmp = await createImageBitmap(file); dims = { width: bmp.width, height: bmp.height }; bmp.close(); }
          catch { dims = null; }
        }
        if (dims) entry.info = { ...blank, valid: true, type: container, animated: false, frames: 1, width: dims.width, height: dims.height };
        else { entry.status = 'invalid'; entry.info = { valid: false }; entry.error = 'No se pudieron leer las dimensiones de la imagen'; }
      } else if (container === 'webm' || container === 'mp4' || container === 'mkv') {
        entry.kind = 'video';
        try {
          let m;
          try { m = await probeVideo(file); }
          catch (e1) { m = await probeVideoBinary(file, container); } // <video> colgado → parsers propios
          const audio = await hasAudioTrack(file, container);
          entry.info = { ...blank, valid: true, video: true, type: container, animated: true, frames: 0,
                         width: m.width, height: m.height, durationMs: m.durationMs || 0, hasAudio: audio };
        } catch (err) {
          entry.status = 'invalid'; entry.info = { valid: false };
          entry.error = `Video ${container.toUpperCase()} detectado, pero no se puede decodificar: ${err.message}`;
        }
      } else {
        entry.status = 'invalid'; entry.info = { valid: false };
        entry.error = 'Formato no reconocido (acepto WebP, GIF, PNG, JPG, BMP, WebM, MP4, ZIP)';
      }
      if (entry.status !== 'invalid' && entry.info && entry.info.valid) entry.format = defaultFormatFor(entry);
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
  if ($('#facets')) $('#facets').style.display = 'flex';
  refreshCounters(); applyFilter();
  toast(`<b>${accepted.length}</b> archivo(s) añadidos`);
}

// ---------- Tarjetas ----------
const FORMATS = [['webp','WebP'],['jpg','JPG'],['png','PNG'],['gif','GIF'],['mp4','MP4'],['webm','WebM'],['bmp','BMP']];

function badgeFor(entry) {
  const i = entry.info;
  if (!i || !i.valid) return '<span class="badge invalid">⛔ NO VÁLIDO</span>';
  if (entry.kind === 'video') {
    return `<span class="badge video">🟠 VIDEO ${i.type.toUpperCase()} · ${(i.durationMs/1000).toFixed(1)}s</span>`;
  }
  if (i.animated) {
    const label = entry.kind === 'gif' ? 'GIF ANIMADO' : 'ANIMADO';
    if (i.durationMs > 10000) return `<span class="badge video">🟠 ${label} · ${i.frames} frames · ${(i.durationMs/1000).toFixed(1)}s</span>`;
    return `<span class="badge anim">🟣 ${label} · ${i.frames} frames</span>`;
  }
  const names = { lossy: 'LOSSY (VP8)', lossless: 'LOSSLESS (VP8L)', extended: 'ESTÁTICO (VP8X)', gif: 'GIF', png: 'PNG', jpg: 'JPEG', bmp: 'BMP' };
  return `<span class="badge static">🟦 ${names[i.type] || i.type.toUpperCase()}</span>`;
}
function metaFor(entry) {
  const i = entry.info;
  let s = `Tamaño: <b>${humanSize(entry.size)}</b>`;
  if (i && i.valid) {
    s += ` &nbsp;|&nbsp; <b>${i.width}×${i.height}</b>`;
    if (entry.kind === 'video') s += ` &nbsp;|&nbsp; <b>${(i.durationMs/1000).toFixed(2)}s</b> de video &nbsp;|&nbsp; ${i.hasAudio ? '🔊 audio' : '🔇 sin audio'}`;
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
      <input type="checkbox" class="sel-box" data-act="sel" ${entry.selected ? 'checked' : ''}>
      <img class="thumb thumb-skel" alt="">
      <div class="card-body">
        <div class="card-top"><span class="fname" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>${badgeFor(entry)}</div>
        <div class="fmeta">${metaFor(entry)}</div>
        ${invalid ? `<div class="status-line error" style="display:block">⛔ ${escapeHtml(entry.error)}</div>` : `
        <div class="card-controls">
          <label style="font-size:12px;color:var(--text-2)">Convertir a:</label>
          <select class="fmt-select" data-act="fmt">${FORMATS.map(([v, l]) => `<option value="${v}" ${v === entry.format ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="q-wrap" style="${['jpg','webp'].includes(entry.format) ? '' : 'display:none'}">Calidad <input type="range" min="10" max="100" value="${entry.quality}" data-act="q"> <span class="qv">${entry.quality}%</span></span>
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
      const TH = 184; // 92px CSS × 2 para nitidez en pantallas retina
      if (entry.kind === 'video' && entry.info && entry.info.valid) {
        const { v, url } = await videoElement(entry);
        await seekTo(v, Math.min(0.1, (v.duration || 1) / 10));
        w = v.videoWidth; h = v.videoHeight; draw = v;
        const s = TH / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(draw, 0, 0, c.width, c.height);
        entry.els.thumb.src = c.toDataURL('image/png');
        URL.revokeObjectURL(url);
      } else {
        const bmp = await createImageBitmap(entry.file); // primer frame del webp
        const s = TH / Math.max(bmp.width, bmp.height);
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
    entry.els.qwrap.style.display = ['jpg','webp'].includes(entry.format) ? '' : 'none';
    if ((entry.format === 'mp4' && !CAP.mp4 && !CAP.mp4Fast && CAP.webm)) toast('Este navegador no graba MP4 — se generará <b>WebM</b> como fallback', 'warn');
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
  if (!FILES.size) {
    $('#controls').style.display = 'none';
    $('#filters').style.display = 'none';
    if ($('#facets')) $('#facets').style.display = 'none';
  }
}

// ---------- Decodificación WebP ----------
async function decodeAllFrames(entry, onProg, firstOnly) {
  if (entry.kind === 'image') {
    const bmp = await createImageBitmap(entry.file);
    onProg && onProg('Decodificado', 35);
    return [{ bmp, delayMs: 100 }];
  }
  const mime = entry.kind === 'gif' ? 'image/gif' : 'image/webp';
  const buf = await entry.file.arrayBuffer();
  let decoderOk = false;
  if (CAP.imageDecoder) { try { decoderOk = await ImageDecoder.isTypeSupported(mime); } catch { decoderOk = false; } }
  if (decoderOk) {
    const dec = new ImageDecoder({ data: buf, type: mime });
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
  const bmp = await createImageBitmap(new Blob([buf], { type: mime }));
  onProg && onProg('Decodificado (primer frame)', 35);
  return [{ bmp, delayMs: 100 }];
}

// Bitrate razonable según resolución y fps. Antes eran 16 Mbps FIJOS y un
// WebM de 2 MB salía como video de 5-7 MB (+163%/+227% reportado en uso real).
function videoBitrateFor(w, h, fps) {
  return Math.max(1_200_000, Math.min(16_000_000, Math.round(w * h * Math.min(fps || 30, 60) * 0.09)));
}
// Elige el primer códec H.264 soportado. Devuelve { codec, hw } o null.
async function pickH264(W, H) {
  for (const c of ['avc1.640033', 'avc1.4D0033', 'avc1.42E01E', 'avc1.42001E']) {
    try {
      const hw = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, avc: { format: 'avc' }, hardwareAcceleration: 'prefer-hardware' });
      if (hw.supported) return { codec: c, hw: true };
    } catch {}
    try {
      const sup = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, avc: { format: 'avc' } });
      if (sup.supported) return { codec: c, hw: false };
    } catch {}
  }
  return null;
}
// Ejecuta un intento de codificación con reintento HW → SOFTWARE: los
// encoders por hardware pueden fallar A MITAD (p. ej. NVENC rechaza
// resoluciones pequeñas) y eso solo se ve al codificar, no en isConfigSupported.
async function conReintentoHW(usaHw, intento) {
  let ultimo = null;
  for (const hw of usaHw ? [true, false] : [false]) {
    try { return await intento(hw); }
    catch (e) {
      ultimo = e;
      console.warn(`Encoder ${hw ? 'por hardware' : 'por software'} falló:`, (e && e.name ? e.name + ': ' + e.message : e));
    }
  }
  throw ultimo || new Error('Sin encoder disponible');
}
// flush protegido: si el codec ya se cerró por un error interno, reporta el
// ERROR ORIGINAL en vez del InvalidStateError del flush (que lo enmascaraba).
async function flushCodec(codec, getErr) {
  if (getErr()) throw getErr();
  try { await codec.flush(); } catch (e) { throw getErr() || e; }
  if (getErr()) throw getErr();
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
    const FPS = 10;
    // 🎯 Fidelidad máx.: resolución ORIGINAL, hasta 2 min de captura.
    // Modo seguro (toggle apagado): reescala a 960px y 30s para proteger la RAM.
    const MAX_FRAMES = SETTINGS.fidelity ? 1200 : 300;
    const MAX_W = SETTINGS.fidelity ? Infinity : 960;
    const scale = Math.min(1, MAX_W / v.videoWidth);
    const W = Math.max(2, Math.round(v.videoWidth * scale) & ~1);
    const H = Math.max(2, Math.round(v.videoHeight * scale) & ~1);
    const total = Math.min(Math.ceil((v.duration || 0) * FPS), MAX_FRAMES);
    if (total < 1) throw new Error('duración de video inválida');
    const estBytes = W * H * 4 * total;
    if (estBytes > 2_000_000_000) toast(`⚠ Esta captura necesita ≈ <b>${humanSize(estBytes)}</b> de RAM (${total} frames a ${W}×${H}). Si la pestaña se queda sin memoria, desactiva 🎯 Fidelidad máx.`, 'warn', 10000);
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
    if (scale < 1) note.push(`reescalado a ${W}×${H} (modo seguro)`);
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
    const vbr = videoBitrateFor(v.videoWidth || 1280, v.videoHeight || 720, 30);
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbr }); }
    catch { // códec de audio no soportado → quitar audio y reintentar solo con video
      stream.getAudioTracks().forEach(t => stream.removeTrack(t));
      mime = useMp4 ? CAP.mp4Mime : CAP.webmMime;
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbr });
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
    if (!chunks.length) {
      if (useMp4 && CAP.webm) {
        // El encoder MP4 no existe realmente (típico de Electron): reintento en WebM
        const r = await videoToVideo(entry, false, onProg);
        return { ...r, fellBack: true };
      }
      throw new Error('MediaRecorder no produjo datos — códec posiblemente no soportado');
    }
    onProg(`Reparando índice de seek…`, 97);
    const blob = await fixSeekableBlob(new Blob(chunks, { type: mime.split(';')[0] }), ext);
    return { blob, ext, fellBack: wantMp4 && !useMp4 };
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

// ---------- Post-proceso: hacer BUSCABLE lo que graba MediaRecorder ----------
// MediaRecorder emite video "de streaming": sin duración (∞) y sin índice de
// seek → al hacer clic en la barra el video se reiniciaba. Se remuxea el
// contenedor (sin re-codificar) con Duration + Cues (WebM) o moov progresivo
// (MP4). Si el remux fallara, se entrega el original (nunca peor).
async function fixSeekableBlob(blob, ext) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (ext === 'webm') return new Blob([remuxWebM(buf)], { type: 'video/webm' });
    if (ext === 'mp4') {
      const out = remuxMP4(buf);
      return out ? new Blob([out], { type: 'video/mp4' }) : blob;
    }
  } catch (e) { console.warn('Remux post-grabación falló; se entrega el original:', e); }
  return blob;
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

  const fpsEst = 1000 / Math.max(20, frames.reduce((a, f) => a + Math.max(f.delayMs, 33), 0) / frames.length);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBitrateFor(W, H, fpsEst) });
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
  if (!chunks.length) {
    if (useMp4 && CAP.webm) {
      // El encoder MP4 no existe realmente (típico de Electron): reintento en WebM
      const r = await framesToVideo(frames, w, h, false, onProg);
      return { ...r, fellBack: true };
    }
    throw new Error('MediaRecorder no produjo datos — códec posiblemente no soportado');
  }
  onProg && onProg('Reparando índice de seek…', 97);
  const blob = await fixSeekableBlob(new Blob(chunks, { type: mime.split(';')[0] }), ext);
  return { blob, ext, fellBack: wantMp4 && !useMp4 };
}

// ---------- WebP animado desde frames (canvas → webp estático → muxer propio) ----------
async function framesToAnimatedWebP(frames, w, h, loop, q, onProg) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const enc = [];
  for (let i = 0; i < frames.length; i++) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(frames[i].bmp, 0, 0);
    const fb = await canvasToBlob(c, 'image/webp', q);
    enc.push({ bytes: new Uint8Array(await fb.arrayBuffer()), delayMs: frames[i].delayMs });
    onProg && onProg(`Codificando frame WebP ${i + 1}/${frames.length}`, 40 + (i + 1) / frames.length * 55);
    if (i % 5 === 4) await raf();
  }
  return new Blob([buildAnimatedWebP(enc, w, h, loop)], { type: 'image/webp' });
}

// ---------- WebM acelerado: WebCodecs VideoEncoder + muxer EBML propio ----------
// Mucho más rápido que MediaRecorder (no está atado a tiempo real) y usa el
// encoder por hardware del sistema cuando está disponible.
async function framesToWebMFast(frames, w, h, onProg) {
  const W = Math.max(2, w & ~1), H = Math.max(2, h & ~1);
  let codec = null, codecId = null, hwConfig = null;
  for (const [c, id] of [['vp09.00.10.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
    // Pedir explícitamente el encoder por HARDWARE; si el sistema no lo ofrece
    // para este códec, aceptar el que haya (software WebCodecs sigue siendo
    // mucho más rápido que MediaRecorder en tiempo real).
    try {
      const hw = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, hardwareAcceleration: 'prefer-hardware' });
      if (hw.supported) { codec = c; codecId = id; hwConfig = 'prefer-hardware'; break; }
    } catch {}
    try {
      const sup = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H });
      if (sup.supported) { codec = c; codecId = id; hwConfig = null; break; }
    } catch {}
  }
  if (!codec) throw new Error('VideoEncoder sin soporte VP8/VP9');
  const fpsEst = 1000 / Math.max(20, frames.reduce((a, f) => a + Math.max(f.delayMs, 10), 0) / frames.length);
  return conReintentoHW(!!hwConfig, async (usarHw) => {
    const blocks = [];
    let encError = null;
    const enc = new VideoEncoder({
      output: (chunk) => {
        const d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        blocks.push({ data: d, key: chunk.type === 'key', timestampMs: chunk.timestamp / 1000 });
      },
      error: (e) => { encError = e; }
    });
    try {
      const cfg = { codec, width: W, height: H, bitrate: videoBitrateFor(W, H, fpsEst) };
      if (usarHw) cfg.hardwareAcceleration = 'prefer-hardware';
      enc.configure(cfg);
      const c = makeCanvas(W, H);
      const ctx = c.getContext('2d');
      let ts = 0;
      for (let i = 0; i < frames.length; i++) {
        if (encError) throw encError;
        ctx.drawImage(frames[i].bmp, 0, 0, W, H);
        const vf = new VideoFrame(c, { timestamp: ts * 1000, duration: Math.max(frames[i].delayMs, 10) * 1000 });
        enc.encode(vf, { keyFrame: i % 60 === 0 });
        vf.close();
        ts += Math.max(frames[i].delayMs, 10);
        onProg && onProg(`Codificando ⚡WebCodecs ${i + 1}/${frames.length}`, 40 + (i + 1) / frames.length * 50);
        if (i % 10 === 9) await raf();
      }
      await flushCodec(enc, () => encError);
      if (!blocks.length) throw new Error('VideoEncoder no produjo chunks');
      return new Blob([buildWebM(codecId, W, H, blocks, ts)], { type: 'video/webm' });
    } finally { try { enc.close(); } catch {} }
  });
}

// ---------- MP4 acelerado: WebCodecs H.264 + muxer ISO BMFF propio ----------
// MP4 real, con moov progresivo y seek perfecto, codificado más rápido que
// tiempo real (encoder por hardware si el sistema lo expone). En Electron el
// H.264 no está disponible → isConfigSupported dirá que no y se cae al
// camino clásico (que a su vez degrada a WebM con aviso).
async function framesToMP4Fast(frames, w, h, onProg) {
  const W = Math.max(2, w & ~1), H = Math.max(2, h & ~1);
  const sel = await pickH264(W, H);
  if (!sel) throw new Error('VideoEncoder sin soporte H.264 en este entorno');
  const delayOf = (i) => frames.length === 1 ? 3000 : Math.max(frames[i].delayMs, 10);
  const fpsEst = frames.length === 1 ? 1 : 1000 / Math.max(20, frames.reduce((a, f) => a + Math.max(f.delayMs, 10), 0) / frames.length);
  return conReintentoHW(sel.hw, async (usarHw) => {
    let description = null, encError = null;
    const samples = [];
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          description = new Uint8Array(meta.decoderConfig.description instanceof ArrayBuffer ? meta.decoderConfig.description : meta.decoderConfig.description.buffer);
        }
        const d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        samples.push({ data: d, key: chunk.type === 'key' });
      },
      error: (e) => { encError = e; }
    });
    try {
      const cfg = { codec: sel.codec, width: W, height: H, bitrate: videoBitrateFor(W, H, fpsEst), avc: { format: 'avc' } };
      if (usarHw) cfg.hardwareAcceleration = 'prefer-hardware';
      enc.configure(cfg);
      const c = makeCanvas(W, H);
      const ctx = c.getContext('2d');
      let ts = 0;
      for (let i = 0; i < frames.length; i++) {
        if (encError) throw encError;
        ctx.drawImage(frames[i].bmp, 0, 0, W, H);
        const vf = new VideoFrame(c, { timestamp: ts * 1000, duration: delayOf(i) * 1000 });
        enc.encode(vf, { keyFrame: i % 60 === 0 });
        vf.close();
        ts += delayOf(i);
        onProg && onProg(`Codificando ⚡H.264 ${i + 1}/${frames.length}`, 40 + (i + 1) / frames.length * 50);
        if (i % 10 === 9) await raf();
      }
      await flushCodec(enc, () => encError);
      if (!samples.length) throw new Error('VideoEncoder no produjo muestras');
      if (!description) throw new Error('El encoder no entregó avcC (description)');
      const TS = 90000; // timescale estándar de video
      let i = 0;
      const mp4 = buildMP4([{
        kind: 'video', timescale: TS, W, H,
        sampleEntry: avc1SampleEntry(W, H, description),
        samples: samples.map(s => ({ data: s.data, key: s.key, dur: Math.max(1, Math.round(delayOf(i++) * TS / 1000)) })),
      }]);
      return new Blob([mp4], { type: 'video/mp4' });
    } finally { try { enc.close(); } catch {} }
  });
}

// ---------- Video → MP4 acelerado (demux propio + VideoDecoder + H.264) ----------
// Para videos SIN audio: demuxea el WebM/MKV con el parser EBML propio,
// decodifica con VideoDecoder y re-codifica H.264 al muxer MP4 propio. Más
// rápido que tiempo real y la ÚNICA vía de MP4 real donde MediaRecorder no
// graba MP4 (app de escritorio).
async function videoToMP4Fast(entry, onProg) {
  if (typeof VideoDecoder === 'undefined') throw new Error('VideoDecoder no disponible');
  onProg('Leyendo y demuxeando el video…', 3);
  const buf = new Uint8Array(await entry.file.arrayBuffer());
  const src = extractWebMVideoBlocks(buf);
  const DEC = { V_VP8: ['vp8'], V_VP9: ['vp09.00.10.08', 'vp09.00.31.08', 'vp09.00.51.08'], V_AV1: ['av01.0.08M.08', 'av01.0.04M.08'] };
  const candidatos = DEC[src.codecId];
  if (!candidatos) throw new Error('Códec de origen no soportado para transcodificar: ' + src.codecId);
  let dcodec = null;
  for (const c of candidatos) {
    try {
      const s = await VideoDecoder.isConfigSupported({ codec: c, codedWidth: src.W, codedHeight: src.H });
      if (s && s.supported) { dcodec = c; break; }
    } catch {}
  }
  if (!dcodec) throw new Error('VideoDecoder no soporta ' + src.codecId + ' en este entorno');
  const W = Math.max(2, src.W & ~1), H = Math.max(2, src.H & ~1);
  const fps = src.blocks.length / Math.max(src.durationMs / 1000, 0.1);
  const sel = await pickH264(W, H);
  if (!sel) throw new Error('VideoEncoder sin soporte H.264');
  return conReintentoHW(sel.hw, async (usarHw) => {
    let description = null, encError = null, decError = null;
    const samples = [];
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          const d = meta.decoderConfig.description;
          description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer);
        }
        const dd = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dd);
        samples.push({ data: dd, key: chunk.type === 'key', tsUs: chunk.timestamp });
      },
      error: (e) => { encError = e; },
    });
    const keyQ = src.blocks.map(b => b.key);
    let iOut = 0;
    // Los frames decodificados llegan en formatos YUV que algunos encoders
    // H.264 rechazan ("Unexpected frame format", visto en la app de
    // escritorio): se normalizan pasando por canvas (RGBA), igual que en la
    // vía de frames que sí funciona en todos lados.
    const cnv = makeCanvas(W, H);
    const cctx = cnv.getContext('2d');
    const dec = new VideoDecoder({
      output: (frame) => {
        try {
          if (!encError) {
            cctx.drawImage(frame, 0, 0, W, H);
            const vf = new VideoFrame(cnv, { timestamp: frame.timestamp, duration: frame.duration || undefined });
            enc.encode(vf, { keyFrame: !!keyQ[iOut] || iOut % 120 === 0 });
            vf.close();
          }
          iOut++;
        } catch (e) { encError = e; }
        finally { frame.close(); }
      },
      error: (e) => { decError = e; },
    });
    try {
      const cfg = { codec: sel.codec, width: W, height: H, bitrate: videoBitrateFor(W, H, fps), avc: { format: 'avc' } };
      if (usarHw) cfg.hardwareAcceleration = 'prefer-hardware';
      enc.configure(cfg);
      dec.configure({ codec: dcodec, codedWidth: src.W, codedHeight: src.H });
      for (let i = 0; i < src.blocks.length; i++) {
        const blk = src.blocks[i];
        dec.decode(new EncodedVideoChunk({ type: blk.key ? 'key' : 'delta', timestamp: Math.round(blk.timestampMs * 1000), data: blk.data }));
        if (dec.decodeQueueSize > 8) await new Promise(r => dec.addEventListener('dequeue', r, { once: true }));
        if (decError) throw decError;
        if (encError) throw encError;
        onProg(`Transcodificando ⚡ ${i + 1}/${src.blocks.length}`, 5 + (i + 1) / src.blocks.length * 82);
        if (i % 20 === 19) await raf();
      }
      await flushCodec(dec, () => decError);
      await flushCodec(enc, () => encError || decError);
      if (!samples.length) throw new Error('La transcodificación no produjo muestras');
      if (!description) throw new Error('El encoder no entregó avcC');
      onProg('Muxeando MP4…', 92);
      const TS = 90000;
      samples.sort((a, b) => a.tsUs - b.tsUs);
      const durs = samples.map((s, i) => {
        const next = samples[i + 1];
        const prev = samples[i - 1];
        const us = next ? next.tsUs - s.tsUs : (prev ? s.tsUs - prev.tsUs : 100000);
        return Math.max(1, Math.round(us * TS / 1e6));
      });
      const mp4 = buildMP4([{
        kind: 'video', timescale: TS, W, H,
        sampleEntry: avc1SampleEntry(W, H, description),
        samples: samples.map((s, i) => ({ data: s.data, key: s.key, dur: durs[i] })),
      }]);
      return new Blob([mp4], { type: 'video/mp4' });
    } finally {
      try { dec.close(); } catch {}
      try { enc.close(); } catch {}
    }
  });
}

// ---------- Video → MP4 por CAPTURA (tiempo real, rVFC + H.264) ----------
// Plan B cuando el VideoDecoder no soporta el códec de origen (visto en la
// app de escritorio con VP9): se reproduce el <video> y cada frame presentado
// se codifica a H.264 con requestVideoFrameCallback. Tiempo real, pero MP4
// REAL con el muxer propio. Solo para fuentes sin audio.
async function videoToMP4Capture(entry, onProg) {
  if (typeof HTMLVideoElement === 'undefined' || !HTMLVideoElement.prototype.requestVideoFrameCallback) throw new Error('requestVideoFrameCallback no disponible');
  const { v, url } = await videoElement(entry);
  try {
    const W = Math.max(2, v.videoWidth & ~1), H = Math.max(2, v.videoHeight & ~1);
    const sel = await pickH264(W, H);
    if (!sel) throw new Error('VideoEncoder sin soporte H.264');
    return await conReintentoHW(sel.hw, async (usarHw) => {
      v.pause();
      v.currentTime = 0; // cada intento reproduce desde el inicio
      let description = null, encError = null, nFrames = 0;
      const samples = [];
      const enc = new VideoEncoder({
        output: (chunk, meta) => {
          if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
            const d = meta.decoderConfig.description;
            description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer);
          }
          const dd = new Uint8Array(chunk.byteLength);
          chunk.copyTo(dd);
          samples.push({ data: dd, key: chunk.type === 'key', tsUs: chunk.timestamp });
        },
        error: (e) => { encError = e; },
      });
      try {
        const cfg = { codec: sel.codec, width: W, height: H, bitrate: videoBitrateFor(W, H, 30), avc: { format: 'avc' } };
        if (usarHw) cfg.hardwareAcceleration = 'prefer-hardware';
        enc.configure(cfg);
        let done = false;
        // Igual que en la transcodificación: normalizar cada frame vía canvas
        // (RGBA) para que cualquier encoder H.264 lo acepte.
        const cnv = makeCanvas(W, H);
        const cctx = cnv.getContext('2d');
        const onFrame = (_now, meta) => {
          if (done || encError) return;
          try {
            cctx.drawImage(v, 0, 0, W, H);
            const vf = new VideoFrame(cnv, { timestamp: Math.round((meta.mediaTime || v.currentTime) * 1e6) });
            enc.encode(vf, { keyFrame: nFrames % 60 === 0 });
            vf.close();
            nFrames++;
            onProg(`Capturando y codificando H.264 — ${v.currentTime.toFixed(1)}s / ${(v.duration || 0).toFixed(1)}s (tiempo real)`, 5 + (v.currentTime / (v.duration || 1)) * 85);
          } catch (e) { encError = e; }
          v.requestVideoFrameCallback(onFrame);
        };
        v.requestVideoFrameCallback(onFrame);
        await v.play();
        await new Promise((res, rej) => { v.onended = res; v.onerror = () => rej(new Error('error reproduciendo el video')); });
        done = true;
        await flushCodec(enc, () => encError);
        if (samples.length < 1) throw new Error('La captura no produjo frames');
        if (!description) throw new Error('El encoder no entregó avcC');
        const TS = 90000;
        samples.sort((a, b) => a.tsUs - b.tsUs);
        const durs = samples.map((s, i) => {
          const next = samples[i + 1];
          const prev = samples[i - 1];
          const us = next ? next.tsUs - s.tsUs : (prev ? s.tsUs - prev.tsUs : 33333);
          return Math.max(1, Math.round(us * TS / 1e6));
        });
        const mp4 = buildMP4([{
          kind: 'video', timescale: TS, W, H,
          sampleEntry: avc1SampleEntry(W, H, description),
          samples: samples.map((s, i) => ({ data: s.data, key: s.key, dur: durs[i] })),
        }]);
        return new Blob([mp4], { type: 'video/mp4' });
      } finally { try { enc.close(); } catch {} }
    });
  } finally { URL.revokeObjectURL(url); }
}

// Comprueba que un blob de video es decodificable Y buscable antes de darlo
// por bueno (dimensiones válidas + duración finita, sin la cual no hay seek).
// Si el <video> del navegador está COLGADO (timeout, visto en uso real), se
// valida ESTRUCTURALMENTE con los parsers propios en vez de rechazar en falso.
async function validateVideoBlob(blob, ext) {
  const porVideo = await new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    const t = setTimeout(() => { URL.revokeObjectURL(url); res('timeout'); }, 8000);
    v.onloadedmetadata = () => { clearTimeout(t); URL.revokeObjectURL(url); res(v.videoWidth > 0 && isFinite(v.duration) && v.duration > 0 ? 'ok' : 'bad'); };
    v.onerror = () => { clearTimeout(t); URL.revokeObjectURL(url); res('bad'); };
    v.src = url;
  });
  if (porVideo !== 'timeout') return porVideo === 'ok';
  try {
    const b = new Uint8Array(await blob.arrayBuffer());
    if (ext === 'mp4') return remuxMP4(b) === null; // progresivo, parseable y con moov
    if (ext === 'webm') { remuxWebM(b); return true; } // parseable de punta a punta
  } catch { return false; }
  return false;
}

// ---------- Pipeline de conversión ----------
function setProgress(entry, text, pct) {
  entry.els.progRow.style.display = 'flex';
  entry.els.ptext.textContent = text;
  entry.els.pfill.style.width = Math.min(100, Math.round(pct)) + '%';
}
function baseName(n) { return n.replace(/\.(webp|webm|mp4|m4v|gif|png|jpe?g|bmp)$/i, ''); }

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
        let r = null;
        // ⚡ MP4 sin audio desde WebM/MKV: transcodificación WebCodecs con demux
        // propio — más rápida que tiempo real y única vía de MP4 real cuando
        // MediaRecorder no lo graba (app de escritorio).
        if (fmt === 'mp4' && SETTINGS.gpu && CAP.webcodecs && CAP.mp4Fast && !entry.info.hasAudio) {
          // Nivel 1: transcodificación (demux propio + VideoDecoder), más rápida que tiempo real
          if (entry.info.type === 'webm' || entry.info.type === 'mkv') {
            try {
              const fast = await videoToMP4Fast(entry, (t, p) => setProgress(entry, t, p));
              setProgress(entry, 'Validando MP4 generado…', 95);
              if (await validateVideoBlob(fast, 'mp4')) {
                r = { blob: fast, ext: 'mp4', fellBack: false };
                entry.fallbackNote = 'transcodificado con WebCodecs (H.264 acelerado, más rápido que tiempo real)';
              }
            } catch (e) { console.warn('Transcodificación WebCodecs falló; pruebo captura rVFC:', (e && (e.name + ': ' + e.message)) || e); }
          }
          // Nivel 2: captura rVFC en tiempo real → MP4 real igualmente
          if (!r) {
            try {
              const cap = await videoToMP4Capture(entry, (t, p) => setProgress(entry, t, p));
              setProgress(entry, 'Validando MP4 generado…', 95);
              if (await validateVideoBlob(cap, 'mp4')) {
                r = { blob: cap, ext: 'mp4', fellBack: false };
                entry.fallbackNote = 'MP4 codificado con WebCodecs H.264 (captura en tiempo real)';
              }
            } catch (e) { console.warn('Captura rVFC falló; fallback clásico:', (e && (e.name + ': ' + e.message)) || e); }
          }
        }
        if (!r) {
          setProgress(entry, `Re-codificando video (~${(entry.info.durationMs/1000).toFixed(1)}s, tiempo real)…`, 4);
          r = await videoToVideo(entry, fmt === 'mp4', (t, p) => setProgress(entry, t, p));
        }
        blob = r.blob; ext = r.ext;
        if (r.fellBack) entry.fallbackNote = (entry.info.hasAudio && CAP.mp4Fast)
          ? 'Se generó WebM para CONSERVAR el audio (aquí el MP4 solo es posible sin pista de audio).'
          : 'Este navegador no graba MP4: se generó WebM.';
      } else if (fmt === 'gif') {
        const r = await videoFrames(entry, (t, p) => setProgress(entry, t, p));
        setProgress(entry, 'Cuantizando y codificando GIF (LZW)…', 52);
        blob = await encodeGifInWorker(r.frames, r.W, r.H, 0,
          (p) => setProgress(entry, `Codificando GIF ${Math.round(p * 100)}% (LZW)`, 52 + p * 45));
        if (r.note) entry.fallbackNote = 'GIF ' + r.note + ' para controlar memoria y tamaño.';
      } else if (fmt === 'webp') {
        if (!CAP.webpEnc) throw new Error('Este navegador no puede codificar WebP de salida');
        const r = await videoFrames(entry, (t, p) => setProgress(entry, t, p));
        const c2 = makeCanvas(r.W, r.H);
        const ctx2 = c2.getContext('2d');
        const enc = [];
        for (let i = 0; i < r.frames.length; i++) {
          ctx2.putImageData(new ImageData(new Uint8ClampedArray(r.frames[i].data), r.W, r.H), 0, 0);
          const fb = await canvasToBlob(c2, 'image/webp', entry.quality / 100);
          enc.push({ bytes: new Uint8Array(await fb.arrayBuffer()), delayMs: r.frames[i].delayMs });
          setProgress(entry, `Codificando frame WebP ${i + 1}/${r.frames.length}`, 55 + (i + 1) / r.frames.length * 42);
        }
        blob = new Blob([buildAnimatedWebP(enc, r.W, r.H, 0)], { type: 'image/webp' });
        if (r.note) entry.fallbackNote = 'WebP animado ' + r.note + '.';
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
      const needAllFrames = (fmt === 'gif' || fmt === 'mp4' || fmt === 'webm' || fmt === 'webp') && entry.info.animated;
      setProgress(entry, 'Leyendo archivo…', 2);
      frames = await decodeAllFrames(entry, (t, p) => setProgress(entry, t, p), !needAllFrames);
      if (needAllFrames && frames.length === 1 && entry.info.frames > 1) {
        entry.fallbackNote = 'Sin ImageDecoder: solo se usó el primer frame.';
      }
      const W = frames[0].bmp.width, H = frames[0].bmp.height;

      if (fmt === 'png' || fmt === 'jpg' || (fmt === 'webp' && frames.length === 1)) {
        if (fmt === 'webp' && !CAP.webpEnc) throw new Error('Este navegador no puede codificar WebP de salida');
        setProgress(entry, `Codificando ${fmt.toUpperCase()}…`, 60);
        const c = makeCanvas(W, H);
        const ctx = c.getContext('2d');
        if (fmt === 'jpg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H); } // JPG no tiene alpha
        ctx.drawImage(frames[0].bmp, 0, 0);
        const outMime = fmt === 'png' ? 'image/png' : fmt === 'jpg' ? 'image/jpeg' : 'image/webp';
        blob = await canvasToBlob(c, outMime, entry.quality / 100);
      } else if (fmt === 'webp') {
        if (!CAP.webpEnc) throw new Error('Este navegador no puede codificar WebP de salida');
        blob = await framesToAnimatedWebP(frames, W, H, entry.info.loopCount || 0, entry.quality / 100,
          (t, p) => setProgress(entry, t, p));
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
        let r = null;
        // ⚡ Vía rápida: WebCodecs (encoder por hardware si existe) + muxer propio
        // (WebM con Cues o MP4 progresivo — ambos con seek correcto).
        // El resultado se VALIDA decodificándolo; si algo falla → MediaRecorder clásico.
        if (SETTINGS.gpu && CAP.webcodecs && typeof VideoFrame !== 'undefined') {
          try {
            const fast = fmt === 'webm'
              ? await framesToWebMFast(frames, W, H, (t, p) => setProgress(entry, t, p))
              : await framesToMP4Fast(frames, W, H, (t, p) => setProgress(entry, t, p));
            setProgress(entry, `Validando ${fmt.toUpperCase()} generado…`, 95);
            if (await validateVideoBlob(fast, fmt)) {
              r = { blob: fast, ext: fmt, fellBack: false };
              entry.fallbackNote = 'codificado con WebCodecs (acelerado, más rápido que tiempo real)';
            }
          } catch (e) { console.warn('Vía WebCodecs falló; fallback a MediaRecorder:', e); }
        }
        if (!r) {
          const secs = entry.info.animated ? (frames.reduce((a, f) => a + Math.max(f.delayMs, 33), 0) / 1000).toFixed(1) : 3;
          setProgress(entry, `Grabando video en tiempo real (~${secs}s)…`, 40);
          r = await framesToVideo(frames, W, H, fmt === 'mp4', (t, p) => setProgress(entry, t, p));
        }
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
  $('#pane-orig-title').textContent = 'ORIGINAL (' + (entry.name.split('.').pop() || '?').toUpperCase() + ')';
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
    case 'static': return e.kind !== 'video' && e.info && e.info.valid && !e.info.animated;
    case 'anim': return e.kind !== 'video' && e.info && e.info.valid && e.info.animated && e.info.durationMs <= 10000;
    case 'video': return (e.kind === 'video' && e.info && e.info.valid) || (e.kind !== 'video' && e.info && e.info.valid && e.info.animated && e.info.durationMs > 10000);
    case 'done': return e.status === 'done';
    case 'error': return e.status === 'error' || e.status === 'invalid';
  }
}
// ---------- Filtros avanzados (facetas combinables) ----------
// AND entre grupos, OR dentro de "Formato". Se combinan con los chips
// principales y la búsqueda. Con "✓ Visibles" permiten selecciones del tipo
// "todos los WebM de menos de 10 s sin audio".
const FACETS = { fmt: new Set(), dur: 'all', audio: 'all', estado: 'all' };
function entryMatchesFacets(e, except) {
  const i = e.info || {};
  // 'webp' agrupa los subtipos reales (lossy/lossless/extended)
  const fmtDe = (x) => x.kind === 'webp' ? ['webp', (x.info || {}).type] : [(x.info || {}).type];
  if (except !== 'fmt' && FACETS.fmt.size && !fmtDe(e).some(t => FACETS.fmt.has(t))) return false;
  if (except !== 'dur' && FACETS.dur !== 'all') {
    const d = i.durationMs || 0;
    if (FACETS.dur === 'short' && !(d > 0 && d <= 10000)) return false;
    if (FACETS.dur === 'long' && d <= 10000) return false;
    if (FACETS.dur === 'static' && d > 0) return false;
  }
  if (except !== 'audio' && FACETS.audio !== 'all') {
    if (FACETS.audio === 'con' && !i.hasAudio) return false;
    if (FACETS.audio === 'sin' && i.hasAudio) return false;
  }
  if (except !== 'estado' && FACETS.estado !== 'all') {
    const st = e.status === 'invalid' ? 'error' : e.status;
    if (FACETS.estado !== st) return false;
  }
  return true;
}
function facetsActive() { return FACETS.fmt.size > 0 || FACETS.dur !== 'all' || FACETS.audio !== 'all' || FACETS.estado !== 'all'; }
function applyFilter() {
  let visible = 0;
  const base = (e) => entryMatchesFilter(e, activeFilter) && (!searchTerm || e.name.toLowerCase().includes(searchTerm));
  for (const e of FILES.values()) {
    const show = base(e) && entryMatchesFacets(e);
    e.els.card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  $('#empty-filter').style.display = (FILES.size && !visible) ? 'block' : 'none';
  for (const chip of $$('.filter-chip')) {
    const n = [...FILES.values()].filter(e => entryMatchesFilter(e, chip.dataset.f)).length;
    $('.n', chip).textContent = n ? `(${n})` : '';
  }
  // Contadores de facetas: cada chip cuenta lo que quedaría al activarlo
  // (respetando el resto de filtros, patrón facetado estándar)
  for (const chip of $$('.facet-chip')) {
    const { facet, val } = chip.dataset;
    const matchesThis = (e) => {
      const i = e.info || {};
      if (facet === 'fmt') return val === 'webp' ? e.kind === 'webp' : i.type === val;
      if (facet === 'dur') {
        const d = i.durationMs || 0;
        return val === 'short' ? (d > 0 && d <= 10000) : val === 'long' ? d > 10000 : d === 0;
      }
      if (facet === 'audio') return val === 'con' ? !!i.hasAudio : !i.hasAudio;
      if (facet === 'estado') return (e.status === 'invalid' ? 'error' : e.status) === val;
      return false;
    };
    const n = [...FILES.values()].filter(e => base(e) && entryMatchesFacets(e, facet) && matchesThis(e)).length;
    const el = $('.n', chip);
    if (el) el.textContent = n ? `(${n})` : '';
  }
  const clearBtn = $('#facet-clear');
  if (clearBtn) clearBtn.style.display = (facetsActive() || searchTerm) ? '' : 'none';
}
$('#facets') && $('#facets').addEventListener('click', (e) => {
  const chip = e.target.closest('.facet-chip');
  if (!chip) return;
  const { facet, val } = chip.dataset;
  if (facet === 'fmt') {
    if (FACETS.fmt.has(val)) { FACETS.fmt.delete(val); chip.classList.remove('active'); }
    else { FACETS.fmt.add(val); chip.classList.add('active'); }
  } else {
    const yaActivo = FACETS[facet] === val;
    FACETS[facet] = yaActivo ? 'all' : val;
    $$(`.facet-chip[data-facet="${facet}"]`).forEach(c => c.classList.toggle('active', !yaActivo && c.dataset.val === val));
  }
  applyFilter();
});
$('#facet-clear') && $('#facet-clear').addEventListener('click', () => {
  FACETS.fmt.clear(); FACETS.dur = 'all'; FACETS.audio = 'all'; FACETS.estado = 'all';
  $$('.facet-chip').forEach(c => c.classList.remove('active'));
  searchTerm = '';
  $('#search').value = '';
  applyFilter();
  toast('✕ Filtros avanzados y búsqueda limpiados');
});
$$('.filter-chip').forEach(c => c.addEventListener('click', () => {
  $$('.filter-chip').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  activeFilter = c.dataset.f;
  applyFilter();
}));
$('#search').addEventListener('input', (e) => { searchTerm = e.target.value.toLowerCase().trim(); applyFilter(); });

function refreshCounters() {
  const all = [...FILES.values()];
  document.body.classList.toggle('has-files', all.length > 0); // compacta la dropzone
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
  const all = [...FILES.values()];
  const allSel = all.every(e => e.selected) && all.length > 0;
  all.forEach(e => { e.selected = !allSel; if (e.els.sel) e.els.sel.checked = !allSel; e.els.card.classList.toggle('selected', !allSel); });
  refreshCounters();
});
// Selecciona exactamente lo visible (combina con los filtros: "solo videos", "solo errores", etc.)
$('#btn-selvis').addEventListener('click', () => {
  let n = 0;
  for (const e of FILES.values()) {
    const visible = e.els.card.style.display !== 'none';
    e.selected = visible;
    if (e.els.sel) e.els.sel.checked = visible;
    e.els.card.classList.toggle('selected', visible);
    if (visible) n++;
  }
  refreshCounters();
  toast(`✓ Seleccionados <b>${n}</b> archivo(s) visibles${(activeFilter !== 'all' || searchTerm) ? ' — filtro activo' : ''}`);
});
// Quita de la lista solo lo seleccionado
$('#btn-remove-sel').addEventListener('click', () => {
  const sel = [...FILES.values()].filter(e => e.selected);
  if (!sel.length) { toast('No hay archivos seleccionados', 'warn'); return; }
  sel.forEach(removeEntry);
  toast(`✂ Quitados <b>${sel.length}</b> archivo(s) de la lista`);
});
$('#global-format').addEventListener('change', (e) => {
  const f = e.target.value;
  if (!f) {
    // "— por archivo —": volver al formato por defecto de CADA archivo
    // (antes esta opción no hacía nada y los archivos se quedaban en el
    // último formato global elegido).
    sessionPrefs.format = '';
    let n = 0;
    for (const en of FILES.values()) {
      if (en.status === 'invalid' || !en.selected) continue;
      en.format = defaultFormatFor(en);
      if (en.els.fmt) en.els.fmt.value = en.format;
      if (en.els.qwrap) en.els.qwrap.style.display = ['jpg','webp'].includes(en.format) ? '' : 'none';
      n++;
    }
    if (n) toast(`↩ Formato restaurado <b>por archivo</b> en ${n} seleccionado(s)`);
    return;
  }
  sessionPrefs.format = f;
  for (const en of FILES.values()) {
    if (en.status === 'invalid' || !en.selected) continue;
    en.format = f;
    if (en.els.fmt) en.els.fmt.value = f;
    if (en.els.qwrap) en.els.qwrap.style.display = ['jpg','webp'].includes(f) ? '' : 'none';
  }
  if (f === 'mp4' && !CAP.mp4 && !CAP.mp4Fast && CAP.webm) toast('Este navegador no graba MP4 — se generará <b>WebM</b> como fallback', 'warn');
});
$('#btn-convert').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  const sel = [...FILES.values()].filter(e => e.selected && e.status !== 'invalid');
  if (!sel.length) { toast('No hay archivos seleccionados', 'warn'); return; }
  enqueue(sel);
});
$('#btn-zip').addEventListener('click', downloadZip);
$('#opt-gpu').addEventListener('change', (e) => {
  SETTINGS.gpu = e.target.checked;
  toast(SETTINGS.gpu ? '⚡ Aceleración por hardware <b>activada</b> (WebCodecs/GPU)' : 'Aceleración desactivada: se usará el método clásico (tiempo real)');
});
$('#opt-fidelity').addEventListener('change', (e) => {
  SETTINGS.fidelity = e.target.checked;
  toast(SETTINGS.fidelity ? '🎯 Fidelidad máxima: resolución original, sin reescalado' : 'Modo seguro: reescalado a 960px y máx 30s (protege la RAM)');
});
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
    else {
      const types = [...(e.dataTransfer.types || [])].join(', ') || 'ninguno';
      toast(`El origen del arrastre no entregó archivos (tipos: ${escapeHtml(types)}).<br>💡 Si arrastras desde <b>dentro de un ZIP abierto</b> en el Explorador de Windows, eso no funciona: suelta el archivo .zip completo (yo lo extraigo) o extráelo primero.`, 'warn', 10000);
    }
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
window.WEBPFORGE = { version: '1.5.0', SETTINGS, FILES, CAP, addFiles, parseWebP, detectContainer };
