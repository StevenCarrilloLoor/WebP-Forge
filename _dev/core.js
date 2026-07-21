'use strict';
/* ============================================================
   WEBP FORGE — CORE (funciones puras, testeables en Node)
   Detección binaria WebP, encoder GIF (median-cut + LZW),
   encoder BMP 24-bit y generador ZIP (modo store + CRC32).
   ============================================================ */

// ---------- Lectura de headers WebP (contenedor RIFF) ----------
function readFourCC(view, off) {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

/**
 * Analiza los bytes del archivo y detecta el tipo real de WebP.
 * VP8  -> lossy estático | VP8L -> lossless estático | VP8X -> extendido (posible animación).
 * Para VP8X se recorren los chunks RIFF para contar frames ANMF y sumar duración.
 */
function parseWebP(buffer, fullSize) {
  const view = new DataView(buffer);
  const total = fullSize || buffer.byteLength; // permite analizar solo el header con el tamaño real conocido
  if (buffer.byteLength < 30) return { valid: false, reason: 'Archivo demasiado pequeño para ser un WebP válido' };
  if (readFourCC(view, 0) !== 'RIFF') return { valid: false, reason: 'Firma RIFF ausente — no es un contenedor RIFF' };
  if (readFourCC(view, 8) !== 'WEBP') return { valid: false, reason: 'Firma WEBP ausente — es RIFF pero no WebP' };
  const riffSize = view.getUint32(4, true);
  // RIFF declara tamaño - 8; toleramos truncado leve pero lo reportamos
  const truncated = (riffSize + 8) > total + 1;

  const chunk = readFourCC(view, 12);
  const info = {
    valid: true, truncated, chunk, type: '?', animated: false, frames: 1,
    width: 0, height: 0, hasAlpha: false, hasICC: false, hasEXIF: false, hasXMP: false,
    loopCount: 0, durationMs: 0
  };

  if (chunk === 'VP8 ') {
    info.type = 'lossy';
    // Payload en 20: frame tag 3B + start code 9D 01 2A + width/height uint16 LE (14 bits útiles)
    if (view.getUint8(23) === 0x9D && view.getUint8(24) === 0x01 && view.getUint8(25) === 0x2A) {
      info.width = view.getUint16(26, true) & 0x3FFF;
      info.height = view.getUint16(28, true) & 0x3FFF;
    }
  } else if (chunk === 'VP8L') {
    if (view.getUint8(20) !== 0x2F) return { valid: false, reason: 'Chunk VP8L sin firma 0x2F — archivo corrupto' };
    info.type = 'lossless';
    // Bitstream LE: 14 bits width-1, 14 bits height-1, 1 bit alpha
    const b = view.getUint32(21, true);
    info.width = (b & 0x3FFF) + 1;
    info.height = ((b >>> 14) & 0x3FFF) + 1;
    info.hasAlpha = ((b >>> 28) & 1) === 1;
  } else if (chunk === 'VP8X') {
    info.type = 'extended';
    const flags = view.getUint8(20);
    info.animated = (flags & 0x02) !== 0;
    info.hasXMP  = (flags & 0x04) !== 0;
    info.hasEXIF = (flags & 0x08) !== 0;
    info.hasAlpha = (flags & 0x10) !== 0;
    info.hasICC  = (flags & 0x20) !== 0;
    // Canvas size: 24 bits LE cada uno, valor-1
    info.width  = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
    info.height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
    // Recorrer chunks: contar ANMF (frames) y leer ANIM (loop count)
    let off = 12, frames = 0, dur = 0;
    while (off + 8 <= buffer.byteLength) {
      const fcc = readFourCC(view, off);
      const size = view.getUint32(off + 4, true);
      if (fcc === 'VP8 ') info.subtype = 'lossy';
      else if (fcc === 'VP8L') info.subtype = 'lossless';
      if (fcc === 'ANMF' && off + 8 + 16 <= buffer.byteLength) {
        frames++;
        // Duración del frame: 24 bits LE en payload offset 12
        dur += view.getUint8(off + 8 + 12) | (view.getUint8(off + 8 + 13) << 8) | (view.getUint8(off + 8 + 14) << 16);
      } else if (fcc === 'ANIM' && off + 8 + 6 <= buffer.byteLength) {
        info.loopCount = view.getUint16(off + 8 + 4, true);
      }
      off += 8 + size + (size & 1); // chunks RIFF alineados a 2 bytes
    }
    if (info.animated) { info.frames = Math.max(frames, 1); info.durationMs = dur; }
  } else {
    return { valid: false, reason: `Chunk desconocido "${chunk}" — WebP corrupto o variante no soportada` };
  }
  if (info.width <= 0 || info.height <= 0) return { valid: false, reason: 'Dimensiones inválidas en el header' };
  return info;
}

// ---------- Detección de contenedor (WebP / WebM / MP4) ----------
/**
 * Identifica el contenedor real leyendo los magic bytes:
 * RIFF+WEBP -> webp | EBML 1A45DFA3 + DocType -> webm/mkv | box "ftyp" -> mp4
 */
function detectContainer(buffer) {
  if (buffer.byteLength < 12) return 'unknown';
  const view = new DataView(buffer);
  if (readFourCC(view, 0) === 'RIFF' && readFourCC(view, 8) === 'WEBP') return 'webp';
  if (view.getUint32(0) === 0x1A45DFA3) {
    // Buscar el elemento DocType (ID 0x4282) en la cabecera EBML
    const lim = Math.min(buffer.byteLength, 4096);
    const b = new Uint8Array(buffer, 0, lim);
    for (let i = 0; i < lim - 3; i++) {
      if (b[i] === 0x42 && b[i + 1] === 0x82) {
        const len = b[i + 2] & 0x7F; // longitud EBML de 1 byte (suficiente para "webm"/"matroska")
        const doc = String.fromCharCode(...b.slice(i + 3, i + 3 + len));
        if (doc === 'webm') return 'webm';
        if (doc === 'matroska') return 'mkv';
        break;
      }
    }
    return 'mkv';
  }
  if (readFourCC(view, 4) === 'ftyp') return 'mp4';
  const b = new Uint8Array(buffer, 0, 8);
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (readFourCC(view, 0) === 'GIF8') return 'gif';
  if (b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
  return 'unknown';
}

// ---------- Parsers de imágenes "normales" (GIF / PNG / JPEG / BMP) ----------
function parsePNG(buffer) {
  const v = new DataView(buffer);
  return { width: v.getUint32(16, false), height: v.getUint32(20, false) };
}
function parseBMP(buffer) {
  const v = new DataView(buffer);
  return { width: v.getInt32(18, true), height: Math.abs(v.getInt32(22, true)) };
}
// Recorre segmentos JPEG hasta el SOF para extraer dimensiones (EXIF puede ir antes)
function parseJPEG(buffer) {
  const b = new Uint8Array(buffer);
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xFF) { pos++; continue; }
    let marker = b[pos + 1];
    if (marker === 0xFF) { pos++; continue; }
    if (marker >= 0xD0 && marker <= 0xD9) { pos += 2; continue; } // RST/SOI/EOI: sin longitud
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: (b[pos + 5] << 8) | b[pos + 6], width: (b[pos + 7] << 8) | b[pos + 8] };
    }
    pos += 2 + ((b[pos + 2] << 8) | b[pos + 3]);
  }
  return null;
}
// Recorre la estructura de bloques GIF: frames, duración total y loop count (NETSCAPE)
function parseGIF(buffer) {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  const out = { width: v.getUint16(6, true), height: v.getUint16(8, true), frames: 0, durationMs: 0, loopCount: 0, animated: false };
  let pos = 13;
  if (b[10] & 0x80) pos += 3 * (1 << ((b[10] & 7) + 1)); // saltar GCT
  let lastDelay = 0;
  const skipSub = () => { let l; while (pos < b.length && (l = b[pos++]) !== 0) pos += l; };
  while (pos < b.length) {
    const t = b[pos++];
    if (t === 0x3B) break;
    if (t === 0x21) { // extensión: el cuerpo SIEMPRE es una secuencia de sub-bloques
      const label = b[pos++];
      if (label === 0xF9 && b[pos] === 4) lastDelay = v.getUint16(pos + 2, true) * 10;
      if (label === 0xFF && b[pos] === 11 && String.fromCharCode(...b.slice(pos + 1, pos + 9)) === 'NETSCAPE') {
        const p = pos + 12;
        if (b[p] === 3) out.loopCount = v.getUint16(p + 2, true);
      }
      skipSub();
    } else if (t === 0x2C) { // image descriptor
      out.frames++;
      out.durationMs += lastDelay || 100; // delay 0 → ~100ms (convención de navegadores)
      lastDelay = 0;
      pos += 8;
      const p2 = b[pos]; pos++;
      if (p2 & 0x80) pos += 3 * (1 << ((p2 & 7) + 1)); // saltar LCT
      pos++; // min code size LZW
      skipSub();
    } else break; // byte inesperado: dejar de recorrer (header ya leído)
  }
  out.animated = out.frames > 1;
  return out;
}

