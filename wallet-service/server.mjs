// MonteKasa wallet service: one WDK RGB wallet behind a local, token-protected JSON API.
// Started by Kasa (Electron main) with WALLET_DATA_DIR and WALLET_TOKEN; prints {"ready":true,"port":N}.
//
// Network vs local: unlocking, balances, history and invoices only touch the wallet's local database
// (milliseconds). All indexer/proxy syncing happens in ONE background loop, so API calls never wait
// for a sync they didn't need. Sends and UTXO creation still go to the network, as they must.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import bip39 from 'bip39'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import rgblib from '@utexo/rgb-lib'
import { loadSeed, saveSeed } from './seed-store.mjs'
import WDK from '@tetherto/wdk'

const DATA = process.env.WALLET_DATA_DIR
const TOKEN = process.env.WALLET_TOKEN ?? ''
if (!DATA || TOKEN.length < 32) throw new Error('WALLET_DATA_DIR and a WALLET_TOKEN (32+ chars) are required')
fs.mkdirSync(DATA, { recursive: true })
const SEED_FILE = path.join(DATA, 'seed.enc')

// One service per wallet folder. Two services on the same wallet both processed an incoming
// transfer and booked it twice. A lock left behind by a dead process is taken over.
const LOCK_FILE = path.join(DATA, 'service.lock')
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
try {
  const other = Number(fs.readFileSync(LOCK_FILE, 'utf8'))
  if (other && other !== process.pid && alive(other)) {
    console.error(`Another wallet service (pid ${other}) is already using this wallet. Close the other app first.`)
    process.exit(2)
  }
} catch { /* no lock yet */ }
fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 })
const releaseLock = () => {
  try { if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE) } catch { /* gone */ }
}

const CONFIG = {
  network: 'signet', // Mutinynet, as UTEXO supports it
  indexerUrl: process.env.WALLET_INDEXER ?? 'https://esplora.signet.kaleidoswap.com',
  transportEndpoint: process.env.WALLET_PROXY ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
  dataDir: path.join(DATA, 'rgb')
}

// set by Kasa at startup; without an asset ID every send is refused
const ASSET_ID = process.env.WALLET_ASSET_ID ?? ''
const MAX_SEND_RAW = Number(process.env.WALLET_MAX_SEND_RAW ?? 500_000_000) // 500 USDT at precision 6

let wdk = null
let account = null
const approved = new Set() // sends the merchant approved: `${invoice}|${amountRaw}`

// opens the wallet from its local database only: no network, so unlocking is fast
async function openWallet(mnemonic) {
  wdk = new WDK(mnemonic)
    .registerWallet('rgb', WalletManagerRgb, CONFIG)
    // WDK denies everything by default: allow all, then restrict below
    .registerPolicy({
      id: 'baseline', name: 'Permissive baseline', scope: 'project',
      rules: [{ name: 'allow-all', operation: '*', action: 'ALLOW', conditions: [] }]
    })
    // hard limits that hold no matter what Kasa asks for
    .registerPolicy({
      id: 'wallet-limits', name: 'Hard wallet limits', scope: 'project',
      rules: [
        { name: 'only-our-usdt', operation: 'transfer', action: 'DENY',
          conditions: [({ args }) => !ASSET_ID || args[0]?.token !== ASSET_ID] },
        { name: 'max-per-send', operation: 'transfer', action: 'DENY',
          conditions: [({ args }) => !(Number(args[0]?.amount) > 0 && Number(args[0]?.amount) <= MAX_SEND_RAW)] }
      ]
    })
    // the wallet itself refuses any send Kasa didn't approve
    .registerPolicy({
      id: 'kasa-approval', name: 'Only merchant-approved sends', scope: 'project',
      rules: [{
        name: 'deny-unapproved', operation: 'transfer', action: 'DENY',
        conditions: [({ args }) => !approved.has(`${args[0]?.recipient}|${args[0]?.amount}`)]
      }]
    })
  account = await wdk.getAccount('rgb', 0)
  startSync()
}

function closeWallet() {
  stopSync()
  try { wdk?.dispose() } catch { /* wdk-wallet-rgb 2.0.3 throws 'Invalid checksum' on dispose */ }
  wdk = account = null
  approved.clear()
}

const unlocked = () => {
  if (!account) throw new Error('Wallet is locked')
  return account
}
const notFound = (e) => /AssetNotFound/.test(String(e?.message))

// ---------- background sync: the only scheduled network traffic ----------

