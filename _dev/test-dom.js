'use strict';
/* Smoke test de la UI en jsdom: carga el HTML real, simula carga de archivos
   y verifica tarjetas, badges, contadores, filtros, selección y eliminación. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/tmp/webp-forge.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// ---- Stubs de APIs de navegador que jsdom no implementa ----
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
};
window.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};

// Sin ImageDecoder/MediaRecorder/Worker/OffscreenCanvas → la app debe degradar sin crashear
delete window.ImageDecoder;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
};

(async () => {
  // Ejecutar el script embebido
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  try {
    dom.window.eval(script);
    check('script ejecuta sin errores', true);
  } catch (e) {
    check('script ejecuta sin errores', false, e.stack);
    process.exit(1);
  }
  // Stub: jsdom no decodifica video; simulamos metadatos
  window.probeVideo = async () => ({ width: 640, height: 360, durationMs: 5000 });
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];

  // Chips de API renderizados
  check('chips de API', $$('#api-status .chip').length === 6);
  check('chip WebP-out off (jsdom)', $('#api-status').textContent.includes('✗ WebP-out'));
  check('chip ImageDecoder off', $('#api-status').textContent.includes('✗ ImageDecoder'));

  // Cargar archivos reales de prueba
  const mkFile = (p) => {
    const buf = fs.readFileSync(path.join('test-assets', p));
    return new window.File([buf], p, { type: 'image/webp' });
  };
  const files = [mkFile('lossy.webp'), mkFile('lossless.webp'), mkFile('animated.webp'), mkFile('fake.webp'), mkFile('video.webm'), mkFile('photo.jpg'), mkFile('anim.gif')];
  await window.addFiles(files);

  check('7 tarjetas creadas', $$('.card').length === 7);
  check('badge lossy', $$('.badge.static').some(b => b.textContent.includes('LOSSY')));
  check('badge lossless', $$('.badge.static').some(b => b.textContent.includes('LOSSLESS')));
  check('badge animado 12 frames', $$('.badge.anim').some(b => b.textContent.includes('12 frames')));
  check('badge inválido', $$('.badge.invalid').length === 1);
  check('error descriptivo en inválido', window.document.body.textContent.includes('Firma RIFF ausente'));
  check('contador global', $('#global-counter').textContent.includes('7'));
  check('controles visibles', $('#controls').style.display === 'flex');
  check('metadatos dims', window.document.body.textContent.includes('320×200'));
  check('metadatos frames+loop', window.document.body.textContent.includes('loop ∞'));
  // Video WebM detectado y clasificado
  check('badge video webm', $$('.badge.video').some(b => b.textContent.includes('VIDEO WEBM')));
  const vEntry = [...window.WEBPFORGE.FILES.values()].find(e => e.name === 'video.webm');
  check('kind video', vEntry && vEntry.kind === 'video');
  check('default video=gif (sin MediaRecorder en jsdom)', vEntry && vEntry.format === 'gif');
  check('filtro video cuenta 1', (() => { const chip=[...window.document.querySelectorAll('.filter-chip')].find(c=>c.dataset.f==='video'); return chip.querySelector('.n').textContent==='(1)'; })());
  // Entradas universales: JPG y GIF animado
  check('badge JPEG', $$('.badge.static').some(b => b.textContent.includes('JPEG')));
  check('badge GIF ANIMADO 8 frames', $$('.badge.anim').some(b => b.textContent.includes('GIF ANIMADO') && b.textContent.includes('8 frames')));
  const jpgE = [...window.WEBPFORGE.FILES.values()].find(e => e.name === 'photo.jpg');
  check('jpg kind image + dims', jpgE && jpgE.kind === 'image' && jpgE.info.width === 300 && jpgE.info.height === 180);
  check('default jpg=png (jsdom sin encoder webp)', jpgE && jpgE.format === 'png');
  const gifE = [...window.WEBPFORGE.FILES.values()].find(e => e.name === 'anim.gif');
  check('gif kind gif + loop ∞', gifE && gifE.kind === 'gif' && gifE.info.loopCount === 0 && gifE.info.frames === 8);
  check('default gif=gif (jsdom sin webp/mp4/webm)', gifE && gifE.format === 'gif');
  check('selector incluye WebP', $$('.fmt-select option').some(o => o.value === 'webp'));

  // Formato por defecto: animado→gif, estático→png
  const entries = [...window.WEBPFORGE.FILES.values()];
  check('default animado=gif', entries.find(e => e.name === 'animated.webp').format === 'gif');
  check('default webp estático=png (máx calidad)', entries.find(e => e.name === 'lossy.webp').format === 'png');
  check('default lossless=png', entries.find(e => e.name === 'lossless.webp').format === 'png');
  check('calidad por defecto 100%', entries.every(e => e.quality === 100));
  check('slider muestra 100%', window.document.body.textContent.includes('100%'));
  check('toggle GPU existe y activo', $('#opt-gpu') && $('#opt-gpu').checked);
  check('toggle fidelidad existe y activo', $('#opt-fidelity') && $('#opt-fidelity').checked);
  $('#opt-gpu').checked = false;
  $('#opt-gpu').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('toggle GPU desactiva SETTINGS', window.WEBPFORGE.SETTINGS && window.WEBPFORGE.SETTINGS.gpu === false);

  // Filtros
  window.document.querySelector('[data-f=anim]').click();
  const visibles = $$('.card').filter(c => c.style.display !== 'none').length;
  check('filtro animados (webp+gif)', visibles === 2);
  window.document.querySelector('[data-f=error]').click();
  check('filtro error', $$('.card').filter(c => c.style.display !== 'none').length === 1);
  window.document.querySelector('[data-f=all]').click();

  // Búsqueda
  const search = $('#search');
  search.value = 'lossy';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('búsqueda filtra', $$('.card').filter(c => c.style.display !== 'none').length === 1);
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  // Selección global
  $('#btn-selall').click(); // deselecciona (todos venían seleccionados)
  check('deseleccionar todo', entries.filter(e => e.status !== 'invalid').every(e => !e.selected));
  $('#btn-selall').click();
  check('seleccionar todo', entries.filter(e => e.status !== 'invalid').every(e => e.selected));

  // Formato global
  const gf = $('#global-format');
  gf.value = 'jpg';
  gf.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('formato global aplica', entries.filter(e => e.status !== 'invalid').every(e => e.format === 'jpg'));

  // Quitar archivo
  const before = $$('.card').length;
  window.document.querySelector('.card .card-x').click();
  check('quitar archivo', $$('.card').length === before - 1 && window.WEBPFORGE.FILES.size === 6);

  // Detección directa adicional (header parcial + fullSize)
  const buf = fs.readFileSync('test-assets/animated.webp');
  const head = buf.buffer.slice(buf.byteOffset, buf.byteOffset + 64);
  const partial = window.parseWebP(head, buf.byteLength);
  check('header parcial: animado sin truncado falso', partial.valid && partial.animated && !partial.truncated);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
