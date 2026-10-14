import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('extract-invoice', async () => {
    // Mocking the QVAC extraction logic delay
    return new Promise(resolve => setTimeout(resolve, 2000));
  });

  ipcMain.handle('issue-rgb', async () => {
    // Mocking WDK/RGB transaction issue
    return new Promise(resolve => setTimeout(resolve, 1500));
  });

  ipcMain.handle('send-funds', async (event, amount, address) => {
    // Mocking WDK/RGB send
    return new Promise(resolve => setTimeout(resolve, 1500));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
