# 📦 Guía para publicar una actualización de WebP Forge

Esta guía cubre el ciclo completo: desde que haces un cambio en la app hasta que
todos los que la tienen instalada se actualizan solos.

---

## Respuesta rápida: ¿siempre debo subir esos 4 archivos?

**Sí.** En cada release se suben estos archivos (todos están en `desktop\dist\` después de construir):

| Archivo | ¿Obligatorio? | Para qué sirve |
|---|---|---|
| `WebP-Forge-Setup-X.X.X.exe` | ✅ Sí | El instalador que descarga la gente y el que usa el auto-update |
| `WebP-Forge-Setup-X.X.X.exe.blockmap` | ✅ Sí | Permite que las actualizaciones descarguen solo lo que cambió (más rápido) |
| `latest.yml` | ✅ Sí — **el más importante** | Es el archivo que las apps instaladas consultan para saber si hay versión nueva. Sin él, el auto-update NO funciona |
| `WebP-Forge-Portable-X.X.X.exe` | ⬜ Opcional | Versión sin instalación. No se auto-actualiza, pero es cómodo ofrecerla |

> ⚠️ **Regla de oro:** los 4 archivos deben ser del MISMO build. Nunca mezcles un
> `latest.yml` viejo con un Setup nuevo — el yml contiene el hash del instalador
> y la verificación fallaría.

---

## El ciclo completo, paso a paso

### ANTES de construir (preparación)

1. **Haz tus cambios** en la app (`webp-forge.html`, o las fuentes en `_dev\` y reconstruye).
2. **Prueba que todo funcione**: abre la app con `ejecutables\1 - INICIAR WEBP FORGE.bat` y verifica tus cambios.
3. **Sube la versión** en `desktop\package.json`:
   ```json
   "version": "1.4.0"   →   "version": "1.5.0"
   ```
   📌 Este paso es **imprescindible**: las apps instaladas solo se actualizan si
   ven un número MAYOR que el suyo. Si no lo subes, nadie se actualiza.

### PASO 1 — Construir los .exe

Doble clic en **`ejecutables\3 - PASO 1 CONSTRUIR EXE.bat`**

Al terminar, los archivos del release quedan en:
```
WebP Forge\desktop\dist\
├── WebP-Forge-Setup-1.5.0.exe            ← subir al release
├── WebP-Forge-Setup-1.5.0.exe.blockmap   ← subir al release
├── latest.yml                            ← subir al release (¡el clave!)
└── WebP-Forge-Portable-1.5.0.exe         ← subir al release (opcional)
```

### PASO 2 — Subir el código a GitHub

Doble clic en **`ejecutables\4 - PASO 2 SUBIR A GITHUB.bat`**
(te pedirá una descripción breve de los cambios para el commit).

> Esto guarda el código fuente en el repo, pero **NO publica la actualización**:
> las apps no miran los commits, solo los Releases. Falta el paso 3.

### PASO 3 — Publicar el Release (desde la web, lo más seguro)

1. Entra a **https://github.com/StevenCarrilloLoor/WebP-Forge/releases/new**
2. **Choose a tag** → escribe `v1.5.0` (la letra `v` + la versión EXACTA del
   package.json) → clic en **"Create new tag: v1.5.0 on publish"**
3. **Release title**: `WebP Forge v1.5.0`
4. **Describe this release**: resume las novedades de esta versión
5. **Arrastra los 4 archivos** de `desktop\dist\` a la zona
   *"Attach binaries by dropping them here or selecting them"*
   y espera a que terminen las barras de subida
6. Deja "Release label" en **None** (no marques Pre-release) y pulsa el botón
   verde **Publish release**

### ¿Y después?

Nada más. Cada app instalada, **al arrancar**, consulta el `latest.yml` del
último release, ve que `1.5.0 > 1.4.0`, descarga el Setup en segundo plano
(avisa con una notificación) y se instala sola cuando el usuario cierra la app.

---

## Atajos y notas

- **Alternativa automática al paso 3**: `ejecutables\5 - PASO 3 ALTERNATIVO...bat`
  publica el release entero con un token de GitHub (scope `repo`). Es más rápido
  pero el token queda en la sesión de consola; el método web es más seguro.
- **La Portable nunca se auto-actualiza** (limitación estándar de las apps
  portables). Quien la use debe descargar la nueva a mano.
- **Si el build falla** revisa `desktop\build.log`; si falla el push, `git.log`
  (ambos en la carpeta del proyecto).
- El tag SIEMPRE con el formato `vX.X.X` y coincidiendo con el package.json —
  si no coinciden, el auto-update no encuentra el archivo.

## Resumen en una línea

> Cambios → probar → subir versión en `desktop\package.json` → bat 3 → bat 4 → release web con los 4 archivos de `desktop\dist` → publicar. ✅
