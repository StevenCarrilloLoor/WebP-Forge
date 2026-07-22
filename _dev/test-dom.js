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
  // Stub: jsdom no decodifica video; simulamos metadatos y pista de audio
  window.probeVideo = async () => ({ width: 640, height: 360, durationMs: 5000 });
  window.hasAudioTrack = async () => false;
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];

  // Chips de API renderizados
  await new Promise(r => setTimeout(r, 30)); // gpuInit es async
  check('chips de API (incl. GPU)', $$('#api-status .chip').length === 7);
  check('chip GPU presente', $('#gpu-chip') && $('#gpu-chip').textContent.includes('🎮'));
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

  // "— por archivo —" debe REVERTIR al formato por defecto de cada archivo (bug reportado)
  gf.value = '';
  gf.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('por archivo: revierte al formato por defecto', entries.filter(e => e.status !== 'invalid').every(e => e.format === window.defaultFormatFor(e) && e.format !== 'jpg' || e.name === 'photo.jpg'));
  check('por archivo: los selects reflejan el cambio', entries.filter(e => e.status !== 'invalid' && e.els.fmt).every(e => e.els.fmt.value === e.format));

  // Regla nueva: video ≤10 s SIN audio → GIF por defecto (forzando capacidades)
  const CAPS = window.WEBPFORGE.CAP;
  const oldMp4 = CAPS.mp4;
  CAPS.mp4 = true;
  check('regla: video ≤10s sin audio → gif', window.defaultFormatFor({ kind: 'video', info: { type: 'webm', durationMs: 5600, hasAudio: false } }) === 'gif');
  check('regla: video ≤10s CON audio → mp4', window.defaultFormatFor({ kind: 'video', info: { type: 'webm', durationMs: 5600, hasAudio: true } }) === 'mp4');
  check('regla: video >10s sin audio → mp4', window.defaultFormatFor({ kind: 'video', info: { type: 'webm', durationMs: 15000, hasAudio: false } }) === 'mp4');
  CAPS.mp4 = oldMp4;
  check('metadatos muestran 🔇 sin audio', window.document.body.textContent.includes('sin audio'));

  // Quitar archivo
  const before = $$('.card').length;
  window.document.querySelector('.card .card-x').click();
  check('quitar archivo', $$('.card').length === before - 1 && window.WEBPFORGE.FILES.size === 6);

  // Flujo: filtrar VIDEO → seleccionar visibles → quitar seleccionados
  window.document.querySelector('[data-f=video]').click();
  $('#btn-selvis').click();
  const selNow = [...window.WEBPFORGE.FILES.values()].filter(e => e.selected);
  check('selvis: solo el video queda seleccionado', selNow.length === 1 && selNow[0].name === 'video.webm');
  const sizeBefore = window.WEBPFORGE.FILES.size;
  $('#btn-remove-sel').click();
  check('quitar selec.: solo se fue el video', window.WEBPFORGE.FILES.size === sizeBefore - 1 && ![...window.WEBPFORGE.FILES.values()].some(e => e.name === 'video.webm'));
  window.document.querySelector('[data-f=all]').click();

  // ===== Filtros avanzados (facetas) =====
  // Quedan 5 entradas: lossless.webp, animated.webp, fake.webp(inválido), photo.jpg, anim.gif
  const clickFacet = (facet, val) => window.document.querySelector(`.facet-chip[data-facet="${facet}"][data-val="${val}"]`).click();
  const vis = () => $$('.card').filter(c => c.style.display !== 'none').length;
  check('panel de facetas presente', !!$('#facets') && $$('.facet-chip').length >= 18);
  clickFacet('fmt', 'gif');
  check('faceta formato GIF', vis() === 1);
  clickFacet('fmt', 'gif');
  clickFacet('dur', 'short');
  check('faceta ≤10s (webp anim + gif anim)', vis() === 2);
  clickFacet('dur', 'short');
  clickFacet('estado', 'error');
  check('faceta estado error (incluye inválidos)', vis() === 1);
  clickFacet('estado', 'error');
  check('sin facetas: todo visible otra vez', vis() === 5);
  clickFacet('fmt', 'webp');
  clickFacet('dur', 'short');
  check('faceta combinada webp + ≤10s', vis() === 1);
  const chipWebp = window.document.querySelector('.facet-chip[data-facet="fmt"][data-val="webp"]');
  check('contador de faceta activo', chipWebp.querySelector('.n').textContent !== '');
  window.document.querySelector('#facet-clear').click();
  check('limpiar filtros restaura todo', vis() === 5);
  check('facetas + ✓ Visibles: flujo de selección', (() => {
    clickFacet('fmt', 'gif');
    $('#btn-selvis').click();
    const sel = [...window.WEBPFORGE.FILES.values()].filter(e => e.selected);
    const ok = sel.length === 1 && sel[0].name === 'anim.gif';
    window.document.querySelector('#facet-clear').click();
    return ok;
  })());

  // ===== Panel colapsable + filtros aplicados (rediseño Baymard/NN-g) =====
  const tgl = $('#facets-toggle');
  check('toggle de filtros existe', !!tgl && !!$('#facets-count'));
  tgl.click();
  check('toggle abre el panel', $('#facets').classList.contains('open'));
  clickFacet('fmt', 'gif');
  check('chip aplicado visible', $('#applied-filters').classList.contains('visible') && $$('#af-chips .af-chip').length === 1);
  check('contador del toggle (1)', $('#facets-count').textContent === '(1)');
  window.document.querySelector('#af-chips .af-x').click();
  check('quitar chip aplicado limpia la faceta', $$('#af-chips .af-chip').length === 0 && vis() === 5);
  tgl.click();
  check('toggle cierra el panel', !$('#facets').classList.contains('open'));

  // ===== ⚙ Configuración (métricas y formatos editables) =====
  check('CONFIG expuesta con umbral por defecto', window.WEBPFORGE.CONFIG && window.WEBPFORGE.CONFIG.umbralCortoMs === 10000);
  $('#btn-settings').click();
  check('modal de ajustes abre', $('#settings-modal').classList.contains('open'));
  $('#cfg-umbral').value = '3';
  $('#cfg-fmt-webp-estatico').value = 'jpg';
  $('#cfg-guardar').click();
  check('modal cierra al guardar', !$('#settings-modal').classList.contains('open'));
  check('umbral guardado (3 s)', window.WEBPFORGE.CONFIG.umbralCortoMs === 3000);
  const CAPS2 = window.WEBPFORGE.CAP;
  const oldMp4b = CAPS2.mp4;
  CAPS2.mp4 = true;
  check('umbral afecta la regla (5.6s ya no es corto → mp4)', window.defaultFormatFor({ kind: 'video', info: { type: 'webm', durationMs: 5600, hasAudio: false } }) === 'mp4');
  CAPS2.mp4 = oldMp4b;
  check('formato configurado aplica (webp estático → jpg)', window.defaultFormatFor({ kind: 'webp', info: { type: 'lossy', animated: false, durationMs: 0 } }) === 'jpg');
  check('etiqueta de faceta refleja el umbral', window.document.querySelector('.facet-chip[data-facet="dur"][data-val="short"]').textContent.includes('3 s'));
  check('re-aplicar recalculó los cargados', [...window.WEBPFORGE.FILES.values()].filter(e => e.status === 'ready').every(e => e.format === window.defaultFormatFor(e)));
  $('#btn-settings').click();
  $('#cfg-restaurar').click();
  $('#cfg-guardar').click();
  check('restaurar deja el umbral en 10 s', window.WEBPFORGE.CONFIG.umbralCortoMs === 10000);

  // Detección directa adicional (header parcial + fullSize)
  const buf = fs.readFileSync('test-assets/animated.webp');
  const head = buf.buffer.slice(buf.byteOffset, buf.byteOffset + 64);
  const partial = window.parseWebP(head, buf.byteLength);
  check('header parcial: animado sin truncado falso', partial.valid && partial.animated && !partial.truncated);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
