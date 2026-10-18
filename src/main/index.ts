import { TaxScopeStore } from './tax-scope'
import { recordKeys } from '../shared/tax-scope'
import { getDb } from './db'
import { app, shell, BrowserWindow, ipcMain, Notification } from 'electron'
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
import { freshSecurityContext } from './ai/fresh-security-context'
import type { SecurityTarget } from '../shared/agent'
import { invoiceDocumentHtml } from '../shared/invoice-document'
import { transactionDocumentHtml } from '../shared/transaction-document'
import { TaxProfileStore } from './tax-profile'
import { guardDisconnectedOutput } from './core/stdio'

guardDisconnectedOutput(process.stdout)
guardDisconnectedOutput(process.stderr)

let readSecurity: ((target?: SecurityTarget, query?: string) => Promise<string>) | undefined
const agent = new Agent(
  undefined,
  (target, query) => readSecurity?.(target, query) ?? 'Security checks are not initialized.'
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
  const taxProfile = new TaxProfileStore(join(app.getPath('userData'), 'tax-profile.json'))
  handle('tax-profile:get', () => taxProfile.get())
  handle('tax-profile:save', (_event, profile: unknown) => taxProfile.save(profile))
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
  // WDK wallet lifecycle (used from DevTools until the onboarding screens exist)
  const wallet = (backend as { wallet?: import('./rgb/wallet-service').WalletService }).wallet
  if (wallet) {
    app.on('will-quit', () => wallet.stop())
    handle('wallet:call', (_e, method: unknown, params: unknown) => {
      const allowed = ['state', 'create', 'restore', 'unlock', 'lock', 'address', 'createUtxos']
      if (typeof method !== 'string' || !allowed.includes(method)) throw new Error('Not allowed')
      return wallet.call(method, (params ?? {}) as Record<string, unknown>)
    })
  }

  readSecurity = (target, query) => freshSecurityContext(kasa.security, target, query)
  kasa.start()
  const taxScope = new TaxScopeStore(join(app.getPath('userData'), 'tax-scopes.json'), getDb().name)
  handle('tax-scope:get', () => taxScope.get())
  handle('tax-scope:organise', () => {
    const snapshot = kasa.snapshot()
    return { scope: taxScope.organise(snapshot), snapshot }
  })
  handle('tax-scope:change', (_event, command: unknown) => {
    const snapshot = kasa.snapshot()
    return taxScope.change(
      command,
      (command as { kind?: unknown } | null)?.kind === 'taxpayer' ? taxProfile.get() : null,
      recordKeys(snapshot),
      snapshot
    )
  })

  handle('security:review', (_e, intent: PaymentIntent) => kasa.reviewPayment(intent))
  handle('security:execute', (_e, id: unknown, token: unknown, verified: unknown) =>
    kasa.executePayment(id, token, verified)
  )
  handle('security:snapshot', () => kasa.security.snapshot())
  handle('security:acknowledge', (_e, id: unknown) => kasa.security.acknowledge(id))

  handle('kasa:status', async () => {
    const s = await backend.status()
    return {
      ...s,
      balance: toUsdt(s.balanceRaw ?? 0),
      // display balance incl. transfers on their way; other backends: same as balance
      future: toUsdt(s.futureRaw ?? s.balanceRaw ?? 0),
      btcSats: s.btcSats ?? 0
    }
  })
  handle('kasa:snapshot', () => kasa.snapshot())
  // prints an HTML document to PDF in a hidden, script-less window
  const htmlToPdf = async (html: string): Promise<Buffer> => {
    const document = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false
      }
    })
    document.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await document.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      return await document.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      })
    } finally {
      document.destroy()
    }
  }
  handle('kasa:invoicePdf', async (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid invoice ID.')
    const snapshot = kasa.snapshot()
    const invoice = snapshot.invoices.find((i) => i.id === id)
    if (!invoice) throw new Error('Invoice not found.')
    return htmlToPdf(invoiceDocumentHtml(invoice, snapshot.payments))
  })
  handle('kasa:transactionPdf', async (_e, nodeIdx: unknown) => {
    if (typeof nodeIdx !== 'number' || !Number.isSafeInteger(nodeIdx))
      throw new Error('Invalid transaction.')
    const snapshot = kasa.snapshot()
    const payment = snapshot.payments.find((p) => p.nodeIdx === nodeIdx)
    if (!payment) throw new Error('Transaction not found.')
    return htmlToPdf(transactionDocumentHtml(payment, snapshot))
  })
  handle('kasa:createInvoice', (_e, client: string, amount: number) =>
    kasa.createInvoice(client, amount)
  )
  handle('kasa:receive', (_e, fresh: unknown = false, amount: unknown = undefined) => {
    if (typeof fresh !== 'boolean') throw new Error('Invalid receive request.')
    if (amount !== undefined && typeof amount !== 'string' && typeof amount !== 'number')
      throw new Error('Invalid amount.')
    return kasa.receiveInvoice(fresh, amount)
  })
  // Opens the user's own default mail client with a pre-filled draft (mailto:) — never sends
  // anything itself. The user reviews and clicks send themselves in their own mail app.
  handle('kasa:emailInvoice', (_e, to: unknown, subject: unknown, body: unknown) => {
    if (typeof subject !== 'string' || typeof body !== 'string')
      throw new Error('Invalid email content.')
    if (to !== undefined && (typeof to !== 'string' || /[\r\n]/.test(to)))
      throw new Error('Invalid recipient address.')
    if (subject.length > 300 || body.length > 4000) throw new Error('Email content too long.')
    const url = `mailto:${encodeURIComponent(to ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    return shell.openExternal(url).then(() => true)
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
  kasa.on('payment', (p: { amount: number; client?: string; invoiceId?: string }) => {
    const body = p.client
      ? `${p.client} paid ${p.amount.toLocaleString('en-US')} USDT.`
      : `${p.amount.toLocaleString('en-US')} USDT received.`
    if (Notification.isSupported())
      new Notification({ title: 'Payment received', body, icon }).show()
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('kasa:payment', p))
  })

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