// ---------- Muxer de WebP ANIMADO (VP8X + ANIM + ANMF, JS puro) ----------
// Extrae los chunks de bitstream (ALPH/VP8/VP8L) de un WebP estático
function extractWebPFrameChunks(buffer) {
  const v = new DataView(buffer);
  if (readFourCC(v, 0) !== 'RIFF' || readFourCC(v, 8) !== 'WEBP') throw new Error('frame no es WebP');
  let off = 12;
  const parts = [];
  let hasAlpha = false;
  while (off + 8 <= buffer.byteLength) {
    const fcc = readFourCC(v, off);
    const size = v.getUint32(off + 4, true);
    const tot = 8 + size + (size & 1);
    if (fcc === 'VP8 ' || fcc === 'VP8L' || fcc === 'ALPH') {
      const p = new Uint8Array(tot); // padding a par garantizado aunque falte en el archivo
      p.set(new Uint8Array(buffer, off, Math.min(tot, buffer.byteLength - off)));
      parts.push(p);
      if (fcc === 'ALPH') hasAlpha = true;
      if (fcc === 'VP8L' && v.getUint8(off + 8) === 0x2F && (((v.getUint32(off + 9, true) >>> 28) & 1) === 1)) hasAlpha = true;
    }
    off += tot;
  }
  if (!parts.length) throw new Error('frame WebP sin bitstream VP8/VP8L');
  return { parts, hasAlpha };
}
/**
 * Construye un WebP ANIMADO muxeando frames WebP estáticos (p.ej. de canvas.toBlob).
 * frames: [{ bytes: Uint8Array|ArrayBuffer (webp estático completo), delayMs }]
 * Duración ANMF en milisegundos (así lo define la spec del contenedor WebP).
 */
function buildAnimatedWebP(frames, W, H, loopCount) {
  let anyAlpha = false;
  const u24 = (arr, v) => { arr.push(v & 255, (v >> 8) & 255, (v >> 16) & 255); };
  const anmfs = frames.map(f => {
    const buf = f.bytes instanceof Uint8Array ? f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) : f.bytes;
    const { parts, hasAlpha } = extractWebPFrameChunks(buf);
    anyAlpha = anyAlpha || hasAlpha;
    const head = [];
    u24(head, 0); u24(head, 0);            // X/2, Y/2
    u24(head, W - 1); u24(head, H - 1);    // dimensiones del frame
    u24(head, Math.max(Math.round(f.delayMs || 100), 10)); // duración ms
    head.push(0x02);                        // flags: no-blend (frames ya compuestos), no dispose
    let size = 16;
    parts.forEach(p => size += p.length);
    return { head, parts, size };
  });
  const out = [];
  const pushStr = s => { for (const c of s) out.push(c.charCodeAt(0)); };
  const push32 = v => { out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); };
  pushStr('RIFF'); push32(0); pushStr('WEBP');
  pushStr('VP8X'); push32(10);
  out.push(0x02 | (anyAlpha ? 0x10 : 0), 0, 0, 0); // flags: animation (+alpha)
  u24(out, W - 1); u24(out, H - 1);
  pushStr('ANIM'); push32(6); push32(0); // bg color
  out.push(loopCount & 255, (loopCount >> 8) & 255);
  for (const a of anmfs) {
    pushStr('ANMF'); push32(a.size);
    for (const x of a.head) out.push(x);
    for (const p of a.parts) for (let i = 0; i < p.length; i++) out.push(p[i]);
    if (a.size & 1) out.push(0);
  }
  const res = new Uint8Array(out);
  const rs = res.length - 8;
  res[4] = rs & 255; res[5] = (rs >> 8) & 255; res[6] = (rs >> 16) & 255; res[7] = (rs >>> 24) & 255;
  return res;
}

// ---------- Lector ZIP (descompresión con DecompressionStream nativo) ----------
/**
 * Lista las entradas de un ZIP leyendo el End Of Central Directory + Central Directory.
 * Devuelve [{ name, method, compStart, compSize, uncompSize }]. Sin soporte de cifrado/ZIP64.
 */
