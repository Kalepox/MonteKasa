// Run after npm run build: electron scripts/wdk-startup-smoke.cjs [--mock | --bad-node]
// Uses the installed WDK service with an empty temporary data directory. Never creates or unlocks a wallet.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

const repository = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-wdk-startup-'))
const mock = process.argv.includes('--mock')
const badNode = process.argv.includes('--bad-node')
assert.ok(!(mock && badNode), 'Choose only one alternate startup mode')
app.setPath('userData', directory)
app.commandLine.appendSwitch('proxy-server', 'http=127.0.0.1:9;https=127.0.0.1:9')
app.getAppPath = () => repository
process.env.KASA_DB = path.join(directory, 'ledger.db')
process.env.QVAC_CONFIG_PATH = path.join(directory, 'qvac.config.json')
fs.writeFileSync(
  process.env.QVAC_CONFIG_PATH,
  JSON.stringify({ cacheDirectory: path.join(directory, 'models') })
)
delete process.env.RGB_BACKEND
delete process.env.RGB_MOCK
delete process.env.ELECTRON_RENDERER_URL
delete process.env.WALLET_NODE
if (mock) process.env.RGB_MOCK = '1'
if (badNode) process.env.WALLET_NODE = path.join(directory, 'missing-node')

const results = []
const registered = new Set()
const children = []
const blockedRequests = []
const rendererRequests = []
const methods = []
let localRequests = 0
let stateCalls = 0
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  registered.add(channel)
  // Keep unrelated AI discovery out of this wallet startup test.
  if (channel === 'agent:status')
    return register(channel, () => ({ ready: false, installed: false }))
  return register(channel, (...args) => {
    if (channel === 'wallet:call' && args[1] === 'state') stateCalls++
    return listener(...args)
  })
}
const spawn = childProcess.spawn
childProcess.spawn = (command, args, options) => {
  if (args.includes('server.mjs')) {
    assert.equal(options.cwd, path.join(repository, 'wallet-service'))
    assert.equal(options.env.WALLET_DATA_DIR, path.join(directory, 'wdk-wallet'))
    const child = spawn(command, args, options)
    children.push(child)
    return child
  }
  return spawn(command, args, options)
}

const fetch = global.fetch
global.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? input.toString()))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') {
    blockedRequests.push(`${url.origin}${url.pathname}`)
    throw new Error('External fetch blocked by isolated startup test')
  }
  localRequests++
  const body = JSON.parse(options.body)
  methods.push(body.method)
  assert.ok(
    ['state', 'listTransfers'].includes(body.method),
    `Unexpected wallet method: ${body.method}`
  )
  return fetch(input, options)
}
app.on('session-created', (session) => {
  session.webRequest.onBeforeRequest((details, callback) => {
    const external = /^https?:/i.test(details.url)
    if (external) rendererRequests.push(details.url)
    callback({ cancel: external })
  })
})

let finished = false
const finish = (error) => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  for (const child of children) child.kill('SIGTERM')
  if (error) console.error(error)
  console.log(
    JSON.stringify(
      {
        backend: mock ? 'mock' : 'default WDK',
        badNode,
        results,
        localRequests,
        methods,
        blockedRequests,
        rendererRequests
      },
      null,
      2
    )
  )
  fs.rmSync(directory, { recursive: true, force: true })
  app.exit(error ? 1 : 0)
}
const timeout = setTimeout(() => finish(new Error('Startup smoke timed out')), 60_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const check = (name, result) => {
      assert.ok(result, name)
      results.push(name)
    }
    const js = (source) => window.webContents.executeJavaScript(source)
    const visibleStartupError = () =>
      js(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const panel = document.getElementById('wallet-gate');
        if (panel && !panel.hidden && panel.textContent.includes('Wallet could not start') &&
            panel.querySelector('#wg-retry') && /WALLET_NODE|Node 22/.test(panel.querySelector('[role="alert"]')?.textContent ?? '')) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    })()`)
    try {
      check('Wallet IPC handler registered before renderer loaded', registered.has('wallet:call'))
      if (badNode) {
        const error = await js(
          `window.kasa.wallet('state').then(() => '', error => String(error.message))`
        )
        check(
          'Invalid runtime produces an actionable IPC error without crashing Electron',
          /WALLET_NODE|Node 22/.test(error) && !/No handler registered/.test(error)
        )
        check('Startup error and retry are visible to the user', await visibleStartupError())
        const beforeRetry = stateCalls
        await js(`document.getElementById('wg-retry').click()`)
        check(
          'Retry keeps the error visible and makes another state request',
          (await visibleStartupError()) && stateCalls > beforeRetry
        )
      } else {
        const state = await js(`window.kasa.wallet('state')`)
        check(
          'Wallet state returns through real preload and main IPC',
          state.state === (mock ? 'unavailable' : 'none')
        )
        if (mock) check('Unavailable state identifies selected backend', state.backend === 'mock')
        else {
          check('Installed WDK service starts in temporary wallet directory', children.length === 1)
          const repeated = await js(`window.kasa.wallet('state')`)
          check(
            'Repeated state reuses the running wallet service',
            repeated.state === 'none' && children.length === 1
          )
        }
      }
      const forbidden = await js(
        `window.kasa.wallet('send', {}).then(() => '', error => String(error.message))`
      )
      check('Renderer cannot call wallet send directly', /Not allowed/.test(forbidden))
      if (mock) {
        const unavailable = await js(
          `window.kasa.wallet('address').then(() => '', error => String(error.message))`
        )
        check(
          'Unsupported backend returns an explicit action error',
          /unavailable|WDK/i.test(unavailable) && !/No handler registered/.test(unavailable)
        )
        check('Mock backend does not start WDK service', children.length === 0)
      }
      const ledger = await js(`window.kasa.snapshot()`)
      check(
        'Temporary ledger remains empty',
        ledger.invoices.length === 0 && ledger.payments.length === 0
      )
      check(
        'No wallet seed or model downloaded',
        !fs.existsSync(path.join(directory, 'wdk-wallet', 'seed.enc')) &&
          !fs.existsSync(path.join(directory, 'models'))
      )
      check(
        'No external backend fetch attempted; renderer network is blocked',
        blockedRequests.length === 0
      )
      finish()
    } catch (error) {
      finish(error)
    }
  })
  window.webContents.once('did-fail-load', (_event, code, description) =>
    finish(new Error(`Renderer failed to load: ${code} ${description}`))
  )
})
require(path.join(repository, 'out/main/index.js'))
