'use strict';
// Ensambla webp-forge.html: head + body + core (sin exports de Node) + app + notas
const fs = require('fs');

const head = fs.readFileSync('app-head.html', 'utf8');
const body = fs.readFileSync('app-body.html', 'utf8');
let core = fs.readFileSync('core.js', 'utf8');
const main = fs.readFileSync('app-main.js', 'utf8');

// Quitar el bloque de export para Node
core = core.replace(/\/\/ Export para Node[\s\S]*$/, '').replace(/^'use strict';\n/, '');
const mainClean = main.replace(/^'use strict';\n/, '');

const notes = `
<!-- ============================================================
NOTAS DEL DESARROLLADOR — WEBP FORGE
================================================================

MEJORAS AÑADIDAS POR INICIATIVA PROPIA
- Análisis de header en 2 fases: primero solo 64 bytes (instantáneo incluso
  con cientos de archivos); el escaneo completo de chunks RIFF solo se hace
  si el VP8X tiene flag de animación (para contar frames ANMF y duración).
- Metadatos extra detectados desde el binario: canal alpha, perfiles ICC,
  EXIF y XMP (flags del chunk VP8X / bit alpha del bitstream VP8L), loop
  count del chunk ANIM y aviso de archivo truncado (RIFF size vs tamaño real).
- Detección de corrupción ANTES de convertir: firma RIFF/WEBP, firma 0x2F de
  VP8L, start code 9D 01 2A de VP8 y dimensiones válidas.
- Miniaturas perezosas con IntersectionObserver: con 500 tarjetas solo se
  decodifican las visibles (+margen de 200px), el resto muestra skeleton.
- Encoder GIF propio (median-cut 255 colores + índice transparente + LZW)
  ejecutado en un Web Worker construido desde Blob URL: la cuantización de
  un GIF grande no congela la UI. El worker se genera serializando las
  mismas funciones testeadas (una sola fuente de verdad).
- ZIP en modo "store" a propósito: JPG/PNG/GIF/MP4 ya están comprimidos;
  deflate solo quemaría CPU. CRC32 implementado con tabla precalculada y
  flag UTF-8 para nombres con ñ/espacios/acentos.
- Cola de conversión con concurrencia configurable (1/2/4/6) + panel de
  estadísticas en vivo (velocidad, ahorro de espacio, ETA).
- Nombres duplicados dentro del ZIP se desambiguan automáticamente.
- Liberación de memoria: ImageBitmaps cerrados tras cada conversión,
  ObjectURLs revocados al reconvertir/quitar/cerrar la página.
- Atajos: Ctrl+A, Enter, Space, Esc. Notifications API al terminar lotes
  (solo si la pestaña está en segundo plano). Búsqueda por nombre.

LIMITACIONES TÉCNICAS Y CÓMO SE RESOLVIERON
- MediaRecorder graba en TIEMPO REAL: un WebP animado de 10s tarda ~10s en
  convertirse a video. Se muestra la duración estimada en la barra de
  progreso. La alternativa (WebCodecs VideoEncoder + muxer MP4 manual)
  exigiría escribir un muxer ISO BMFF completo en JS puro; se priorizó
  fiabilidad. Dimensiones forzadas a pares (requisito de H.264).
- MP4: Chrome/Edge recientes soportan video/mp4 en MediaRecorder; si no,
  fallback automático a WebM con aviso claro en la tarjeta y en un toast.
- Sin ImageDecoder (Firefox/Safari viejos) los animados se convierten solo
  con su primer frame; la app lo detecta, lo avisa al cargar y lo anota en
  el resultado. La detección de tipo/frames sigue siendo exacta porque se
  hace leyendo los bytes, no con APIs de decodificación.
- GIF max 256 colores: median-cut con muestreo de 32k píxeles y caché de
  mapeo a 15 bits para que frames grandes mapeen rápido. Transparencia
  binaria (alpha<128) con índice reservado, disposal=1 porque ImageDecoder
  ya entrega frames compuestos (no hace falta reconstruir disposal WebP).
- readEntries() de la API de directorios devuelve máximo 100 entradas por
  llamada: se itera hasta vaciar (bug clásico al arrastrar carpetas).

SOPORTE POR NAVEGADOR (junio 2026)
- Chrome/Edge 94+: todo ✓ (ImageDecoder, OffscreenCanvas, MediaRecorder
  MP4 en versiones recientes, WebM, workers).
- Firefox: Canvas/WebM/workers ✓; ImageDecoder ✗ (animados = primer frame),
  MP4 ✗ (fallback WebM). La app lo indica en el header y en toasts.
- Safari 16.4+: Canvas ✓, MediaRecorder MP4 ✓ en versiones recientes,
  ImageDecoder ✗. Mismo fallback de primer frame.
- Los chips del header reflejan la detección real en tiempo de carga.

NOVEDADES v1.1 (a partir de feedback de uso real)
- Entrada de VIDEO: ahora acepta WebM y MP4 además de WebP. La detección es
  binaria (EBML 1A45DFA3 + DocType para WebM/MKV, box "ftyp" para MP4); los
  metadatos (dimensiones/duración) se leen con un <video> oculto con timeout.
- Video → MP4/WebM: re-codificación con captureStream() del propio <video> +
  MediaRecorder, conservando la pista de AUDIO cuando el códec lo permite
  (con downgrade automático a solo-video si el mime con audio falla).
- Video → GIF: captura de frames por seek a 10 fps, con límites de seguridad
  (máx 300 frames / 30s, reescalado a 640px de ancho) para no agotar memoria;
  cualquier recorte/reescalado se informa en la tarjeta.
- Video → PNG/JPG/BMP: primer frame.
- Drag & drop endurecido: dropEffect='copy' explícito, contador de
  dragenter/dragleave (el resaltado ya no parpadea), fallback a
  dataTransfer.files cuando items no está disponible, handler también
  directamente en la dropzone y errores del arrastre visibles en un toast.
- Formato por defecto corregido: lo clasificado como VIDEO (webp animado
  >10s o archivo de video) ahora propone MP4 (o WebM como fallback), ya no GIF.

NOVEDADES v1.2 — CONVERTIDOR UNIVERSAL + ACELERACIÓN
- Entradas nuevas: GIF (estático y animado), PNG, JPG, BMP y ZIP. La
  detección sigue siendo por magic bytes, nunca por extensión. Parsers
  binarios propios: bloques GIF (frames/delays/NETSCAPE loop), IHDR de PNG,
  segmentos SOF de JPEG (robusto ante EXIF), header BMP.
- Salida WebP: estática vía canvas (toBlob image/webp con calidad) y
  ANIMADA con un muxer VP8X/ANIM/ANMF en JS puro: cada frame se codifica a
  WebP estático con el encoder nativo del navegador y se extrae su bitstream
  (chunks ALPH/VP8/VP8L) para ensamblar el contenedor animado. Validado
  contra el decoder de Pillow (frames, dimensiones y duraciones exactas).
- GIF animado → WebP animado por defecto (el caso ezgif clásico, 100% local).
- ZIP de entrada: parser de Central Directory propio + descompresión con
  DecompressionStream('deflate-raw') NATIVO del navegador (C++ por debajo,
  sin librerías). Extrae solo los archivos compatibles y los añade a la lista.
- ⚡ ACELERACIÓN: WebM de salida usa WebCodecs VideoEncoder (encoder por
  HARDWARE cuando el sistema lo ofrece) + muxer EBML/Matroska escrito a
  mano — ya no está atado a tiempo real: una animación de 60s se codifica
  en segundos. El muxer fue validado decodificando su salida con ffmpeg.
  Cada resultado se auto-VALIDA decodificándolo en un <video>; si algo
  falla, fallback transparente a MediaRecorder. MP4 sigue en tiempo real
  (un muxer ISO BMFF correcto es otro proyecto; WebM cubre el caso rápido).
- Decodificación: ImageDecoder ahora también para image/gif (frame a frame
  con delays reales); imágenes estáticas por createImageBitmap (GPU).

QUÉ MEJORARÍA CON MÁS TIEMPO / BACKEND
- Muxer MP4 (ISO BMFF) + WebCodecs para codificar video más rápido que
  tiempo real y con control de bitrate exacto.
- Dithering Floyd-Steinberg opcional en el GIF (mejor degradado, más grano).
- Decodificador VP8/VP8L propio en WASM para animados en Firefox/Safari.
- streamsaver/File System Access API para ZIPs de varios GB sin mantenerlos
  en memoria (showSaveFilePicker + WritableStream).
============================================================ -->`;

const html = head + '\n' + body + `
<script>
${core}
${mainClean}
</script>
${notes}
</body>
</html>
`;
fs.writeFileSync('../webp-forge.html', html);
console.log('webp-forge.html generado:', (html.length / 1024).toFixed(1), 'KB');