function listZipEntries(buffer) {
  const v = new DataView(buffer);
  const len = buffer.byteLength;
  // EOCD: buscar firma 0x06054b50 desde el final (comentario máx 64KB)
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP sin End Of Central Directory — archivo corrupto');
  let count = v.getUint16(eocd + 10, true);
  let off = v.getUint32(eocd + 16, true);
  // ZIP64: si los valores están saturados, leer el EOCD64 (vía su locator, 20 bytes antes)
  if (count === 0xFFFF || off === 0xFFFFFFFF) {
    const locAt = eocd - 20;
    if (locAt >= 0 && v.getUint32(locAt, true) === 0x07064b50) {
      const e64 = Number(v.getBigUint64(locAt + 8, true));
      if (e64 + 56 <= len && v.getUint32(e64, true) === 0x06064b50) {
        count = Number(v.getBigUint64(e64 + 32, true));
        off = Number(v.getBigUint64(e64 + 48, true));
      }
    }
  }
  const decoder = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > len || v.getUint32(off, true) !== 0x02014b50) break;
    const flags = v.getUint16(off + 8, true);
    const method = v.getUint16(off + 10, true);
    let compSize = v.getUint32(off + 20, true);
    let uncompSize = v.getUint32(off + 24, true);
    const nameLen = v.getUint16(off + 28, true);
    const extraLen = v.getUint16(off + 30, true);
    const commentLen = v.getUint16(off + 32, true);
    let localOff = v.getUint32(off + 42, true);
    // Campo extra ZIP64 (id 0x0001): valores reales de los campos saturados a 0xFFFFFFFF,
    // en orden fijo: uncompSize, compSize, localOffset (solo los que estén saturados)
    let ep = off + 46 + nameLen;
    const eEnd = Math.min(ep + extraLen, len);
    while (ep + 4 <= eEnd) {
      const id = v.getUint16(ep, true);
      const sz = v.getUint16(ep + 2, true);
      if (id === 0x0001) {
        let fp = ep + 4;
        if (uncompSize === 0xFFFFFFFF && fp + 8 <= eEnd) { uncompSize = Number(v.getBigUint64(fp, true)); fp += 8; }
        if (compSize === 0xFFFFFFFF && fp + 8 <= eEnd) { compSize = Number(v.getBigUint64(fp, true)); fp += 8; }
        if (localOff === 0xFFFFFFFF && fp + 8 <= eEnd) { localOff = Number(v.getBigUint64(fp, true)); fp += 8; }
      }
      ep += 4 + sz;
    }
    const name = decoder.decode(new Uint8Array(buffer, off + 46, nameLen));
    if (!(flags & 0x01) && !name.endsWith('/') && localOff + 30 <= len) { // sin cifrar, no directorio
      // El header local repite name/extra con longitudes propias
      const lNameLen = v.getUint16(localOff + 26, true);
      const lExtraLen = v.getUint16(localOff + 28, true);
      entries.push({ name, method, compStart: localOff + 30 + lNameLen + lExtraLen, compSize, uncompSize });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
/** Extrae una entrada: store directo; deflate vía DecompressionStream('deflate-raw'). */
async function extractZipEntry(buffer, entry) {
  if (entry.compStart + entry.compSize > buffer.byteLength) throw new Error('entrada fuera de rango — ZIP truncado o variante no soportada');
  const comp = new Uint8Array(buffer, entry.compStart, entry.compSize);
  if (entry.method === 0) return comp.slice();
  if (entry.method !== 8) throw new Error('Método de compresión ' + entry.method + ' no soportado (solo store/deflate)');
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream no disponible en este navegador');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([comp]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Muxer WebM (EBML) para WebCodecs VideoEncoder ----------
// Permite codificar más rápido que tiempo real: VideoEncoder (acelerado por
// hardware cuando está disponible) produce chunks VP8/VP9 y aquí se muxean.
function _vint(n) {
  let len = 1;
  while (n >= Math.pow(2, 7 * len) - 1 && len < 8) len++;
  const b = new Uint8Array(len);
  let val = n;
  for (let i = len - 1; i >= 0; i--) { b[i] = val & 0xFF; val = Math.floor(val / 256); }
  b[0] |= (0x80 >> (len - 1));
  return b;
}
function _ebml(id, payload) {
  const sz = _vint(payload.length);
  const out = new Uint8Array(id.length + sz.length + payload.length);
  out.set(id, 0); out.set(sz, id.length); out.set(payload, id.length + sz.length);
  return out;
}
function _cat(arrs) {
  let n = 0; arrs.forEach(a => n += a.length);
  const o = new Uint8Array(n); let p = 0;
  arrs.forEach(a => { o.set(a, p); p += a.length; });
  return o;
}
function _uintBE(n) {
  if (n === 0) return new Uint8Array([0]);
  const b = []; let v = n;
  while (v > 0) { b.unshift(v & 0xFF); v = Math.floor(v / 256); }
  return new Uint8Array(b);
}
function _f64(f) { const b = new ArrayBuffer(8); new DataView(b).setFloat64(0, f, false); return new Uint8Array(b); }
function _str(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
function _uintFixed(n, len) {
  const b = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xFF; v = Math.floor(v / 256); }
  return b;
}
const _WEBM_ID = {
  EBML: [0x1A,0x45,0xDF,0xA3], EBMLVersion: [0x42,0x86], EBMLReadVersion: [0x42,0xF7],
  EBMLMaxIDLength: [0x42,0xF2], EBMLMaxSizeLength: [0x42,0xF3], DocType: [0x42,0x82],
  DocTypeVersion: [0x42,0x87], DocTypeReadVersion: [0x42,0x85],
  Segment: [0x18,0x53,0x80,0x67], SeekHead: [0x11,0x4D,0x9B,0x74], Seek: [0x4D,0xBB],
  SeekID: [0x53,0xAB], SeekPosition: [0x53,0xAC],
  Info: [0x15,0x49,0xA9,0x66], TimecodeScale: [0x2A,0xD7,0xB1],
  MuxingApp: [0x4D,0x80], WritingApp: [0x57,0x41], Duration: [0x44,0x89],
  Tracks: [0x16,0x54,0xAE,0x6B], TrackEntry: [0xAE], TrackNumber: [0xD7], TrackUID: [0x73,0xC5],
  TrackType: [0x83], CodecID: [0x86], Video: [0xE0], PixelWidth: [0xB0], PixelHeight: [0xBA],
  Cluster: [0x1F,0x43,0xB6,0x75], Timecode: [0xE7], SimpleBlock: [0xA3],
  Cues: [0x1C,0x53,0xBB,0x6B], CuePoint: [0xBB], CueTime: [0xB3],
  CueTrackPositions: [0xB7], CueTrack: [0xF7], CueClusterPosition: [0xF1],
};
function _webmEbmlHeader() {
  const ID = _WEBM_ID;
  return _ebml(ID.EBML, _cat([
    _ebml(ID.EBMLVersion, _uintBE(1)), _ebml(ID.EBMLReadVersion, _uintBE(1)),
    _ebml(ID.EBMLMaxIDLength, _uintBE(4)), _ebml(ID.EBMLMaxSizeLength, _uintBE(8)),
    _ebml(ID.DocType, _str('webm')), _ebml(ID.DocTypeVersion, _uintBE(2)), _ebml(ID.DocTypeReadVersion, _uintBE(2)),
  ]));
}
/**
 * Ensambla un Segment WebM COMPLETO y buscable: SeekHead (posiciones fijas de
 * 8 bytes) + Info con Duration + Tracks + Clusters + Cues (índice de seek).
 * Sin Cues, los reproductores no pueden saltar a un punto y "reinician" el
 * video — este era el bug de seek de las versiones anteriores.
 * clusters: [{ tc: timecode absoluto en ticks, bytes: Uint8Array del elemento Cluster completo }]
 */
function _assembleWebM(opts) {
  const ID = _WEBM_ID;
  const timecodeScale = opts.timecodeScale || 1000000;
  const info = _ebml(ID.Info, _cat([
    _ebml(ID.TimecodeScale, _uintBE(timecodeScale)),
    _ebml(ID.Duration, _f64(Math.max(opts.durationTicks, 1))),
    _ebml(ID.MuxingApp, _str('webpforge')), _ebml(ID.WritingApp, _str('webpforge')),
  ]));
  const mkSeek = (idBytes, pos) => _ebml(ID.Seek, _cat([
    _ebml(ID.SeekID, new Uint8Array(idBytes)),
    _ebml(ID.SeekPosition, _uintFixed(pos, 8)), // 8 bytes fijos → tamaño de SeekHead estable
  ]));
  const seekHeadSize = _ebml(ID.SeekHead, _cat([mkSeek(ID.Info, 0), mkSeek(ID.Tracks, 0), mkSeek(ID.Cues, 0)])).length;
  const posInfo = seekHeadSize;
  const posTracks = posInfo + info.length;
  let off = posTracks + opts.tracksBytes.length;
  const cuePts = [];
  for (const c of opts.clusters) {
    // Solo se indexan clusters que EMPIEZAN con keyframe de video: apuntar un
    // CuePoint a un cluster sin keyframe rompe la decodificación tras el salto.
    if (c.cue !== false) cuePts.push({ time: Math.max(0, Math.round(c.tc)), pos: off });
    off += c.bytes.length;
  }
  if (!cuePts.length && opts.clusters.length) cuePts.push({ time: Math.max(0, Math.round(opts.clusters[0].tc)), pos: posTracks + opts.tracksBytes.length });
  const posCues = off;
  const cues = _ebml(ID.Cues, _cat(cuePts.map(p => _ebml(ID.CuePoint, _cat([
    _ebml(ID.CueTime, _uintBE(p.time)),
    _ebml(ID.CueTrackPositions, _cat([
      _ebml(ID.CueTrack, _uintBE(opts.videoTrackNum || 1)),
      _ebml(ID.CueClusterPosition, _uintFixed(p.pos, 8)),
    ])),
  ])))));
  const seekHead = _ebml(ID.SeekHead, _cat([mkSeek(ID.Info, posInfo), mkSeek(ID.Tracks, posTracks), mkSeek(ID.Cues, posCues)]));
  if (seekHead.length !== seekHeadSize) throw new Error('SeekHead de tamaño inesperado');
  const segment = _ebml(ID.Segment, _cat([seekHead, info, opts.tracksBytes, ...opts.clusters.map(c => c.bytes), cues]));
  return _cat([_webmEbmlHeader(), segment]);
}
/**
 * Construye un WebM válido y BUSCABLE. codecId: 'V_VP8'|'V_VP9'.
 * blocks: [{ data: Uint8Array, key: bool, timestampMs }] ordenados.
 */
function buildWebM(codecId, W, H, blocks, durationMs) {
  const ID = _WEBM_ID;
  const tracks = _ebml(ID.Tracks, _ebml(ID.TrackEntry, _cat([
    _ebml(ID.TrackNumber, _uintBE(1)), _ebml(ID.TrackUID, _uintBE(1)), _ebml(ID.TrackType, _uintBE(1)),
    _ebml(ID.CodecID, _str(codecId)),
    _ebml(ID.Video, _cat([_ebml(ID.PixelWidth, _uintBE(W)), _ebml(ID.PixelHeight, _uintBE(H))])),
  ])));
  // Clusters: nuevo en cada keyframe o cada ~5s (timecode relativo es int16)
  const clusters = [];
  let cur = null, curTc = 0, curKey = false;
  const flush = () => { if (cur) clusters.push({ tc: curTc, cue: curKey, bytes: _ebml(ID.Cluster, _cat(cur)) }); };
  for (const b of blocks) {
    const ts = Math.round(b.timestampMs);
    if (!cur || (b.key && ts - curTc > 0) || ts - curTc > 5000) {
      flush();
      curTc = ts;
      curKey = !!b.key; // el primer bloque decide si el cluster puede llevar CuePoint
      cur = [_ebml(ID.Timecode, _uintBE(ts))];
    }
    const rel = ts - curTc;
    const sb = new Uint8Array(4 + b.data.length);
    sb[0] = 0x81; // track 1 (vint)
    sb[1] = (rel >> 8) & 0xFF; sb[2] = rel & 0xFF; // int16 BE
    sb[3] = b.key ? 0x80 : 0x00;
    sb.set(b.data, 4);
    cur.push(_ebml(ID.SimpleBlock, sb));
  }
  flush();
  // TimecodeScale 1.000.000 ns → ticks = milisegundos
  return _assembleWebM({ tracksBytes: tracks, clusters, videoTrackNum: 1, durationTicks: Math.max(durationMs, 1), timecodeScale: 1000000 });
}

// ---------- Lector EBML + remuxer WebM (arregla salidas de MediaRecorder) ----------
// MediaRecorder emite WebM "de streaming": Segment y Clusters de tamaño
// DESCONOCIDO, sin Duration y sin Cues → duración ∞ y seek roto (el video se
// reinicia al saltar). Este remuxer copia Tracks y el contenido de los
// Clusters INTACTOS (sin re-codificar) y reescribe el contenedor con
// Duration + SeekHead + Cues.
function _ebmlReadId(b, pos) {
  const first = b[pos];
  if (first === undefined) throw new Error('EBML truncado leyendo ID');
  let len = 1, mask = 0x80;
  while (len <= 4 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 4) throw new Error('ID EBML inválido');
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}
function _ebmlReadSize(b, pos) {
  const first = b[pos];
  if (first === undefined) throw new Error('EBML truncado leyendo tamaño');
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8) throw new Error('Tamaño EBML inválido');
  let val = first & (mask - 1);
  let ones = val === mask - 1;
  for (let i = 1; i < len; i++) { val = val * 256 + b[pos + i]; if (b[pos + i] !== 0xFF) ones = false; }
  return { size: ones ? null : val, len }; // null = tamaño desconocido
}
function _ebmlUint(b, start, end) { let v = 0; for (let i = start; i < end; i++) v = v * 256 + b[i]; return v; }
const _EBML_LEVEL1 = new Set([0x1F43B675, 0x1549A966, 0x1654AE6B, 0x114D9B74, 0x1C53BB6B, 0x1254C367, 0x1043A770, 0x1941A469, 0x18538067, 0x1A45DFA3]);
// Tiempos de los bloques de un cluster + si su PRIMER bloque de video es
// keyframe (condición para poder apuntarle un CuePoint).
function _scanClusterTimes(payload, videoTrack) {
  let p = 0, tc = 0, tcSeen = false;
  let firstVideoKey = null; // null = aún sin bloque de video visto
  const times = [];
  const readBlock = (q, isSimple, groupEnd) => {
    const tv = _ebmlReadSize(payload, q); // el nº de pista se codifica como vint
    const track = tv.size;
    const hi = payload[q + tv.len], lo = payload[q + tv.len + 1];
    times.push(tc + (((hi << 8) | lo) << 16 >> 16)); // rel int16 con signo
    if (firstVideoKey === null && (!videoTrack || track === videoTrack)) {
      if (isSimple) firstVideoKey = (payload[q + tv.len + 2] & 0x80) !== 0;
      else {
        // Block dentro de BlockGroup: es keyframe si el grupo NO tiene ReferenceBlock (0xFB)
        let r = groupEnd.start, hasRef = false;
        while (r < groupEnd.end) {
          let rid, rsz;
          try { rid = _ebmlReadId(payload, r); rsz = _ebmlReadSize(payload, r + rid.len); } catch { break; }
          if (rid.id === 0xFB) { hasRef = true; break; }
          r = r + rid.len + rsz.len + (rsz.size || 0);
        }
        firstVideoKey = !hasRef;
      }
    }
  };
  while (p < payload.length) {
    let cid, csz;
    try { cid = _ebmlReadId(payload, p); csz = _ebmlReadSize(payload, p + cid.len); } catch { break; }
    const dataStart = p + cid.len + csz.len;
    const clen = csz.size == null ? payload.length - dataStart : csz.size;
    if (cid.id === 0xE7) { tc = _ebmlUint(payload, dataStart, dataStart + clen); tcSeen = true; }
    else if (cid.id === 0xA3) readBlock(dataStart, true);
    else if (cid.id === 0xA0) { // BlockGroup → buscar Block (0xA1)
      let q = dataStart;
      const qEnd = dataStart + clen;
      while (q < qEnd) {
        let gid, gsz;
        try { gid = _ebmlReadId(payload, q); gsz = _ebmlReadSize(payload, q + gid.len); } catch { break; }
        const gStart = q + gid.len + gsz.len;
        if (gid.id === 0xA1) readBlock(gStart, false, { start: dataStart, end: qEnd });
        q = gStart + (gsz.size == null ? qEnd - gStart : gsz.size);
      }
    }
    p = dataStart + clen;
  }
  return { tc: tcSeen ? tc : 0, times, cueOk: firstVideoKey === true };
}
/**
 * Remuxea un WebM (típicamente de MediaRecorder) a un WebM buscable.
 * No toca los bytes de video/audio: solo reescribe el contenedor.
 */
function remuxWebM(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let pos = 0;
  let e = _ebmlReadId(b, pos);
  if (e.id !== 0x1A45DFA3) throw new Error('No es un archivo EBML/WebM');
  pos += e.len;
  let s = _ebmlReadSize(b, pos);
  pos += s.len + (s.size == null ? 0 : s.size);
  e = _ebmlReadId(b, pos);
  if (e.id !== 0x18538067) throw new Error('Elemento Segment no encontrado');
  pos += e.len;
  s = _ebmlReadSize(b, pos);
  pos += s.len;
  const segEnd = s.size == null ? b.length : Math.min(b.length, pos + s.size);

  let timecodeScale = 1000000, tracksBytes = null, videoTrackNum = 0, maxTick = 0, blockGap = 33;
  const clusters = [];
  while (pos < segEnd) {
    let el, sz;
    try { el = _ebmlReadId(b, pos); sz = _ebmlReadSize(b, pos + el.len); } catch { break; }
    const dataStart = pos + el.len + sz.len;
    if (el.id === 0x1549A966 && sz.size != null) { // Info → TimecodeScale (la Duration se regenera)
      let p = dataStart;
      const end = dataStart + sz.size;
      while (p < end) {
        const ci = _ebmlReadId(b, p); const cs = _ebmlReadSize(b, p + ci.len);
        const ds = p + ci.len + cs.len;
        if (ci.id === 0x2AD7B1 && cs.size) timecodeScale = _ebmlUint(b, ds, ds + cs.size);
        p = ds + (cs.size || 0);
      }
      pos = end;
    } else if (el.id === 0x1654AE6B && sz.size != null) { // Tracks → copiar íntegro + hallar pista de video
      tracksBytes = b.slice(pos, dataStart + sz.size);
      let p = dataStart;
      const end = dataStart + sz.size;
      while (p < end) {
        const ti = _ebmlReadId(b, p); const tsz = _ebmlReadSize(b, p + ti.len);
        const ds = p + ti.len + tsz.len;
        if (ti.id === 0xAE && tsz.size) {
          let q = ds, num = 0, type = 0;
          const qEnd = ds + tsz.size;
          while (q < qEnd) {
            const fi = _ebmlReadId(b, q); const fs = _ebmlReadSize(b, q + fi.len);
            const fds = q + fi.len + fs.len;
            if (fi.id === 0xD7 && fs.size) num = _ebmlUint(b, fds, fds + fs.size);
            if (fi.id === 0x83 && fs.size) type = _ebmlUint(b, fds, fds + fs.size);
            q = fds + (fs.size || 0);
          }
          if (type === 1 && !videoTrackNum) videoTrackNum = num;
        }
        p = ds + (tsz.size || 0);
      }
      pos = end;
    } else if (el.id === 0x1F43B675) { // Cluster (tamaño conocido O desconocido)
      let payloadEnd;
      if (sz.size != null) payloadEnd = Math.min(segEnd, dataStart + sz.size);
      else {
        // Tamaño desconocido (streaming): avanzar hijo a hijo hasta el próximo elemento de nivel 1
        let p = dataStart;
        while (p < segEnd) {
          let ci;
          try { ci = _ebmlReadId(b, p); } catch { break; }
          if (_EBML_LEVEL1.has(ci.id)) break;
          const cs = _ebmlReadSize(b, p + ci.len);
          if (cs.size == null) break;
          p += ci.len + cs.len + cs.size;
        }
        payloadEnd = p;
      }
      const payload = b.subarray(dataStart, payloadEnd);
      const scan = _scanClusterTimes(payload, videoTrackNum || 0);
      if (scan.times.length) {
        const sorted = [...scan.times].sort((x, y) => x - y);
        maxTick = Math.max(maxTick, sorted[sorted.length - 1]);
        if (sorted.length > 1) blockGap = Math.max(1, sorted[sorted.length - 1] - sorted[sorted.length - 2]);
      } else maxTick = Math.max(maxTick, scan.tc);
      clusters.push({ tc: scan.tc, cue: scan.cueOk, bytes: _ebml(_WEBM_ID.Cluster, payload) }); // re-emitido CON tamaño definido
      pos = payloadEnd;
    } else {
      // SeekHead/Cues/Tags/Void viejos: se descartan (se regeneran correctos)
      if (sz.size == null) break;
      pos = dataStart + sz.size;
    }
  }
  if (!tracksBytes) throw new Error('WebM sin elemento Tracks');
  if (!clusters.length) throw new Error('WebM sin clusters');
  return _assembleWebM({
    tracksBytes, clusters, videoTrackNum: videoTrackNum || 1,
    durationTicks: maxTick + blockGap, timecodeScale,
  });
}

// ---------- Muxer MP4 progresivo (ISO BMFF, JS puro) ----------
// Escribe ftyp + moov (índice completo: stts/stss/stsc/stsz/stco) + mdat.
// El moov va ANTES del mdat (faststart) y con tablas de samples correctas el
// reproductor puede saltar a cualquier punto. Se usa para:
//   1) codificación directa con WebCodecs H.264 (frames → MP4 rápido), y
//   2) remuxear el MP4 FRAGMENTADO de MediaRecorder (moof/mdat, sin índice
//      global → seek roto) a MP4 progresivo, copiando los samples tal cual.
function _ru32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
function _ru64(b, p) { return _ru32(b, p) * 4294967296 + _ru32(b, p + 4); }
function _u16(n) { return new Uint8Array([(n >> 8) & 255, n & 255]); }
function _u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function _str4(s) { return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]); }
function _mbox(type, ...parts) {
  const payload = _cat(parts.map(p => p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(8 + payload.length);
  out.set(_u32(out.length), 0);
  out.set(_str4(type), 4);
  out.set(payload, 8);
  return out;
}
function _mfull(type, version, flags, ...parts) {
  return _mbox(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}
// Recorre boxes MP4 en [start,end). Soporta size de 64 bits y size 0 (hasta el final).
function* _mp4Boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = _ru32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let hdr = 8;
    if (size === 1) { size = _ru64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    yield { type, start: p, dataStart: p + hdr, end: p + size };
    p += size;
  }
}
/** Sample entry avc1 (VisualSampleEntry + avcC) para la vía WebCodecs H.264. */
function avc1SampleEntry(W, H, avcC) {
  return _mbox('avc1',
    new Uint8Array(6), _u16(1),          // reserved + data_reference_index
    new Uint8Array(16),                   // pre_defined/reserved
    _u16(W), _u16(H),
    _u32(0x00480000), _u32(0x00480000),   // 72 dpi
    _u32(0), _u16(1),                     // reserved + frame_count
    new Uint8Array(32),                   // compressorname (vacío)
    _u16(0x0018), _u16(0xFFFF),           // depth + pre_defined(-1)
    _mbox('avcC', avcC instanceof Uint8Array ? avcC : new Uint8Array(avcC)));
}
/**
 * Construye un MP4 progresivo. tracks:
 * [{ kind:'video'|'audio', timescale, W, H,
 *    sampleEntry?: Uint8Array (box avc1/mp4a…) | stsdBox?: Uint8Array (box stsd completo copiado),
 *    samples: [{ data: Uint8Array, dur: ticks, key: bool, cts?: ticks }] }]
 */
function buildMP4(tracks) {
  const MOVIE_TS = 1000;
  const ftyp = _mbox('ftyp', _str4('isom'), _u32(0x200), _str4('isom'), _str4('iso2'), _str4('avc1'), _str4('mp41'));
  const built = tracks.map(t => {
    const totalTs = t.samples.reduce((a, s) => a + s.dur, 0);
    const durMs = Math.max(1, Math.round(totalTs * 1000 / t.timescale));
    const stts = [];
    for (const s of t.samples) {
      const last = stts[stts.length - 1];
      if (last && last[1] === s.dur) last[0]++;
      else stts.push([1, s.dur]);
    }
    const keys = [];
    t.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const allKey = keys.length === t.samples.length || keys.length === 0;
    const ctts = [];
    if (t.samples.some(s => s.cts)) {
      for (const s of t.samples) {
        const v = s.cts | 0;
        const last = ctts[ctts.length - 1];
        if (last && last[1] === v) last[0]++;
        else ctts.push([1, v]);
      }
    }
    return { t, totalTs, durMs, stts, keys, allKey, ctts };
  });
  const movieDurMs = Math.max(1, ...built.map(x => x.durMs));
  const buildMoov = (chunkOffsets) => {
    const traks = built.map((x, i) => {
      const t = x.t;
      const isV = t.kind === 'video';
      const stsdBytes = t.stsdBox ? t.stsdBox : _mfull('stsd', 0, 0, _u32(1), t.sampleEntry);
      const stbl = _mbox('stbl',
        stsdBytes,
        _mfull('stts', 0, 0, _u32(x.stts.length), _cat(x.stts.map(([c, d]) => _cat([_u32(c), _u32(d)])))),
        ...(x.allKey ? [] : [_mfull('stss', 0, 0, _u32(x.keys.length), _cat(x.keys.map(k => _u32(k))))]),
        ...(x.ctts.length ? [_mfull('ctts', 1, 0, _u32(x.ctts.length), _cat(x.ctts.map(([c, o]) => _cat([_u32(c), _u32(o >>> 0)]))))] : []),
        _mfull('stsc', 0, 0, _u32(1), _u32(1), _u32(t.samples.length), _u32(1)),
        _mfull('stsz', 0, 0, _u32(0), _u32(t.samples.length), _cat(t.samples.map(s => _u32(s.data.length)))),
        _mfull('stco', 0, 0, _u32(1), _u32(chunkOffsets[i] || 0)));
      const dinf = _mbox('dinf', _mfull('dref', 0, 0, _u32(1), _mfull('url ', 0, 1)));
      const mhd = isV ? _mfull('vmhd', 0, 1, _u16(0), _u16(0), _u16(0), _u16(0)) : _mfull('smhd', 0, 0, _u16(0), _u16(0));
      const hdlr = _mfull('hdlr', 0, 0, _u32(0), _str4(isV ? 'vide' : 'soun'), _u32(0), _u32(0), _u32(0), _str(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
      const mdhd = _mfull('mdhd', 0, 0, _u32(0), _u32(0), _u32(t.timescale), _u32(x.totalTs), _u16(0x55C4), _u16(0));
      const mdia = _mbox('mdia', mdhd, hdlr, _mbox('minf', mhd, dinf, stbl));
      const tkhd = _mfull('tkhd', 0, 3,
        _u32(0), _u32(0), _u32(i + 1), _u32(0), _u32(x.durMs),
        _u32(0), _u32(0), _u16(0), _u16(0), _u16(isV ? 0 : 0x0100), _u16(0),
        _u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x40000000),
        _u32(Math.round((t.W || 0) * 65536)), _u32(Math.round((t.H || 0) * 65536)));
      return _mbox('trak', tkhd, mdia);
    });
    const mvhd = _mfull('mvhd', 0, 0,
      _u32(0), _u32(0), _u32(MOVIE_TS), _u32(movieDurMs),
      _u32(0x10000), _u16(0x0100), _u16(0), _u32(0), _u32(0),
      _u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x10000), _u32(0), _u32(0), _u32(0), _u32(0x40000000),
      new Uint8Array(24), _u32(tracks.length + 1));
    return _mbox('moov', mvhd, ...traks);
  };
  const probe = buildMoov(tracks.map(() => 0));
  let off = ftyp.length + probe.length + 8; // + cabecera del mdat
  const chunkOffsets = built.map(x => { const o = off; off += x.t.samples.reduce((a, s) => a + s.data.length, 0); return o; });
  const moov = buildMoov(chunkOffsets);
  if (moov.length !== probe.length) throw new Error('moov de tamaño inestable');
  const mdat = _mbox('mdat', ...tracks.map(t => _cat(t.samples.map(s => s.data))));
  return _cat([ftyp, moov, mdat]);
}
/**
 * Remuxea un MP4 FRAGMENTADO (moof/mdat, típico de MediaRecorder) a MP4
 * progresivo buscable. Copia los samples byte a byte (sin re-codificar) y
 * conserva TODAS las pistas (video y audio). Devuelve null si el archivo ya
 * es progresivo (no hay nada que arreglar).
 */
function remuxMP4(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const top = [..._mp4Boxes(b, 0, b.length)];
  const moov = top.find(x => x.type === 'moov');
  if (!moov) throw new Error('MP4 sin moov');
  if (!top.some(x => x.type === 'moof')) return null; // ya es progresivo
  const traks = [];
  const trexByTrack = new Map();
  for (const box of _mp4Boxes(b, moov.dataStart, moov.end)) {
    if (box.type === 'trak') {
      const t = { trackId: 0, timescale: 1000, kind: 'video', stsd: null, W: 0, H: 0 };
      for (const c of _mp4Boxes(b, box.dataStart, box.end)) {
        if (c.type === 'tkhd') {
          const v = b[c.dataStart];
          t.trackId = _ru32(b, c.dataStart + (v === 1 ? 20 : 12));
          const wOff = c.end - 8;
          t.W = _ru32(b, wOff) / 65536;
          t.H = _ru32(b, wOff + 4) / 65536;
        } else if (c.type === 'mdia') {
          for (const m of _mp4Boxes(b, c.dataStart, c.end)) {
            if (m.type === 'mdhd') { const v = b[m.dataStart]; t.timescale = _ru32(b, m.dataStart + (v === 1 ? 20 : 12)); }
            else if (m.type === 'hdlr') {
              const h = String.fromCharCode(b[m.dataStart + 8], b[m.dataStart + 9], b[m.dataStart + 10], b[m.dataStart + 11]);
              t.kind = h === 'soun' ? 'audio' : 'video';
            } else if (m.type === 'minf') {
              for (const mi of _mp4Boxes(b, m.dataStart, m.end)) if (mi.type === 'stbl')
                for (const st of _mp4Boxes(b, mi.dataStart, mi.end)) if (st.type === 'stsd') t.stsd = b.slice(st.start, st.end);
            }
          }
        }
      }
      traks.push(t);
    } else if (box.type === 'mvex') {
      for (const c of _mp4Boxes(b, box.dataStart, box.end)) if (c.type === 'trex') {
        trexByTrack.set(_ru32(b, c.dataStart + 4), {
          dur: _ru32(b, c.dataStart + 12), size: _ru32(b, c.dataStart + 16), flags: _ru32(b, c.dataStart + 20),
        });
      }
    }
  }
  const samplesByTrack = new Map(traks.map(t => [t.trackId, []]));
  for (const moof of top) {
    if (moof.type !== 'moof') continue;
    for (const traf of _mp4Boxes(b, moof.dataStart, moof.end)) {
      if (traf.type !== 'traf') continue;
      let tid = 0, baseOff = moof.start, defDur = 0, defSize = 0, defFlags = 0;
      const truns = [];
      for (const c of _mp4Boxes(b, traf.dataStart, traf.end)) {
        if (c.type === 'tfhd') {
          const flags = _ru32(b, c.dataStart) & 0xFFFFFF;
          tid = _ru32(b, c.dataStart + 4);
          const trex = trexByTrack.get(tid) || { dur: 0, size: 0, flags: 0 };
          defDur = trex.dur; defSize = trex.size; defFlags = trex.flags;
          let p = c.dataStart + 8;
          if (flags & 0x01) { baseOff = _ru64(b, p); p += 8; }
          if (flags & 0x02) p += 4;
          if (flags & 0x08) { defDur = _ru32(b, p); p += 4; }
          if (flags & 0x10) { defSize = _ru32(b, p); p += 4; }
          if (flags & 0x20) { defFlags = _ru32(b, p); p += 4; }
          // sin base-data-offset y sin default-base-is-moof: el inicio del moof es la base de facto
        } else if (c.type === 'trun') truns.push(c);
      }
      const arr = samplesByTrack.get(tid);
      if (!arr) continue;
      for (const c of truns) {
        const ver = b[c.dataStart];
        const fl = _ru32(b, c.dataStart) & 0xFFFFFF;
        const n = _ru32(b, c.dataStart + 4);
        let p = c.dataStart + 8;
        let off = baseOff;
        if (fl & 0x01) { off = baseOff + (_ru32(b, p) | 0); p += 4; }
        let firstFlags = null;
        if (fl & 0x04) { firstFlags = _ru32(b, p); p += 4; }
        for (let i = 0; i < n; i++) {
          let dur = defDur, size = defSize, flags = defFlags, cts = 0;
          if (fl & 0x100) { dur = _ru32(b, p); p += 4; }
          if (fl & 0x200) { size = _ru32(b, p); p += 4; }
          if (fl & 0x400) { flags = _ru32(b, p); p += 4; }
          if (fl & 0x800) { cts = ver === 0 ? _ru32(b, p) : (_ru32(b, p) | 0); p += 4; }
          if (i === 0 && firstFlags != null) flags = firstFlags;
          arr.push({ off, size, dur, cts, key: !(flags & 0x10000) });
          off += size;
        }
      }
    }
  }
  const outTracks = [];
  for (const t of traks) {
    const ss = samplesByTrack.get(t.trackId) || [];
    if (!ss.length || !t.stsd) continue;
    outTracks.push({
      kind: t.kind, timescale: t.timescale, W: Math.round(t.W), H: Math.round(t.H), stsdBox: t.stsd,
      samples: ss.map(s => ({ data: b.subarray(s.off, s.off + s.size), dur: Math.max(1, s.dur || 1), key: s.key, cts: s.cts })),
    });
  }
  if (!outTracks.length) throw new Error('MP4 fragmentado sin muestras');
  return buildMP4(outTracks);
}

// ---------- Cuantización de color (median cut) ----------
/**
 * Reduce RGBA a una paleta de hasta maxColors usando median-cut.
 * Devuelve { palette: Uint8Array(n*3), indices: Uint8Array(npix), transparentIndex }
 * Si hay píxeles con alpha<128 se reserva un índice transparente.
 */
function quantize(rgba, maxColors) {
  const npix = rgba.length >>> 2;
  let hasTransparent = false;
  for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] < 128) { hasTransparent = true; break; } }
  const palMax = hasTransparent ? maxColors - 1 : maxColors;

  // Muestreo (máx ~32768 px) para construir la paleta
  const step = Math.max(1, Math.floor(npix / 32768));
  const samples = [];
  for (let i = 0; i < npix; i += step) {
    const o = i << 2;
    if (rgba[o + 3] >= 128) samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  }
  if (samples.length === 0) samples.push([0, 0, 0]);

  // Median cut
  let boxes = [samples];
  while (boxes.length < palMax) {
    // elegir caja con mayor rango de canal
    let bi = -1, bRange = -1, bChan = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let mn = 255, mx = 0;
        for (let s = 0; s < box.length; s++) { const v = box[s][c]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const r = mx - mn;
        if (r > bRange) { bRange = r; bi = b; bChan = c; }
      }
    }
    if (bi < 0 || bRange === 0) break;
    const box = boxes[bi];
    box.sort((a, b) => a[bChan] - b[bChan]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  const n = boxes.length;
  const palette = new Uint8Array((hasTransparent ? n + 1 : n) * 3);
  for (let b = 0; b < n; b++) {
    const box = boxes[b];
    let r = 0, g = 0, bl = 0;
    for (let s = 0; s < box.length; s++) { r += box[s][0]; g += box[s][1]; bl += box[s][2]; }
    palette[b * 3] = Math.round(r / box.length);
    palette[b * 3 + 1] = Math.round(g / box.length);
    palette[b * 3 + 2] = Math.round(bl / box.length);
  }
  const transparentIndex = hasTransparent ? n : -1; // entrada extra (negro) al final

  // Mapear todos los píxeles con caché por color reducido a 15 bits
  const cache = new Map();
  const indices = new Uint8Array(npix);
  for (let i = 0; i < npix; i++) {
    const o = i << 2;
    if (hasTransparent && rgba[o + 3] < 128) { indices[i] = transparentIndex; continue; }
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < n; p++) {
        const dr = rgba[o] - palette[p * 3], dg = rgba[o + 1] - palette[p * 3 + 1], db = rgba[o + 2] - palette[p * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; }
      }
      idx = best; cache.set(key, idx);
    }
    indices[i] = idx;
  }
  return { palette, paletteCount: hasTransparent ? n + 1 : n, indices, transparentIndex };
}

