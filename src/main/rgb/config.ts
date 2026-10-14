import process from "process";

export const rgbConfig = {
    mock: process.env.RGB_MOCK === '1',
    nodeUrl: process.env.RLN_NODE_URL ?? 'http://localhost:3001',
    assetId: process.env.RGB_ASSET_ID ?? 'rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0',
    proxy: process.env.RGB_PROXY ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
    precision: 6,
    invoiceTtlSec: 3600,
    feeRate: 2,
    explorerApi: 'https://mutinynet.com/api'
}