const SYNC_EVERY_MS = 6_000 // refresh transfers: accept incoming, broadcast our sends, mark settled
const BTC_EVERY_TICKS = 4 // the BTC balance changes rarely: every ~24 s, or right after we spent BTC
const EMPTY_BTC = { vanilla: { settled: 0, future: 0, spendable: 0 }, colored: { settled: 0, future: 0, spendable: 0 } }

let view = null // { address, btc, at } from the last BTC sync; null until the first sync after unlock
let btcDirty = true
let tick = 0
let syncError = null
let syncQueued = false
let loop = null

async function syncOnce() {
  syncQueued = false
  if (!account) return
  try {
    await account.refreshWallet()
    if (btcDirty || !view || tick % BTC_EVERY_TICKS === 0) {
      const r = await account.registerWallet() // goes online the first time, syncs, returns BTC balance
      view = { address: r.address, btc: r.btcBalance, at: Date.now() }
      btcDirty = false
    }
    syncError = null
  } catch (e) {
    syncError = String(e?.message ?? e)
  } finally {
    tick++
  }
}

// While the merchant is reviewing or sending a payment, timer syncs step aside: rgb-lib's calls block
// the whole service while they run, so a sync in progress made reviews wait seconds.
const QUIET_AFTER_ACTIVITY_MS = 10_000
let lastActivity = 0

// queued like any API call, so it never runs at the same time as one; at most one waits in line
function requestSync({ fromTimer = false } = {}) {
  if (fromTimer && Date.now() - lastActivity < QUIET_AFTER_ACTIVITY_MS) return
  if (syncQueued || !account) return
  syncQueued = true
  serial(syncOnce)
}

function startSync() {
  view = null
  btcDirty = true
  tick = 0
  syncError = null
  requestSync() // first sync right after unlock, in the background
  loop = setInterval(() => requestSync({ fromTimer: true }), SYNC_EVERY_MS)
}

function stopSync() {
  if (loop) clearInterval(loop)
  loop = null
  view = null
  syncQueued = false
}

// ---------- the API ----------

const api = {
  state: () => ({ state: account ? 'unlocked' : fs.existsSync(SEED_FILE) ? 'locked' : 'none' }),

  async create({ password }) {
    if (fs.existsSync(SEED_FILE)) throw new Error('A wallet already exists')
    if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be 8+ characters')
    const mnemonic = bip39.generateMnemonic()
    saveSeed(SEED_FILE, mnemonic, password)
    await openWallet(mnemonic)
    return { mnemonic } // shown to the user once for backup; never stored in plain text
  },

  async restore({ mnemonic, password }) {
    if (fs.existsSync(SEED_FILE)) throw new Error('A wallet already exists')
    if (!bip39.validateMnemonic(String(mnemonic ?? '').trim())) throw new Error('Invalid recovery words')
    if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be 8+ characters')
    saveSeed(SEED_FILE, mnemonic.trim(), password)
    await openWallet(mnemonic.trim())
    return { ok: true }
  },

  async unlock({ password }) {
    if (!fs.existsSync(SEED_FILE)) throw new Error('No wallet yet: create or restore one first')
    if (!account) await openWallet(loadSeed(SEED_FILE, password))
    return { ok: true }
  },

  lock: () => (closeWallet(), { ok: true }),

  // local reads only; `synced: false` until the first background sync after unlock has finished
  async status({ assetId }) {
    const a = unlocked()
    let spendable = 0
    // getTokenBalance reads the local database and returns a plain number (BigInt)
    try { spendable = Number(await a.getTokenBalance(assetId)) } catch (e) { if (!notFound(e)) throw e }
    // "future": settled plus transfers already on their way (display only, never for spending).
    // A transfer that fails drops out of this sum by itself.
    let future = spendable
    try {
      const amount = (x) => Number(x?.Fungible ?? 0)
      for (const t of await a.listTransfers(assetId)) {
        if (t.status === 'Settled' || t.status === 'Failed') continue
        if (t.kind === 'ReceiveBlind' || t.kind === 'ReceiveWitness')
          future += (t.assignments ?? []).reduce((s, x) => s + amount(x), 0) // known once the data arrived
        else if (t.kind === 'Send') future -= amount(t.requestedAssignment)
      }
    } catch (e) {
      if (!notFound(e)) throw e
    }
    return {
      synced: Boolean(view),
      lastSync: view?.at ?? null,
      syncError,
      address: view?.address ?? null,
      btc: view?.btc ?? EMPTY_BTC,
      asset: { settled: spendable, spendable, future: Math.max(0, future) }
    }
  },

  async address() {
    if (view?.address) return { address: view.address }
    const r = await unlocked().registerWallet() // before the first sync: fetch it directly
    view = { address: r.address, btc: r.btcBalance, at: Date.now() }
    return { address: r.address } // fund THIS address
  },

  async createUtxos({ num = 10, size = 3000, feeRate = 2 }) {
    const a = unlocked()
    const psbt = await a.createUtxosBegin({ upTo: true, num, size, feeRate })
    const created = await a.createUtxosEnd({ signedPsbt: await a.signPsbt(psbt) })
    btcDirty = true // BTC moved from vanilla to colored
    requestSync()
    return { created }
  },

  async createInvoice({ assetId, amountRaw }) {
    const a = unlocked()
    try {
      return await a.receiveAsset({ assetId, amount: amountRaw ?? 0 })
    } catch (e) {
      if (!notFound(e)) throw e
      return await a.receiveAsset({ amount: 0 }) // first receive: any-asset invoice
    }
  },

  // local read; the background loop keeps it current
  async listTransfers({ assetId }) {
    const a = unlocked()
    try { return await a.listTransfers(assetId) } catch (e) { if (notFound(e)) return []; throw e }
  },

  async send({ invoice, assetId, amountRaw, feeRate = 2 }) {
    const a = unlocked()
    const key = `${invoice}|${amountRaw}`
    approved.add(key) // reached only after Kasa's security review + the merchant's approval
    try {
      const r = await a.transfer({ recipient: invoice, token: assetId, amount: amountRaw, minConfirmations: 1, feeRate })
      return { txid: r.hash ?? r.txid }
    } finally {
      approved.delete(key)
      btcDirty = true // the send paid a BTC fee
      requestSync() // pick up the receiver's acceptance and broadcast as soon as possible
    }
  },

  decodeInvoice({ invoice }) {
    const inv = new rgblib.Invoice(invoice)
    try { return inv.invoiceData() } finally { inv.drop?.() }
  }
}