// ---------- LZW (GIF) ----------
function lzwEncode(indices, minCodeSize, out) {
  const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1, next = EOI + 1;
  let dict = new Map();
  let cur = 0, curBits = 0;
  const bytes = [];
  const emit = (code) => {
    cur |= code << curBits; curBits += codeSize;
    while (curBits >= 8) { bytes.push(cur & 0xFF); cur >>>= 8; curBits -= 8; }
  };
  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    dict.set(key, next++);
    if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    if (next >= 4096) { emit(CLEAR); dict = new Map(); next = EOI + 1; codeSize = minCodeSize + 1; }
    prefix = k;
  }
  emit(prefix); emit(EOI);
  if (curBits > 0) bytes.push(cur & 0xFF);
  // Sub-bloques de máx 255 bytes
  for (let i = 0; i < bytes.length; i += 255) {
    const len = Math.min(255, bytes.length - i);
    out.push(len);
    for (let j = 0; j < len; j++) out.push(bytes[i + j]);
  }
  out.push(0); // terminador de bloques
}

/**
 * Construye un GIF89a completo (animado o estático) con paleta local por frame.
 * frames: [{ data: Uint8ClampedArray|Uint8Array (RGBA), delayMs }]
 * onProgress(iFrame, total) opcional.
 */
function buildGifBuffer(frames, width, height, loopCount, onProgress) {
  const out = [];
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const push16 = (v) => { out.push(v & 0xFF, (v >> 8) & 0xFF); };

  pushStr('GIF89a');
  push16(width); push16(height);
  out.push(0x70, 0, 0); // sin GCT (paletas locales), color res 8 bits

  if (frames.length > 1) {
    // NETSCAPE 2.0 loop extension (0 = infinito)
    pushStr('\x21\xFF\x0BNETSCAPE2.0\x03\x01');
    push16(loopCount === undefined ? 0 : loopCount);
    out.push(0);
  }

  for (let f = 0; f < frames.length; f++) {
    const { palette, paletteCount, indices, transparentIndex } = quantize(frames[f].data, 256);
    // Tamaño de tabla: potencia de 2 >= paletteCount, mínimo 4 (GIF exige >=2 bits reales con minCodeSize>=2)
    let bits = 2;
    while ((1 << bits) < paletteCount) bits++;
    const tableSize = 1 << bits;

    // Graphic Control Extension
    const delay = Math.max(2, Math.round((frames[f].delayMs || 100) / 10)); // centisegundos, mín 20ms
    const hasT = transparentIndex >= 0;
    out.push(0x21, 0xF9, 4);
    out.push((1 << 2) /* disposal=1: no disponer; frames ya vienen compuestos */ | (hasT ? 1 : 0));
    push16(frames.length > 1 ? delay : 0);
    out.push(hasT ? transparentIndex : 0, 0);

    // Image Descriptor + Local Color Table
    out.push(0x2C); push16(0); push16(0); push16(width); push16(height);
    out.push(0x80 | (bits - 1)); // LCT flag + tamaño
    for (let i = 0; i < tableSize * 3; i++) out.push(i < palette.length ? palette[i] : 0);

    const minCodeSize = Math.max(2, bits);
    out.push(minCodeSize);
    lzwEncode(indices, minCodeSize, out);
    if (onProgress) onProgress(f + 1, frames.length);
  }
  out.push(0x3B);
  return new Uint8Array(out);
}

