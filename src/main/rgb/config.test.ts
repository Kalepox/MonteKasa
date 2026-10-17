import { afterEach, describe, expect, it, vi } from 'vitest'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})
describe('persistent built-in network profile', () => {
  it('supplies chain verification for normal Mutinynet launches', async () => {
    for (const name of [
      'RGB_NETWORK',
      'RGB_NODE_CHAIN_API',
      'RGB_CHAIN_CHECKPOINT_HEIGHT',
      'RGB_CHAIN_CHECKPOINT_HASH'
    ])
      vi.stubEnv(name, undefined)
    vi.resetModules()
    const { rgbConfig } = await import('./config')
    expect(rgbConfig.nodeChainApi).toBe('https://esplora.signet.kaleidoswap.com')
    expect(rgbConfig.checkpointHeight).toBe(100000)
    expect(rgbConfig.checkpointHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('never applies a Mutinynet checkpoint to another network', async () => {
    vi.stubEnv('RGB_NETWORK', 'Mainnet')
    for (const name of [
      'RGB_NODE_CHAIN_API',
      'RGB_CHAIN_CHECKPOINT_HEIGHT',
      'RGB_CHAIN_CHECKPOINT_HASH'
    ])
      vi.stubEnv(name, undefined)
    vi.resetModules()
    const { rgbConfig } = await import('./config')
    expect(rgbConfig.nodeChainApi).toBe('')
    expect(rgbConfig.checkpointHash).toBe('')
  })
})
