import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolveWalletNode } from './wallet-node'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ readdirSync: vi.fn() }))
vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NVM_DIR', undefined)
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('not found')
  })
  vi.mocked(readdirSync).mockReturnValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('wallet Node 22 selection', () => {
  it('uses a validated explicit executable even when another runtime is available', () => {
    vi.mocked(execFileSync).mockReturnValue('v22.23.3\n')
    expect(resolveWalletNode('/custom/node')).toBe('/custom/node')
    expect(execFileSync).toHaveBeenCalledOnce()
    expect(execFileSync).toHaveBeenCalledWith(
      '/custom/node',
      ['--version'],
      expect.objectContaining({ timeout: 3000 })
    )
  })

  it.each(['v24.19.0', 'v20.19.0', 'not a version'])(
    'rejects an explicit unsupported runtime %s without silently replacing it',
    (version) => {
      vi.mocked(execFileSync).mockReturnValue(version)
      expect(() => resolveWalletNode('/custom/node')).toThrow('WALLET_NODE must point')
      expect(execFileSync).toHaveBeenCalledOnce()
    }
  )

  it('rejects missing and empty explicit executables with an actionable error', () => {
    expect(() => resolveWalletNode('/missing/node')).toThrow('WALLET_NODE must point')
    expect(() => resolveWalletNode('')).toThrow('WALLET_NODE must point')
  })

  it('uses PATH when its Node version is supported', () => {
    vi.mocked(execFileSync).mockReturnValue('v22.23.3')
    expect(resolveWalletNode()).toBe('node')
    expect(readdirSync).not.toHaveBeenCalled()
  })

  it('selects the newest installed NVM Node 22 when PATH is Node 24', () => {
    vi.stubEnv('NVM_DIR', '/custom/nvm')
    vi.mocked(readdirSync).mockReturnValue(['v22.9.0', 'v24.19.0', 'v22.23.3'] as never)
    vi.mocked(execFileSync).mockImplementation((binary) =>
      binary === 'node' ? 'v24.19.0' : 'v22.23.3'
    )
    expect(resolveWalletNode()).toBe('/custom/nvm/versions/node/v22.23.3/bin/node')
    expect(readdirSync).toHaveBeenCalledWith('/custom/nvm/versions/node')
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('tries another installed Node 22 when one candidate is broken', () => {
    vi.mocked(readdirSync).mockReturnValue(['v22.9.0', 'v22.23.3'] as never)
    vi.mocked(execFileSync).mockImplementation((binary) => {
      if (binary === '/home/test/.nvm/versions/node/v22.9.0/bin/node') return 'v22.9.0'
      throw new Error('not executable')
    })
    expect(resolveWalletNode()).toBe('/home/test/.nvm/versions/node/v22.9.0/bin/node')
  })

  it('supports Homebrew without an NVM installation', () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    vi.mocked(execFileSync).mockImplementation((binary) => {
      if (binary === '/opt/homebrew/opt/node@22/bin/node') return 'v22.23.3'
      throw new Error('not executable')
    })
    expect(resolveWalletNode()).toBe('/opt/homebrew/opt/node@22/bin/node')
  })

  it('explains how to recover when no Node 22 is installed', () => {
    expect(() => resolveWalletNode()).toThrow('Install it, or set WALLET_NODE')
  })
})
