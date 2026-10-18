import process from 'process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
export type RgbBackendName = 'mock' | 'kaleido' | 'wdk'
// the in-app WDK wallet is the default; RGB_BACKEND=kaleido for the Docker node, RGB_MOCK=1 for a fake wallet
const backend = (process.env.RGB_BACKEND ??
  (process.env.RGB_MOCK === '1' ? 'mock' : 'wdk')) as RgbBackendName

// The wallet service needs Node 22 (rgb-lib's native module doesn't load on newer Node).
// WALLET_NODE wins; otherwise look for a Node 22 from nvm or Homebrew, then fall back to `node` on PATH.
function findNode22(): string {
  if (process.env.WALLET_NODE) return process.env.WALLET_NODE
  const home = process.env.HOME ?? ''
  try {
    const dir = join(home, '.nvm', 'versions', 'node')
    const v22 = readdirSync(dir)
      .filter((v) => v.startsWith('v22.'))
      .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]))[0]
    if (v22) return join(dir, v22, 'bin', 'node')
  } catch {
    /* no nvm */
  }
  for (const brew of ['/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node'])
    if (existsSync(brew)) return brew
  return 'node'
}
const WDK = backend === 'wdk'

// RGB network label: the KaleidoSwap node calls Mutinynet 'SignetCustom', UTEXO's WDK module 'Signet'.
const network = process.env.RGB_NETWORK ?? (WDK ? 'Signet' : 'SignetCustom')
// Verified Mutinynet profile shared by development and packaged launches (same chain for both backends).
const mutinynet = process.env.RGB_NETWORK === undefined || network === 'SignetCustom'

export const rgbConfig = {
  backend,
  mock: backend === 'mock',
  nodeUrl: process.env.RLN_NODE_URL ?? 'http://localhost:3001',
  assetId:
    process.env.RGB_ASSET_ID ??
    (WDK
      ? 'rgb:PZYLqe~F-l1W~luC-1zH3CCI-TChEioP-jbNuXjJ-zVo6J7k'
      : 'rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0'),
  proxy: process.env.RGB_PROXY ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
  precision: 6,
  invoiceTtlSec: 3600,
  feeRate: Number(process.env.RGB_FEE_RATE ?? 2),
  network,
  nodeChainApi:
    process.env.RGB_NODE_CHAIN_API ?? (mutinynet ? 'https://esplora.signet.kaleidoswap.com' : ''),
  checkpointHeight: Number(process.env.RGB_CHAIN_CHECKPOINT_HEIGHT ?? (mutinynet ? 100000 : 0)),
  checkpointHash:
    process.env.RGB_CHAIN_CHECKPOINT_HASH ??
    (mutinynet ? '00000166f046342c6b499798686eb13cd2b4c6e5fd4189157922dca54705eb71' : ''),
  maxFeeRate: 20,
  minBtcSats: 1000,
  // blocks before a payment counts as final; 1 suits Mutinynet test funds (raise for real money)
  confirmations: Number(process.env.RGB_CONFIRMATIONS ?? 1),
  explorerApi: process.env.RGB_EXPLORER_API ?? 'https://mutinynet.com/api',
  walletNode: findNode22(),
  walletMaxSendRaw: Number(process.env.WALLET_MAX_SEND_RAW ?? 500_000_000),
  payPage: process.env.PAY_PAGE ?? 'https://kalepox.github.io/MonteKasa/pay.html'
}

export function paymentConfigurationError(): string | undefined {
  if (
    !rgbConfig.nodeChainApi ||
    !Number.isSafeInteger(rgbConfig.checkpointHeight) ||
    rgbConfig.checkpointHeight <= 0 ||
    !/^[a-f0-9]{64}$/.test(rgbConfig.checkpointHash)
  )
    return 'Payment verification needs a node chain API and a trusted checkpoint for the selected network. Configure RGB_NODE_CHAIN_API, RGB_CHAIN_CHECKPOINT_HEIGHT and RGB_CHAIN_CHECKPOINT_HASH, then restart.'
  for (const base of [rgbConfig.nodeChainApi, rgbConfig.explorerApi]) {
    try {
      const url = new URL(base)
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        return 'Chain services must use HTTPS or loopback HTTP.'
    } catch {
      return 'A configured chain service URL is invalid.'
    }
  }
  return undefined
}
