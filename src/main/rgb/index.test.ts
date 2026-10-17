import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const factories = vi.hoisted(() => ({
  wdk: vi.fn(() => ({ wallet: {} })),
  kaleido: vi.fn(() => ({ kind: 'kaleido' })),
  mock: vi.fn(() => ({ backend: { kind: 'mock' }, pay: vi.fn() }))
}))
vi.mock('./wdk', () => ({ createWdkBackend: factories.wdk }))
vi.mock('./kaleido', () => ({ createKaleidoBackend: factories.kaleido }))
vi.mock('./mock', () => ({ createMockBackend: factories.mock }))

beforeEach(() => {
  vi.stubEnv('RGB_BACKEND', undefined)
  vi.stubEnv('RGB_MOCK', undefined)
  vi.clearAllMocks()
  vi.resetModules()
})
afterEach(() => vi.unstubAllEnvs())

describe('wallet backend selection', () => {
  it('creates the WDK wallet with ordinary launch environment', async () => {
    const { createRgb } = await import('./index')
    expect(createRgb().backend).toEqual({ wallet: {} })
    expect(factories.wdk).toHaveBeenCalledOnce()
    expect(factories.kaleido).not.toHaveBeenCalled()
    expect(factories.mock).not.toHaveBeenCalled()
  })

  it('preserves explicit mock mode for isolated demos and tests', async () => {
    vi.stubEnv('RGB_MOCK', '1')
    const { createRgb } = await import('./index')
    expect(createRgb().backend).toEqual({ kind: 'mock' })
    expect(factories.mock).toHaveBeenCalledOnce()
    expect(factories.wdk).not.toHaveBeenCalled()
  })

  it('preserves explicitly selected Kaleido mode', async () => {
    vi.stubEnv('RGB_BACKEND', 'kaleido')
    const { createRgb } = await import('./index')
    expect(createRgb().backend).toEqual({ kind: 'kaleido' })
    expect(factories.kaleido).toHaveBeenCalledOnce()
    expect(factories.wdk).not.toHaveBeenCalled()
  })

  it('honours an explicit WDK backend over the legacy mock flag', async () => {
    vi.stubEnv('RGB_BACKEND', 'wdk')
    vi.stubEnv('RGB_MOCK', '1')
    const { createRgb } = await import('./index')
    expect(createRgb().backend).toEqual({ wallet: {} })
    expect(factories.wdk).toHaveBeenCalledOnce()
    expect(factories.mock).not.toHaveBeenCalled()
  })
})
