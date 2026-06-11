'use strict';
const { app, BrowserWindow, shell, Notification } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: '#080B14',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    title: 'WebP Forge',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'webp-forge.html'));
  // Enlaces externos al navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Auto-actualización desde GitHub Releases (StevenCarrilloLoor/WebP-Forge).
// Comprueba al arrancar; descarga en segundo plano e instala al cerrar la app.
function setupAutoUpdates() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-available', (info) => {
      new Notification({ title: 'WebP Forge', body: `Nueva versión ${info.version} disponible — descargando en segundo plano…` }).show();
    });
    autoUpdater.on('update-downloaded', (info) => {
      new Notification({ title: 'WebP Forge', body: `Versión ${info.version} lista — se instalará al cerrar la aplicación.` }).show();
    });
    autoUpdater.on('error', (e) => console.warn('AutoUpdater:', e == null ? 'error' : (e.message || e)));
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    console.warn('electron-updater no disponible (modo desarrollo):', e.message);
  }
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setupAutoUpdates(); // solo en la app instalada, no en npm start
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
