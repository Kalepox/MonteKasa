import { expect, it, vi } from 'vitest'
import { freshSecurityContext } from './fresh-security-context'
import type { SecuritySnapshot } from '../../shared/security'

it('waits for the monitor before reading a snapshot', async () => {
  const snapshot = vi.fn((): SecuritySnapshot => ({
    operations: [],
    findings: [],
    monitoring: {},
    requiredConfirmations: 3
  }))
  let finish!: () => void
  const monitor = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const result = freshSecurityContext({ monitor, snapshot })
  expect(snapshot).not.toHaveBeenCalled()
  finish()
  expect(JSON.parse(await result).monitoring.unavailable).toBe(false)
  expect(snapshot).toHaveBeenCalledOnce()
})

it.each(['failure', 'timeout'])(
  'marks last-known evidence when refresh encounters %s',
  async (mode) => {
    const snapshot = (): SecuritySnapshot => ({ operations: [], findings: [], monitoring: {} })
    const monitor = (): Promise<void> =>
      mode === 'failure' ? Promise.reject(new Error('offline')) : new Promise<void>(() => {})
    const context = JSON.parse(
      await freshSecurityContext({ monitor, snapshot }, undefined, undefined, 5)
    )
    expect(context.monitoring.unavailable).toBe(true)
  }
)
