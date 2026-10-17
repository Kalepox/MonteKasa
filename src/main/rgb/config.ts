import process from 'process'
export type RgbBackendName = 'mock' | 'kaleido' | 'wdk'
const backend = (process.env.RGB_BACKEND ??
  (process.env.RGB_MOCK === '1' ? 'mock' : 'kaleido')) as RgbBackendName
const WDK = backend === 'wdk'

export const rgbConfig = {
  backend,
  mock: backend === 'mock',
  nodeUrl: process.env.RLN_NODE_URL ?? 'http://localhost:3001',
  assetId: process.env.RGB_ASSET_ID ??
    (WDK ? 'rgb:PZYLqe~F-l1W~luC-1zH3CCI-TChEioP-jbNuXjJ-zVo6J7k' : 'rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0'),
  proxy: process.env.RGB_PROXY ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
  precision: 6,
  invoiceTtlSec: 3600,
  feeRate: Number(process.env.RGB_FEE_RATE ?? 2),
  network: process.env.RGB_NETWORK ?? (WDK ? 'Signet' : 'SignetCustom'),
  nodeChainApi: process.env.RGB_NODE_CHAIN_API ?? (WDK ? 'https://esplora.signet.kaleidoswap.com' : ''),
  checkpointHeight: Number(process.env.RGB_CHAIN_CHECKPOINT_HEIGHT ?? 0),
  checkpointHash: process.env.RGB_CHAIN_CHECKPOINT_HASH ?? '',
  maxFeeRate: 20,
  minBtcSats: 1000,
  confirmations: 3,
  explorerApi: process.env.RGB_EXPLORER_API ?? 'https://mutinynet.com/api',
  walletNode: process.env.WALLET_NODE ?? 'node',              // must be a Node 22 binary
  walletMaxSendRaw: Number(process.env.WALLET_MAX_SEND_RAW ?? 500_000_000),
}
