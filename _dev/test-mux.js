'use strict';
/* Tests v1.5: seek correcto en video.
   - buildWebM ahora emite SeekHead + Duration + Cues (índice de seek).
   - remuxWebM repara WebM "de streaming" (MediaRecorder): Segment/Clusters de
     tamaño desconocido, sin Duration, sin Cues.
   - buildMP4/remuxMP4: MP4 progresivo con moov completo; repara el MP4
     fragmentado de MediaRecorder.
   Validación externa con ffmpeg/ffprobe si están instalados (fixtures
   generados al vuelo); si no, corren solo las comprobaciones estructurales. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildWebM, remuxWebM, buildMP4, remuxMP4, avc1SampleEntry } = require('./core.js');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x || ''); } };
const load = f => { const b = fs.readFileSync(path.join('test-assets', f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmux-'));
const tmp = f => path.join(TMP, f);

const hasFF = !spawnSync('ffmpeg', ['-version']).error && !spawnSync('ffprobe', ['-version']).error;
if (!hasFF) console.log('AVISO: ffmpeg/ffprobe no disponibles — solo checks estructurales');

const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 });
const probeJson = (f) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', f], { maxBuffer: 1 << 26 });
  try { return JSON.parse(r.stdout.toString()); } catch { return null; }
};
const canSeekDecode = (f, ss) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', f, '-frames:v', '1', '-f', 'null', '-']);
  return r.status === 0 && !r.stderr.toString().trim();
};
const findBytes = (hay, needle) => {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const CUES_ID = [0x1C, 0x53, 0xBB, 0x6B];
const SEEKHEAD_ID = [0x11, 0x4D, 0x9B, 0x74];

// ---------- Escritor EBML mínimo local (para fabricar el WebM "roto" de MediaRecorder) ----------
const vint = (n) => {
  let len = 1;
  while (n >= Math.pow(2, 7 * len) - 1 && len < 8) len++;
  const b = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xFF; v = Math.floor(v / 256); }
  b[0] |= (0x80 >> (len - 1));
  return b;
};
const cat = (a) => { let n = 0; a.forEach(x => n += x.length); const o = new Uint8Array(n); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
const el = (id, payload) => cat([new Uint8Array(id), vint(payload.length), payload]);
const elUnknown = (id, payload) => cat([new Uint8Array(id), new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), payload]); // tamaño DESCONOCIDO
const uint = (n) => { if (n === 0) return new Uint8Array([0]); const b = []; let v = n; while (v > 0) { b.unshift(v & 0xFF); v = Math.floor(v / 256); } return new Uint8Array(b); };
const str = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

// Bloques VP8 reales desde el IVF de los assets
function ivfBlocks() {
  const ivf = new Uint8Array(load('frames.ivf'));
  const iv = new DataView(ivf.buffer);
  // Cabecera IVF: rate (denominador) en el offset 16, scale (numerador) en el 20
  const den = iv.getUint32(16, true), num = iv.getUint32(20, true);
  let pos = 32; const blocks = [];
  while (pos + 12 <= ivf.length) {
    const sz = iv.getUint32(pos, true);
    const ts = Number(iv.getBigUint64(pos + 4, true));
    const d = ivf.slice(pos + 12, pos + 12 + sz);
    blocks.push({ data: d, key: (d[0] & 1) === 0, timestampMs: ts * 1000 * num / den });
    pos += 12 + sz;
  }
  return blocks;
}

(async () => {
  // ============ 1) buildWebM: ahora con SeekHead + Duration + Cues ============
  const blocks = ivfBlocks();
  const webm = buildWebM('V_VP8', 160, 120, blocks, 2000);
  fs.writeFileSync(tmp('own.webm'), webm);
  check('buildWebM: SeekHead presente', findBytes(webm, SEEKHEAD_ID) > 0);
  check('buildWebM: Cues presentes', findBytes(webm, CUES_ID) > 0);
  if (hasFF) {
    const meta = probeJson(tmp('own.webm'));
    const dur = meta && meta.format && parseFloat(meta.format.duration);
    check('buildWebM: ffprobe duración ~2s', dur > 1.8 && dur < 2.3, 'dur=' + dur);
    check('buildWebM: decodifica con seek a 1.5s', canSeekDecode(tmp('own.webm'), 1.5));
  }

  // ============ 2) remuxWebM con archivo estilo MediaRecorder (sintético) ============
  // Segment y Clusters con tamaño DESCONOCIDO, sin Duration, sin Cues.
  {
    const header = el([0x1A, 0x45, 0xDF, 0xA3], cat([
      el([0x42, 0x86], uint(1)), el([0x42, 0xF7], uint(1)), el([0x42, 0xF2], uint(4)), el([0x42, 0xF3], uint(8)),
      el([0x42, 0x82], str('webm')), el([0x42, 0x87], uint(2)), el([0x42, 0x85], uint(2)),
    ]));
    const info = el([0x15, 0x49, 0xA9, 0x66], cat([el([0x2A, 0xD7, 0xB1], uint(1000000)), el([0x4D, 0x80], str('rec')), el([0x57, 0x41], str('rec'))]));
    const tracks = el([0x16, 0x54, 0xAE, 0x6B], el([0xAE], cat([
      el([0xD7], uint(1)), el([0x73, 0xC5], uint(1)), el([0x83], uint(1)), el([0x86], str('V_VP8')),
      el([0xE0], cat([el([0xB0], uint(160)), el([0xBA], uint(120))])),
    ])));
    const clusterEls = [];
    let curItems = null, curTc = 0;
    const flushC = () => { if (curItems) clusterEls.push(elUnknown([0x1F, 0x43, 0xB6, 0x75], cat(curItems))); };
    for (const b of blocks) {
      const ts = Math.round(b.timestampMs);
      if (!curItems || (b.key && ts - curTc > 0) || ts - curTc > 5000) { flushC(); curTc = ts; curItems = [el([0xE7], uint(ts))]; }
      const sb = new Uint8Array(4 + b.data.length);
      sb[0] = 0x81; sb[1] = ((ts - curTc) >> 8) & 0xFF; sb[2] = (ts - curTc) & 0xFF; sb[3] = b.key ? 0x80 : 0x00;
      sb.set(b.data, 4);
      curItems.push(el([0xA3], sb));
    }
    flushC();
    const broken = cat([header, elUnknown([0x18, 0x53, 0x80, 0x67], cat([info, tracks, ...clusterEls]))]);
    fs.writeFileSync(tmp('broken.webm'), broken);
    check('sintético: sin Cues (como MediaRecorder)', findBytes(broken, CUES_ID) === -1);
    const fixed = remuxWebM(broken);
    fs.writeFileSync(tmp('fixed.webm'), fixed);
    check('remuxWebM: añade Cues', findBytes(fixed, CUES_ID) > 0);
    check('remuxWebM: añade SeekHead', findBytes(fixed, SEEKHEAD_ID) > 0);
    if (hasFF) {
      const meta = probeJson(tmp('fixed.webm'));
      const dur = meta && meta.format && parseFloat(meta.format.duration);
      check('remuxWebM: duración recuperada ~2s', dur > 1.8 && dur < 2.3, 'dur=' + dur);
      check('remuxWebM: seek a 1.5s decodifica', canSeekDecode(tmp('fixed.webm'), 1.5));
      const nOrig = blocks.length;
      const rr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', tmp('fixed.webm')]);
      check('remuxWebM: conserva todos los frames', parseInt(rr.stdout.toString().trim(), 10) === nOrig, rr.stdout.toString().trim() + ' vs ' + nOrig);
    }
  }

  // ============ 3) remuxWebM con salida real de ffmpeg por pipe (sin seek) + AUDIO ============
  if (hasFF) {
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 1 << 28 });
    check('fixture pipe webm generado', gen.status === 0 && gen.stdout.length > 1000, gen.stderr.toString().slice(0, 200));
    if (gen.status === 0) {
      fs.writeFileSync(tmp('pipe.webm'), gen.stdout);
      const fixed = remuxWebM(new Uint8Array(gen.stdout));
      fs.writeFileSync(tmp('pipe-fixed.webm'), fixed);
      const meta = probeJson(tmp('pipe-fixed.webm'));
      const dur = meta && meta.format && parseFloat(meta.format.duration);
      const kinds = meta ? meta.streams.map(s => s.codec_type).sort() : [];
      check('pipe: duración ~2s tras remux', dur > 1.8 && dur < 2.4, 'dur=' + dur);
      check('pipe: conserva video Y audio', kinds.join(',') === 'audio,video', kinds.join(','));
      check('pipe: Cues presentes', findBytes(fixed, CUES_ID) > 0);
      check('pipe: seek a 1.5s decodifica', canSeekDecode(tmp('pipe-fixed.webm'), 1.5));
    }
  }

  // ============ 4) remuxMP4: fragmentado (MediaRecorder) → progresivo ============
  if (hasFF) {
    const r = ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', tmp('frag.mp4')]);
    check('fixture mp4 fragmentado generado', r.status === 0, r.stderr && r.stderr.toString().slice(0, 200));
    if (r.status === 0) {
      const frag = new Uint8Array(fs.readFileSync(tmp('frag.mp4')));
      const prog = remuxMP4(frag);
      check('remuxMP4: devuelve progresivo', prog && prog.length > 1000);
      fs.writeFileSync(tmp('prog.mp4'), prog);
      const iMoov = findBytes(prog, [0x6D, 0x6F, 0x6F, 0x76]);
      const iMdat = findBytes(prog, [0x6D, 0x64, 0x61, 0x74]);
      check('remuxMP4: moov ANTES del mdat (faststart)', iMoov > 0 && iMdat > iMoov);
      const meta = probeJson(tmp('prog.mp4'));
      const dur = meta && meta.format && parseFloat(meta.format.duration);
      const kinds = meta ? meta.streams.map(s => s.codec_type).sort() : [];
      check('remuxMP4: duración ~2s', dur > 1.8 && dur < 2.4, 'dur=' + dur);
      check('remuxMP4: conserva video Y audio', kinds.join(',') === 'audio,video', kinds.join(','));
      check('remuxMP4: seek a 1.5s decodifica', canSeekDecode(tmp('prog.mp4'), 1.5));
      const cnt = (f) => parseInt(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]).stdout.toString().trim(), 10);
      check('remuxMP4: mismos frames de video', cnt(tmp('prog.mp4')) === cnt(tmp('frag.mp4')), cnt(tmp('prog.mp4')) + ' vs ' + cnt(tmp('frag.mp4')));
      // Un MP4 ya progresivo no se toca
      const r2 = ff(['-i', tmp('prog.mp4'), '-c', 'copy', '-movflags', '+faststart', tmp('prog2.mp4')]);
      if (r2.status === 0) check('remuxMP4: progresivo devuelve null', remuxMP4(new Uint8Array(fs.readFileSync(tmp('prog2.mp4')))) === null);
    }
  }

  // ============ 5) buildMP4 + avc1SampleEntry: estructura ============
  {
    const fakeAvcC = new Uint8Array([1, 0x42, 0xE0, 0x1E, 0xFF, 0xE1, 0, 2, 0x67, 0x42, 1, 0, 2, 0x68, 0xCE]);
    const entry = avc1SampleEntry(320, 240, fakeAvcC);
    check('avc1SampleEntry: tipo avc1', String.fromCharCode(entry[4], entry[5], entry[6], entry[7]) === 'avc1');
    const mp4 = buildMP4([{ kind: 'video', timescale: 90000, W: 320, H: 240, sampleEntry: entry, samples: [
      { data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]), dur: 3000, key: true },
      { data: new Uint8Array([0, 0, 0, 2, 0x41, 0x9A]), dur: 3000, key: false },
    ] }]);
    check('buildMP4: firma ftyp', String.fromCharCode(mp4[4], mp4[5], mp4[6], mp4[7]) === 'ftyp');
    check('buildMP4: contiene stss (keyframes)', findBytes(mp4, [0x73, 0x74, 0x73, 0x73]) > 0);
    check('buildMP4: contiene stco', findBytes(mp4, [0x73, 0x74, 0x63, 0x6F]) > 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
