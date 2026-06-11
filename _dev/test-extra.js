'use strict';
/* Tests de módulos v1.2: contenedores, parsers, muxer WebP animado, ZIP, muxer WebM.
   Validación externa: Pillow (webp animado) y ffmpeg (webm) — ver test-extra.sh */
const fs = require('fs');
const { detectContainer, parseGIF, parsePNG, parseJPEG, parseBMP, buildAnimatedWebP, listZipEntries, extractZipEntry, buildWebM } = require('./core.js');
const load = f => { const b = fs.readFileSync('test-assets/' + f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x || ''); } };
(async () => {
  check('cont jpg', detectContainer(load('photo.jpg')) === 'jpg');
  check('cont png', detectContainer(load('shape.png')) === 'png');
  check('cont gif', detectContainer(load('anim.gif')) === 'gif');
  check('cont bmp', detectContainer(load('flat.bmp')) === 'bmp');
  check('cont zip', detectContainer(load('bundle.zip')) === 'zip');
  const g = parseGIF(load('anim.gif'));
  check('gif meta', g.frames === 8 && g.animated && g.width === 120 && g.durationMs === 960 && g.loopCount === 0);
  check('gif estático', parseGIF(load('still.gif')).frames === 1);
  check('png dims', parsePNG(load('shape.png')).width === 220);
  check('jpg dims', parseJPEG(load('photo.jpg')).width === 300);
  check('bmp dims', parseBMP(load('flat.bmp')).width === 96);
  const mux = buildAnimatedWebP([0,1,2].map(i => ({ bytes: new Uint8Array(load(`mux${i}.webp`)), delayMs: 150 })), 80, 60, 0);
  fs.writeFileSync('out-anim.webp', mux);
  check('webp anim firma', String.fromCharCode(mux[12], mux[13], mux[14], mux[15]) === 'VP8X');
  const zbuf = load('bundle.zip');
  const entries = listZipEntries(zbuf);
  check('zip entradas', entries.length === 4);
  const data = await extractZipEntry(zbuf, entries.find(e => e.name.endsWith('lossy.webp')));
  const orig = new Uint8Array(load('lossy.webp'));
  check('zip deflate exacto', data.length === orig.length && data.every((v, i) => v === orig[i]));
  // ZIP64 (tamaños saturados a 0xFFFFFFFF + campo extra 0x0001)
  const z64 = load('bundle64.zip');
  const e64 = listZipEntries(z64);
  check('zip64 parseado', e64.length === 1 && e64[0].compSize !== 0xFFFFFFFF && e64[0].name === 'galeria/lossy.webp');
  const d64 = await extractZipEntry(z64, e64[0]);
  check('zip64 contenido exacto', d64.length === orig.length && d64.every((v, i) => v === orig[i]));

  // WebM con frames VP8 reales del IVF generado por ffmpeg
  const ivf = new Uint8Array(load('frames.ivf'));
  const iv = new DataView(ivf.buffer);
  const num = iv.getUint32(24, true), den = iv.getUint32(16, true);
  let pos = 32; const blocks = [];
  while (pos + 12 <= ivf.length) {
    const sz = iv.getUint32(pos, true);
    const ts = Number(iv.getBigUint64(pos + 4, true));
    const d = ivf.slice(pos + 12, pos + 12 + sz);
    blocks.push({ data: d, key: (d[0] & 1) === 0, timestampMs: ts * 1000 * num / den });
    pos += 12 + sz;
  }
  fs.writeFileSync('out-mux.webm', buildWebM('V_VP8', 160, 120, blocks, 2000));
  check('webm generado', fs.statSync('out-mux.webm').size > 1000);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