// ---------- BMP 24-bit ----------
function encodeBMP(rgba, width, height) {
  // Compone alpha sobre blanco (BMP 24bpp no tiene canal alpha)
  const rowSize = (3 * width + 3) & ~3;
  const dataSize = rowSize * height;
  const buf = new ArrayBuffer(54 + dataSize);
  const v = new DataView(buf);
  v.setUint8(0, 0x42); v.setUint8(1, 0x4D);          // "BM"
  v.setUint32(2, 54 + dataSize, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);                          // BITMAPINFOHEADER
  v.setInt32(18, width, true); v.setInt32(22, height, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true);
  v.setUint32(34, dataSize, true);
  v.setUint32(38, 2835, true); v.setUint32(42, 2835, true); // 72 DPI
  const px = new Uint8Array(buf, 54);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;          // BMP es bottom-up
    let o = y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = (srcRow + x) << 2;
      const a = rgba[s + 3] / 255, ia = 1 - a;
      px[o++] = Math.round(rgba[s + 2] * a + 255 * ia); // B
      px[o++] = Math.round(rgba[s + 1] * a + 255 * ia); // G
      px[o++] = Math.round(rgba[s] * a + 255 * ia);     // R
    }
  }
  return new Uint8Array(buf);
}

// ---------- ZIP (modo store — sin compresión; las imágenes ya están comprimidas) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Genera un ZIP válido en modo store. entries: [{ name, data: Uint8Array }]
 * Store (no deflate) es la decisión correcta: JPG/PNG/GIF/MP4 ya están comprimidos
 * y recomprimirlos solo gasta CPU sin reducir tamaño.
 */
