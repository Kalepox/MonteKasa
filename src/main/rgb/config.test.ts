import { afterEach, describe, expect, it, vi } from 'vitest'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})
describe('persistent built-in network profile', () => {
  it('uses the in-app WDK wallet by default without launch flags', async () => {
    for (const name of ['RGB_BACKEND', 'RGB_MOCK', 'RGB_NETWORK', 'RGB_ASSET_ID', 'WALLET_NODE'])
      vi.stubEnv(name, undefined)
    const { rgbConfig, paymentConfigurationError } = await import('./config')
    expect(rgbConfig.backend).toBe('wdk')
    expect(rgbConfig.mock).toBe(false)
    expect(rgbConfig.network).toBe('Signet')
    expect(rgbConfig.assetId).toBe('rgb:PZYLqe~F-l1W~luC-1zH3CCI-TChEioP-jbNuXjJ-zVo6J7k')
    expect(rgbConfig.walletNode).toBeUndefined()
    expect(paymentConfigurationError()).toBeUndefined()
  })
  it.each(['wdk', 'kaleido', 'mock'])('keeps an explicit %s backend selection', async (backend) => {
    vi.stubEnv('RGB_BACKEND', backend)
    vi.stubEnv('RGB_MOCK', '1')
    vi.stubEnv('RGB_NETWORK', undefined)
    const { rgbConfig } = await import('./config')
    expect(rgbConfig.backend).toBe(backend)
    expect(rgbConfig.mock).toBe(backend === 'mock')
    expect(rgbConfig.network).toBe(backend === 'wdk' ? 'Signet' : 'SignetCustom')
  })
  it('keeps explicit mock mode without a backend override', async () => {
    vi.stubEnv('RGB_BACKEND', undefined)
    vi.stubEnv('RGB_MOCK', '1')
    expect((await import('./config')).rgbConfig.backend).toBe('mock')
  })
  it('rejects unknown backends instead of silently falling back to Kaleido', async () => {
    vi.stubEnv('RGB_BACKEND', 'wdkk')
    await expect(import('./config')).rejects.toThrow('RGB_BACKEND must be')
  })
  it('uses the correct checkpoint for explicitly selected WDK Signet', async () => {
    vi.stubEnv('RGB_BACKEND', 'wdk')
    vi.stubEnv('RGB_NETWORK', 'Signet')
    vi.stubEnv('RGB_NODE_CHAIN_API', undefined)
    vi.stubEnv('RGB_CHAIN_CHECKPOINT_HEIGHT', undefined)
    vi.stubEnv('RGB_CHAIN_CHECKPOINT_HASH', undefined)
    const { rgbConfig, paymentConfigurationError } = await import('./config')
    expect(rgbConfig.checkpointHeight).toBe(100000)
    expect(paymentConfigurationError()).toBeUndefined()
  })
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
