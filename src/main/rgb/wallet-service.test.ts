import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletService } from './wallet-service'
import { resolveWalletNode } from './wallet-node'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/temp/user-data' }
}))
vi.mock('./config', () => ({
  rgbConfig: { walletNode: undefined, assetId: 'test-asset', walletMaxSendRaw: 500 }
}))
vi.mock('./wallet-node', () => ({ resolveWalletNode: vi.fn() }))

function processFixture(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((signal) => {
      child.emit('exit', null, signal)
      return true
    })
  }) as unknown as ChildProcess
  return child
}
const ready = (child: ChildProcess): void => {
  child.stdout!.emit('data', Buffer.from('{"ready":true,"port":12345}\n'))
}
const launch = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.mocked(resolveWalletNode).mockReturnValue('/node22')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: async () => ({ result: { state: 'none' } }) })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('wallet service lifecycle', () => {
  it('does not launch a queued process after app shutdown', async () => {
    const service = new WalletService()
    const request = service.call('state')
    service.stop()
    await expect(request).rejects.toThrow('Wallet service has stopped')
    await expect(service.call('state')).rejects.toThrow('Wallet service has stopped')
    expect(spawn).not.toHaveBeenCalled()
    expect(resolveWalletNode).not.toHaveBeenCalled()
  })

  it('starts Node 22 once for concurrent calls and reuses the ready service', async () => {
    const child = processFixture()
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    const first = service.call('state')
    const second = service.call('state')
    await launch()
    ready(child)
    expect(await first).toEqual({ state: 'none' })
    await second
    await service.call('state')
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      '/node22',
      ['server.mjs'],
      expect.objectContaining({
        cwd: '/app/wallet-service',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    )
    expect(fetch).toHaveBeenCalledTimes(3)
    service.stop()
  })

  it('handles a spawn error without an unhandled event and retries', async () => {
    const broken = processFixture()
    const healthy = processFixture()
    Object.assign(broken, { pid: undefined }) // spawn failed before a process existed
    vi.mocked(spawn).mockReturnValueOnce(broken).mockReturnValueOnce(healthy)
    const service = new WalletService()
    const failure = expect(service.call('state')).rejects.toThrow(
      'Could not start the WDK wallet service: spawn ENOENT'
    )
    await launch()
    broken.emit('error', new Error('spawn ENOENT'))
    await failure
    expect(broken.kill).not.toHaveBeenCalled()
    const retry = service.call('state')
    await launch()
    ready(healthy)
    expect(await retry).toEqual({ state: 'none' })
    service.stop()
  })

  it('terminates a startup timeout and does not let a late ready message revive it', async () => {
    vi.useFakeTimers()
    const child = processFixture()
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    const failure = expect(service.call('state')).rejects.toThrow('did not start within 30 s')
    await launch()
    child.stdout!.emit('data', Buffer.from('{"ready":true,"port":99999}\n'))
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    ready(child)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('restarts after a process exit and ignores an old process exit during the retry', async () => {
    const firstChild = processFixture()
    const nextChild = processFixture()
    vi.mocked(spawn).mockReturnValueOnce(firstChild).mockReturnValueOnce(nextChild)
    const service = new WalletService()
    const first = service.call('state')
    await launch()
    ready(firstChild)
    await first
    firstChild.emit('exit', 1)
    const second = service.call('state')
    await launch()
    firstChild.emit('exit', 1)
    ready(nextChild)
    await second
    await service.call('state')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(resolveWalletNode).toHaveBeenCalledOnce()
    service.stop()
  })

  it('rejects early exits and stopping during startup', async () => {
    const first = processFixture()
    const second = processFixture()
    vi.mocked(spawn).mockReturnValueOnce(first).mockReturnValueOnce(second)
    const service = new WalletService()
    const exited = expect(service.call('state')).rejects.toThrow('exited (code 1)')
    await launch()
    first.emit('exit', 1)
    await exited
    const stopped = expect(service.call('state')).rejects.toThrow('startup was stopped')
    await launch()
    service.stop()
    await stopped
    expect(second.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('retries runtime resolution failures without spawning an unsupported runtime', async () => {
    vi.mocked(resolveWalletNode)
      .mockImplementationOnce(() => {
        throw new Error('Install Node.js 22')
      })
      .mockReturnValue('/node22')
    const child = processFixture()
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    await expect(service.call('state')).rejects.toThrow('Install Node.js 22')
    expect(spawn).not.toHaveBeenCalled()
    const retry = service.call('state')
    await launch()
    ready(child)
    await retry
    service.stop()
  })

  it('stops a running service once and prevents further calls', async () => {
    const child = processFixture()
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    const first = service.call('state')
    await launch()
    ready(child)
    await first
    const pending = service.call('state')
    service.stop()
    service.stop()
    await expect(pending).rejects.toThrow('Wallet service has stopped')
    await expect(service.call('state')).rejects.toThrow('Wallet service has stopped')
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for a timed-out process to exit before starting a replacement', async () => {
    const old = processFixture()
    const next = processFixture()
    vi.mocked(old.kill).mockReturnValue(true) // SIGTERM accepted, cleanup still in progress
    vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(next)
    const service = new WalletService()
    const failure = expect(service.call('state')).rejects.toThrow('did not start within 30 s')
    await launch()
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    const retry = service.call('state')
    await launch()
    expect(spawn).toHaveBeenCalledOnce()
    old.emit('exit', 0)
    await launch()
    ready(next)
    expect(await retry).toEqual({ state: 'none' })
    expect(spawn).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('forces a stalled child to exit after the graceful shutdown deadline', async () => {
    const child = processFixture()
    vi.mocked(child.kill).mockImplementation((signal) => {
      if (signal === 'SIGKILL') child.emit('exit', null, signal)
      return true
    })
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    const first = service.call('state')
    await launch()
    ready(child)
    await first
    service.stop()
    await vi.advanceTimersByTimeAsync(5999)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not recursively signal a child when killing it emits an error', async () => {
    const child = processFixture()
    vi.mocked(child.kill).mockImplementation(() => {
      child.emit('error', new Error('termination error'))
      return false
    })
    vi.mocked(spawn).mockReturnValue(child)
    const service = new WalletService()
    const first = service.call('state')
    await launch()
    ready(child)
    await first
    service.stop()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    child.emit('exit', 0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
