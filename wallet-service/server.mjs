// MonteKasa wallet service: one WDK RGB wallet behind a local, token-protected JSON API.
// Started by Kasa (Electron main) with WALLET_DATA_DIR and WALLET_TOKEN; prints {"ready":true,"port":N}.
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
  await account.registerWallet()
}

function closeWallet() {
  try { wdk?.dispose() } catch { /* wdk-wallet-rgb 2.0.3 throws 'Invalid checksum' on dispose */ }
  wdk = account = null
  approved.clear()
}

const unlocked = () => {
  if (!account) throw new Error('Wallet is locked')
  return account
}
const notFound = (e) => /AssetNotFound/.test(String(e?.message))


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

  async status({ assetId }) {
    const r = await unlocked().registerWallet() // also refreshes the BTC balance
    // getTokenBalance returns a plain number (BigInt), not an object
    let spendable = 0
    try { spendable = Number(await account.getTokenBalance(assetId)) } catch (e) { if (!notFound(e)) throw e }
    return { address: r.address, btc: r.btcBalance, asset: { settled: spendable, spendable } }
  },

  async address() {
    return { address: (await unlocked().registerWallet()).address } // fund THIS address
  },

  async createUtxos({ num = 10, size = 3000, feeRate = 2 }) {
    const a = unlocked()
    const psbt = await a.createUtxosBegin({ upTo: true, num, size, feeRate })
    return { created: await a.createUtxosEnd({ signedPsbt: await a.signPsbt(psbt) }) }
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

  async listTransfers({ assetId }) {
    const a = unlocked()
    await a.refreshWallet()
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
    }
  },


  decodeInvoice({ invoice }) {
    const inv = new rgblib.Invoice(invoice)
    try { return inv.invoiceData() } finally { inv.drop?.() }
  }
}

//one call at a time: rgb-lib is not built for concurrent use 
let queue = Promise.resolve()
const serial = (fn) => (queue = queue.then(fn, fn))

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
  req.on('end', () =>
    serial(async () => {
      try {
        const { method, params } = JSON.parse(body || '{}')
        if (!Object.hasOwn(api, method)) return reply(400, { error: `unknown method ${method}` })
        reply(200, { result: await api[method](params ?? {}) })
      } catch (e) {
        reply(500, { error: String(e?.message ?? e) }) // never echoes params (passwords, mnemonics)
      }
    })
  )
})

server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: server.address().port })))
process.on('SIGTERM', () => { closeWallet(); process.exit(0) })
