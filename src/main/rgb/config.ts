import process from 'process'

export const rgbConfig = {
  mock: process.env.RGB_MOCK === '1',
  nodeUrl: process.env.RLN_NODE_URL ?? 'http://localhost:3001',
  assetId: process.env.RGB_ASSET_ID ?? 'rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0',
  proxy: process.env.RGB_PROXY ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
  precision: 6,
  invoiceTtlSec: 3600,
  feeRate: Number(process.env.RGB_FEE_RATE ?? 2),
  network: process.env.RGB_NETWORK ?? 'SignetCustom',
  nodeChainApi: process.env.RGB_NODE_CHAIN_API ?? '',
  // A trusted, fixed anchor block on Mutinynet signet so chain verification doesn't have to
  // trust the explorer from genesis. Without this, incoming-payment confirmation checks fail
  // silently (requireCheck in ChainObserver.identity) and every payment stays stuck on
  // "confirming" forever, no matter how many real confirmations it has.
  checkpointHeight: Number(process.env.RGB_CHAIN_CHECKPOINT_HEIGHT ?? 3500000),
  checkpointHash:
    process.env.RGB_CHAIN_CHECKPOINT_HASH ??
    '000001d0ecff35c5940c318d04ae778ae153fd3fb084234d80ca75b3613b6736',
  maxFeeRate: 20,
  minBtcSats: 1000,
  confirmations: 3,
  explorerApi: process.env.RGB_EXPLORER_API ?? 'https://mutinynet.com/api'
}
