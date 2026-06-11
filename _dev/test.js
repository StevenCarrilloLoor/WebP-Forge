'use strict';
const fs = require('fs');
const path = require('path');
const { parseWebP, buildGifBuffer, encodeBMP, buildZip, detectContainer } = require('./core.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function load(f) {
  const b = fs.readFileSync(path.join('test-assets', f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// --- Detección ---
const lossy = parseWebP(load('lossy.webp'));
check('lossy: tipo', lossy.valid && lossy.type === 'lossy', JSON.stringify(lossy));
check('lossy: dims', lossy.width === 320 && lossy.height === 200);

const lossless = parseWebP(load('lossless.webp'));
check('lossless: tipo', lossless.valid && lossless.type === 'lossless', JSON.stringify(lossless));
check('lossless: dims', lossless.width === 200 && lossless.height === 150);
check('lossless: alpha', lossless.hasAlpha === true);

const anim = parseWebP(load('animated.webp'));
check('animated: tipo', anim.valid && anim.type === 'extended' && anim.animated === true, JSON.stringify(anim));
check('animated: frames', anim.frames === 12, 'frames=' + anim.frames);
check('animated: dims', anim.width === 160 && anim.height === 160);
check('animated: duración', anim.durationMs === 12 * 80, 'dur=' + anim.durationMs);

const fake = parseWebP(load('fake.webp'));
check('fake: inválido', fake.valid === false, fake.reason);

// --- Detección de contenedor ---
check('container webp', detectContainer(load('lossy.webp')) === 'webp');
check('container webm', detectContainer(load('video.webm')) === 'webm');
check('container mp4', detectContainer(load('video.mp4')) === 'mp4');
check('container unknown', detectContainer(load('fake.webp')) === 'unknown');

// --- GIF encoder: 6 frames sintéticos con gradiente + transparencia ---
const W = 96, H = 64;
const gifFrames = [];
for (let f = 0; f < 6; f++) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    data[o] = (x * 3 + f * 20) % 256; data[o + 1] = (y * 4) % 256; data[o + 2] = 180;
    data[o + 3] = (x < 10 && y < 10) ? 0 : 255; // esquina transparente
  }
  gifFrames.push({ data, delayMs: 80 });
}
const gif = buildGifBuffer(gifFrames, W, H, 0);
fs.writeFileSync('out-test.gif', gif);
check('gif: firma', gif[0] === 0x47 && gif[1] === 0x49 && gif[2] === 0x46 && gif[5] === 0x61);
check('gif: terminador', gif[gif.length - 1] === 0x3B);

// GIF estático (1 frame)
const gif1 = buildGifBuffer([gifFrames[0]], W, H, 0);
fs.writeFileSync('out-test-static.gif', gif1);
check('gif estático: firma', gif1[0] === 0x47);

// --- BMP ---
const bmp = encodeBMP(gifFrames[0].data, W, H);
fs.writeFileSync('out-test.bmp', bmp);
check('bmp: firma BM', bmp[0] === 0x42 && bmp[1] === 0x4D);

// --- ZIP ---
const zip = buildZip([
  { name: 'carpeta/test.gif', data: gif },
  { name: 'imagen ñ con espacios.bmp', data: bmp },
]);
fs.writeFileSync('out-test.zip', zip);
check('zip: firma PK', zip[0] === 0x50 && zip[1] === 0x4B);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
