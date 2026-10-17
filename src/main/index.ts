import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'
import type { PaymentIntent } from '../shared/security'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createRgb } from './rgb'
import { Kasa } from './core/kasa'
import { toRaw, toUsdt } from './core/units'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Agent } from './ai/agent'
import { securityContext } from './ai/security-context'
import type { SecurityTarget } from '../shared/agent'

let readSecurity: ((target?: SecurityTarget) => string) | undefined
const agent = new Agent(
  undefined,
  (target) => readSecurity?.(target) ?? 'Security checks are not initialized.'
)
// A single instance owns the local operation ledger.
if (!app.requestSingleInstanceLock()) app.exit(0)
function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const expected =
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
        : pathToFileURL(join(__dirname, '../renderer/index.html')).href
    const actual = event.senderFrame?.url.split(/[?#]/)[0].replace(/\/$/, '')
    if (
      event.senderFrame !== event.sender.mainFrame ||
      actual !== expected ||
      !BrowserWindow.fromWebContents(event.sender)
    )
      throw new Error('Untrusted IPC sender.')
    return listener(event, ...args)
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Use a writable cache even when launched from a packaged application.
  if (!process.env.QVAC_CONFIG_PATH) {
    const directory = join(app.getPath('userData'), 'qvac')
    mkdirSync(directory, { recursive: true })
    const configPath = join(directory, 'qvac.config.json')
    writeFileSync(configPath, JSON.stringify({ cacheDirectory: join(directory, 'models') }))
    process.env.QVAC_CONFIG_PATH = configPath
  }
  handle('agent:status', () => agent.status())
  handle('agent:prepare', (event) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required.')
    return agent.prepare((update) => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:event', update)
    })
  })
  handle('agent:chat', (event, message: unknown, target?: SecurityTarget) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required.')
    return agent.chat(
      message,
      (update) => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:event', update)
      },
      target
    )
  })
  handle('agent:close', () => agent.close())
  handle('agent:stop', () => agent.stop())
  handle('agent:reset', () => agent.reset())
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  const { backend, pay } = createRgb()
  const kasa = new Kasa(backend)
  readSecurity = (target) => securityContext(kasa.security.snapshot(), target)
  kasa.start()

  handle('security:review', (_e, intent: PaymentIntent) => kasa.reviewPayment(intent))
  handle('security:execute', (_e, id: unknown, token: unknown, verified: unknown) =>
    kasa.executePayment(id, token, verified)
  )
  handle('security:snapshot', () => kasa.security.snapshot())
  handle('security:acknowledge', (_e, id: unknown) => kasa.security.acknowledge(id))

  handle('kasa:status', async () => {
    const s = await backend.status()
    return { ...s, balance: toUsdt(s.balanceRaw ?? 0), btcSats: s.btcSats ?? 0 }
  })
  handle('kasa:snapshot', () => kasa.snapshot())
  handle('kasa:createInvoice', (_e, client: string, amount: number) =>
    kasa.createInvoice(client, amount)
  )
  handle('kasa:receive', (_e, fresh: unknown = false) => {
    if (typeof fresh !== 'boolean') throw new Error('Invalid receive request.')
    return kasa.receiveInvoice(fresh)
  })
  handle('kasa:send', () => kasa.send())
  handle('kasa:approve', () => kasa.approve())
  handle('kasa:dismiss', (_e, id: string) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid proposal ID.')
    return kasa.dismiss(id)
  })
  // mock mode only: simulate a client paying, from DevTools
  handle('kasa:mockPay', (_e, recipientId: string, amount: number) => {
    if (typeof recipientId !== 'string' || recipientId.length > 100)
      throw new Error('Invalid recipient.')
    return pay?.(recipientId, toRaw(amount))
  })

  kasa.on('changed', () =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('kasa:changed'))
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let agentClosed = false
app.on('before-quit', (event) => {
  if (agentClosed) return
  event.preventDefault()
  agentClosed = true
  // A stalled native worker must not prevent the application from quitting.
  const timeout = setTimeout(() => app.exit(), 5000)
  void agent
    .dispose()
    .catch(console.error)
    .finally(() => {
      clearTimeout(timeout)
      app.quit()
    })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
