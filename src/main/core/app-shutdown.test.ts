import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAppShutdown } from './app-shutdown'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { app: Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() }) }
})

function requestQuit(): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() }
  app.emit('before-quit', event)
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  app.removeAllListeners()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  app.removeAllListeners()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('application shutdown', () => {
  it('defers fast cleanup and the next quit beyond the initial native callback', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    registerAppShutdown(cleanup)
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it.each(['reject', 'throw'])('logs a cleanup %s and still requests quit', async (failure) => {
    const error = new Error('Cleanup failed')
    const cleanup = vi.fn(() => {
      if (failure === 'throw') throw error
      return Promise.reject(error)
    })
    registerAppShutdown(cleanup)
    requestQuit()
    await vi.advanceTimersByTimeAsync(0)
    expect(console.error).toHaveBeenCalledExactlyOnceWith(error)
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('forces exit after five seconds when cleanup stalls', async () => {
    registerAppShutdown(() => new Promise(() => {}))
    requestQuit()
    await vi.advanceTimersByTimeAsync(4999)
    expect(app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.exit).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('keeps the deadline when cleanup finishes but Electron ignores quit', async () => {
    registerAppShutdown(async () => {})
    requestQuit()
    await vi.advanceTimersByTimeAsync(0)
    expect(app.quit).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4999)
    expect(app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.exit).toHaveBeenCalledOnce()
  })

  it('allows repeated quit without starting cleanup or its deadline again', async () => {
    const cleanup = vi.fn(() => new Promise<void>(() => {}))
    registerAppShutdown(cleanup)
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce()
    expect(requestQuit().preventDefault).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(app.exit).toHaveBeenCalledOnce()
  })

  it('clears the deadline only when Electron actually quits', async () => {
    vi.mocked(app.quit).mockImplementation(() => {
      expect(requestQuit().preventDefault).not.toHaveBeenCalled()
      app.emit('quit', {}, 0)
    })
    registerAppShutdown(async () => {})
    requestQuit()
    await vi.advanceTimersByTimeAsync(0)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(app.exit).not.toHaveBeenCalled()
  })
})