function buildZip(entries, onProgress) {
  const encoder = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  entries.forEach((e, idx) => {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    const lh = new ArrayBuffer(30);
    const v = new DataView(lh);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true);      // UTF-8 flag
    v.setUint16(8, 0, true);           // store
    v.setUint16(10, dosTime, true); v.setUint16(12, dosDate, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, e.data.length, true); v.setUint32(22, e.data.length, true);
    v.setUint16(26, nameBytes.length, true); v.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh), nameBytes, e.data);

    const ch = new ArrayBuffer(46);
    const c = new DataView(ch);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true); c.setUint32(24, e.data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(ch), nameBytes);

    offset += 30 + nameBytes.length + e.data.length;
    if (onProgress) onProgress(idx + 1, entries.length);
  });

  let centralSize = 0;
  central.forEach(p => centralSize += p.length);
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { result.set(p, pos); pos += p.length; }
  for (const p of central) { result.set(p, pos); pos += p.length; }
  result.set(new Uint8Array(eocd), pos);
  return result;
}

// Export para Node (tests); en navegador quedan como globals del script
if (typeof module !== 'undefined') {
  module.exports = { readFourCC, parseWebP, detectContainer, parseGIF, parsePNG, parseJPEG, parseBMP, buildAnimatedWebP, extractWebPFrameChunks, listZipEntries, extractZipEntry, buildWebM, remuxWebM, buildMP4, remuxMP4, avc1SampleEntry, quantize, lzwEncode, buildGifBuffer, encodeBMP, buildZip, crc32 };
}