// one call at a time: rgb-lib is not built for concurrent use
let queue = Promise.resolve()
const serial = (fn) => (queue = queue.then(fn, fn))
// Pure reads skip the queue so they never wait behind a whole sync or send. rgb-lib's calls are
// synchronous, so a read still can't run *inside* another native call; it just doesn't wait for the
// rest of a queued job. Anything that writes (send, UTXOs, invoices, unlock, sync) stays serial.
const READ_ONLY = new Set(['state', 'status', 'listTransfers', 'decodeInvoice'])
// calls that mean "the merchant is doing something right now" (a payment review starts by decoding)
const ACTIVITY = new Set(['decodeInvoice', 'send', 'createInvoice'])

// BigInt -> number (amounts are far below 2^53)
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
const authorized = (h) => {
  const a = Buffer.from(String(h ?? '')), b = Buffer.from(`Bearer ${TOKEN}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

const server = http.createServer((req, res) => {
  // 'connection: close': a fresh connection per request. Reusing keep-alive sockets raced with
  // Node's 5 s idle timeout (Kasa polls every 5 s) and surfaced as intermittent "fetch failed".
  const reply = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', connection: 'close' })
    res.end(json(body))
  }
  if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'not found' })
  if (!authorized(req.headers.authorization)) return reply(401, { error: 'unauthorized' })
  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
  req.on('end', () => {
    let method, params
    try {
      ;({ method, params } = JSON.parse(body || '{}'))
    } catch {
      return reply(400, { error: 'invalid JSON' })
    }
    if (!Object.hasOwn(api, method)) return reply(400, { error: `unknown method ${method}` })
    if (ACTIVITY.has(method)) lastActivity = Date.now()
    const run = async () => {
      try {
        reply(200, { result: await api[method](params ?? {}) })
      } catch (e) {
        // include the underlying cause (rgb-lib's real reason); never echoes params (passwords, mnemonics)
        const cause = e?.cause?.message ?? e?.cause
        reply(500, { error: String(e?.message ?? e) + (cause ? `: ${String(cause)}` : '') })
      }
    }
    if (READ_ONLY.has(method)) void run()
    else serial(run)
  })
})

server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: server.address().port })))
function shutdown() {
  try { closeWallet() } catch { /* exiting anyway */ }
  releaseLock()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Kasa keeps our stdin open; it closes when Kasa exits for ANY reason (crash, Ctrl+C, dev reload),
// so an orphaned service can never keep syncing the wallet next to a new one.
if (process.env.WALLET_PARENT_PIPE === '1') {
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.resume()
}
