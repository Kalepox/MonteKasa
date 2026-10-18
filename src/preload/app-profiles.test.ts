import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppProfilesAPI, AppProfileCommand } from '../shared/app-profile'

const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke }
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('app profile preload boundary', () => {
  it('exposes only saved profile operations through dedicated IPC channels', async () => {
    vi.resetModules()
    vi.stubGlobal('process', { ...process, contextIsolated: true })
    await import('./index')
    const api = bridge.expose.mock.calls.find(
      ([name]) => name === 'appProfiles'
    )?.[1] as AppProfilesAPI
    expect(Object.keys(api)).toEqual(['get', 'change'])
    expect(bridge.invoke).not.toHaveBeenCalled()
    const saved = { profiles: [], activeProfileId: null }
    bridge.invoke.mockResolvedValue(saved)
    expect(await api.get()).toBe(saved)
    const command: AppProfileCommand = { kind: 'select', profileId: 'saved-app-profile' }
    expect(await api.change(command)).toBe(saved)
    expect(bridge.invoke.mock.calls).toEqual([
      ['app-profiles:get'],
      ['app-profiles:change', command]
    ])
  })
})
