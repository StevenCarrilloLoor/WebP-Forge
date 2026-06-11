# WebP Forge — App de escritorio (.exe)

## Construir el .exe (primera vez)
1. Doble clic en `CONSTRUIR EXE.bat` (en la carpeta padre). Hace todo solo:
   copia el HTML actual, `npm install` y `npm run dist`.
2. Resultado en `desktop/dist/`:
   - `WebP-Forge-Setup-1.4.0.exe` → instalador (con acceso directo y desinstalador)
   - `WebP-Forge-Portable-1.4.0.exe` → ejecutable suelto, sin instalación

## Auto-actualización desde GitHub
La app instalada (la del Setup) comprueba **GitHub Releases** de
`StevenCarrilloLoor/WebP-Forge` al arrancar, descarga la nueva versión en
segundo plano y la instala al cerrar. Importante: las actualizaciones salen
de los **Releases publicados**, no de cada commit.

### Publicar una nueva versión (flujo completo)
1. Haz tus cambios y reconstruye `webp-forge.html`.
2. Sube la versión en `desktop/package.json` (ej. 1.4.0 → 1.5.0).
3. Crea un token de GitHub (Settings → Developer settings → Tokens, scope `repo`).
4. En una terminal:
   ```
   cd desktop
   set GH_TOKEN=tu_token_aqui
   npm run publish
   ```
   Esto compila, crea el Release `v1.5.0` en GitHub y sube el Setup +
   `latest.yml` (el archivo que las apps instaladas consultan).
5. Todas las apps instaladas se actualizarán solas al siguiente arranque.

Nota: la versión **Portable** no se auto-actualiza (limitación estándar);
el instalador NSIS sí.
