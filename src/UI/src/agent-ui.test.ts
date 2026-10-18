import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaxScope } from '../../shared/tax-scope'
import { taxScopeKey } from '../../shared/tax-selection'
import type { AgentEvent } from '../../shared/agent'

// Small DOM fixture: exercises the real UI handlers without adding a browser dependency.
class Element {
  hidden = false
  disabled = false
  textContent = ''
  value = ''
  dataset: Record<string, string> = {}
  innerHTML = ''
  onclick?: () => unknown
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>
  focus = vi.fn()
  childNodes: Element[] = []
  append = vi.fn((...nodes: Element[]) => {
    this.childNodes.push(...nodes)
  })
  setAttribute = vi.fn()
  addEventListener = vi.fn()
  replaceChildren = vi.fn((...nodes: Element[]) => {
    this.childNodes = nodes
  })
  querySelector(selector: string): Element {
    return get(selector.slice(1))
  }
  click(): unknown {
    return this.disabled ? undefined : this.onclick?.()
  }
}
let elements: Map<string, Element>
function get(id: string): Element {
  if (!elements.has(id)) elements.set(id, new Element())
  return elements.get(id)!
}
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(installed = true, ready = false, statusError = false) {
  vi.resetModules()
  elements = new Map()
  let emit: (event: AgentEvent) => void = () => {}
  const scope: TaxScope = {
    version: 1,
    databaseId: 'db',
    appProfileId: 'app',
    activeTaxpayerId: 'me',
    taxpayers: [
      {
        id: 'me',
        label: 'Personal profile',
        profile: {
          version: 1,
          country: 'IT',
          taxYear: 2026,
          userType: 'personal',
          personalRegime: 'unknown',
          businessType: null,
          businessRegime: null,
          recordsCoverage: 'unknown'
        }
      }
    ],
    accounts: [],
    assets: [],
    assignments: []
  }
  const listeners = new Map<string, (() => void)[]>()
  const taxScope = { get: vi.fn(async () => scope) }
  const api = {
    status: vi.fn(async () => {
      if (statusError) throw new Error('No handler registered for agent:status')
      return { installed, ready }
    }),
    prepare: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    chat: vi.fn(async () => {
      emit({ type: 'turn-end', text: '' })
      return 'Explanation'
    }),
    commercialistaChat: vi.fn(async () => {
      emit({ type: 'turn-end', text: '' })
      return 'Tax explanation'
    }),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      emit = listener
      return vi.fn()
    })
  }
  vi.stubGlobal('document', {
    createElement: () => new Element(),
    body: new Element(),
    getElementById: get
  })
  vi.stubGlobal('window', {
    agent: api,
    taxScope,
    addEventListener: vi.fn((name: string, listener: () => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    })
  })
  await import('./agent')
  await flush()
  return {
    api,
    scope,
    taxScope,
    dispatch: (name: string) => listeners.get(name)?.forEach((listener) => listener()),
    emit: (event: AgentEvent) => emit(event)
  }
}
afterEach(() => vi.unstubAllGlobals())
describe('shared AI controls', () => {
  it('checks status without automatically starting or downloading', async () => {
    const { api } = await setup(false)
    expect(api.status).toHaveBeenCalledOnce()
    expect(api.prepare).not.toHaveBeenCalled()
    expect(get('tax-ai-prepare').textContent).toContain('Download')
    expect(get('agent-prepare').textContent).toBe(get('tax-ai-prepare').textContent)
    expect(get('agent-send').disabled).toBe(true)
  })
  it('starts the cached model from Commercialista and closes it from either surface', async () => {
    const { api } = await setup()
    expect(get('tax-ai-prepare').textContent).toBe('Turn on agent')
    get('tax-ai-prepare').click()
    await flush()
    expect(api.prepare).toHaveBeenCalledOnce()
    expect(get('agent-send').disabled).toBe(false)
    expect(get('tax-ai-prepare').hidden).toBe(true)
    get('agent-off').click()
    await flush()
    expect(api.close).toHaveBeenCalledOnce()
    expect(get('tax-ai-prepare').textContent).toBe('Turn on agent')
    expect(get('agent-send').disabled).toBe(true)
    get('agent-prepare').click()
    await flush()
    get('tax-ai-close').click()
    await flush()
    expect(api.close).toHaveBeenCalledTimes(2)
    expect(get('agent-status').textContent).toContain('files remain')
  })
  it('hides without unloading and preserves readiness when reopened', async () => {
    const { api } = await setup(true, true)
    get('agent-close').click()
    expect(get('agent-chat').hidden).toBe(true)
    expect(get('agent-toggle').textContent).toContain('On')
    expect(api.close).not.toHaveBeenCalled()
    expect(api.stop).not.toHaveBeenCalled()
    get('agent-toggle').click()
    expect(get('agent-chat').hidden).toBe(false)
    expect(get('agent-send').disabled).toBe(false)
    expect(api.prepare).not.toHaveBeenCalled()
    get('agent-off').click()
    await flush()
    expect(get('agent-chat').hidden).toBe(false)
    expect(get('agent-toggle').textContent).toContain('Off')
    expect(get('agent-off').disabled).toBe(true)
  })
  it('shares progress and prevents simultaneous setup requests', async () => {
    const { api, emit } = await setup(false)
    let finish!: () => void
    api.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    get('tax-ai-prepare').click()
    get('agent-prepare').click()
    emit({ type: 'status', text: 'Downloading model: 25%' })
    expect(get('tax-ai-status').textContent).toBe('Downloading model: 25%')
    expect(get('tax-ai-prepare').disabled).toBe(true)
    expect(api.prepare).toHaveBeenCalledOnce()
    finish()
    await flush()
    expect(get('tax-ai-status').textContent).toContain('running')
    expect(get('tax-ai-status').textContent).toContain('Ask Commercialista')
  })
  it('treats a failed status check as an error, not a missing installation', async () => {
    const { api } = await setup(true, false, true)
    expect(get('tax-ai-status').textContent).toContain('backend is outdated')
    expect(get('tax-ai-prepare').textContent).toBe('Retry AI status')
    api.status.mockResolvedValue({ installed: true, ready: false })
    get('tax-ai-prepare').click()
    await flush()
    expect(get('tax-ai-prepare').textContent).toBe('Turn on agent')
    expect(api.prepare).not.toHaveBeenCalled()
  })
  it('recovers from setup failure through a fresh cache check', async () => {
    const { api } = await setup(false)
    api.prepare.mockRejectedValueOnce(new Error('Download interrupted'))
    get('tax-ai-prepare').click()
    await flush()
    expect(get('tax-ai-status').textContent).toBe('Download interrupted')
    expect(get('agent-send').disabled).toBe(true)
    api.status.mockResolvedValue({ installed: true, ready: false })
    get('tax-ai-prepare').click()
    await flush()
    expect(get('tax-ai-prepare').textContent).toBe('Turn on agent')
  })
  it('shows shared chat activity and disables duplicate starts', async () => {
    const { api, emit } = await setup(true, true)
    let finish!: (text: string) => void
    api.chat.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    get('agent-input').value = 'Explain the warning'
    const pending = get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    expect(get('tax-ai-status').textContent).toContain('answering a question')
    expect(get('tax-ai-prepare').disabled).toBe(true)
    get('agent-close').click()
    expect(get('agent-chat').hidden).toBe(true)
    expect(api.stop).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
    finish('Explanation')
    await flush()
    expect(get('agent-send').disabled).toBe(true)
    emit({ type: 'turn-end', text: '' })
    await pending
    expect(get('tax-ai-status').textContent).toContain('running')
    expect(get('agent-chat').hidden).toBe(true)
    get('agent-toggle').click()
    expect(get('agent-send').disabled).toBe(false)
  })
  it('disables controls while the initial status is still unknown', async () => {
    const { api } = await setup()
    let finish!: (state: { installed: boolean; ready: boolean }) => void
    api.status.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.resetModules()
    await import('./agent')
    expect(get('tax-ai-prepare').disabled).toBe(true)
    expect(get('agent-send').disabled).toBe(true)
    expect(get('tax-ai-status').textContent).toBe('Checking local AI…')
    finish({ installed: true, ready: true })
    await flush()
    expect(get('agent-send').disabled).toBe(false)
    expect(api.prepare).not.toHaveBeenCalled()
  })
  it('handles a missing desktop bridge without offering a download', async () => {
    await setup()
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    vi.resetModules()
    await import('./agent')
    expect(get('tax-ai-status').textContent).toContain('unavailable')
    expect(get('tax-ai-prepare').disabled).toBe(true)
    expect(get('tax-ai-close').disabled).toBe(true)
    expect(get('agent-send').disabled).toBe(true)
  })
  it('keeps both surfaces in an error state if closing fails', async () => {
    const { api } = await setup(true, true)
    api.close.mockRejectedValueOnce(new Error('Unload failed'))
    get('tax-ai-close').click()
    await flush()
    expect(get('tax-ai-status').textContent).toBe('Unload failed')
    expect(get('agent-send').disabled).toBe(true)
    expect(get('tax-ai-prepare').textContent).toBe('Retry AI status')
  })
})

describe('Commercialista explanation UI', () => {
  it('opens a selected database scope and uses the separate chat API with the shared model', async () => {
    const { api, scope, taxScope } = await setup(true, true)
    get('tax-dashboard-explain').click()
    await flush()
    expect(taxScope.get).toHaveBeenCalledOnce()
    expect(get('agent-title').textContent).toBe('Commercialista')
    expect(get('agent-note').textContent).toContain('Personal profile · 2026')
    expect(get('agent-send').disabled).toBe(false)
    get('agent-input').value = 'Explain my overview'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    expect(api.commercialistaChat).toHaveBeenCalledWith(
      expect.stringContaining('overview'),
      taxScopeKey(scope)
    )
    expect(api.chat).not.toHaveBeenCalled()
    expect(api.prepare).not.toHaveBeenCalled()
    expect(get('agent-status').textContent).toContain('saved data only')
    get('agent-security-mode').click()
    expect(get('agent-title').textContent).toBe('Kasa Assistant')
  })
  it('requires a linked app profile and never substitutes an unrelated taxpayer', async () => {
    const { scope, api } = await setup(true, true)
    scope.appProfileId = null
    get('tax-ai-open').click()
    await flush()
    expect(get('agent-send').disabled).toBe(true)
    expect(get('agent-note').textContent).toContain('link its tax setup')
    get('agent-input').value = 'Explain'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    expect(api.commercialistaChat).not.toHaveBeenCalled()
  })
  it('fails closed on a database error and retries when reopened', async () => {
    const { taxScope } = await setup(true, true)
    taxScope.get.mockRejectedValueOnce(new Error('Database unavailable'))
    get('tax-ai-open').click()
    await flush()
    expect(get('agent-send').disabled).toBe(true)
    expect(get('agent-status').textContent).toContain('Database unavailable')
    get('tax-ai-open').click()
    await flush()
    expect(get('agent-send').disabled).toBe(false)
  })
  it('clears old context and suppresses an in-flight answer after switching year', async () => {
    const { api, scope, dispatch, emit } = await setup(true, true)
    let resolve!: (text: string) => void
    api.commercialistaChat.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    get('tax-ai-open').click()
    await flush()
    get('agent-input').value = 'Explain my overview'
    const pending = get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    dispatch('kasa:tax-scope-busy')
    expect(api.stop).not.toHaveBeenCalled()
    expect(get('agent-send').disabled).toBe(true)
    scope.taxpayers[0].profile.taxYear = 2025
    dispatch('kasa:tax-scope-idle')
    await flush()
    expect(api.stop).toHaveBeenCalledOnce()
    emit({ type: 'token', text: 'OLD PROFILE ANSWER' })
    emit({ type: 'turn-end', text: '' })
    resolve('OLD PROFILE ANSWER')
    await pending
    expect(get('agent-messages').replaceChildren).toHaveBeenCalled()
    expect(get('agent-note').textContent).toContain('2025')
    expect(get('agent-input').value).toBe('')
    expect(get('agent-status').textContent).not.toContain('OLD PROFILE')
    get('agent-input').value = 'Explain this year'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    expect(api.commercialistaChat).toHaveBeenLastCalledWith('Explain this year', taxScopeKey(scope))
  })
  it('waits for profile changes to finish before reading or sending', async () => {
    const { api, taxScope, dispatch } = await setup(true, true)
    get('view-tax').dataset.appProfileBusy = 'true'
    get('tax-ai-open').click()
    await flush()
    expect(taxScope.get).not.toHaveBeenCalled()
    expect(get('agent-send').disabled).toBe(true)
    get('agent-input').value = 'Explain'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    expect(api.commercialistaChat).not.toHaveBeenCalled()
    get('view-tax').dataset.appProfileBusy = 'false'
    dispatch('kasa:app-profile-busy')
    await flush()
    expect(taxScope.get).toHaveBeenCalledOnce()
    expect(get('agent-send').disabled).toBe(false)
  })
  it('ignores an older selection response that arrives after the next one', async () => {
    const { scope, taxScope, dispatch } = await setup(true, true)
    const old = structuredClone(scope)
    let finish!: (value: TaxScope) => void
    taxScope.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    get('tax-ai-open').click()
    scope.taxpayers[0].profile.taxYear = 2025
    dispatch('kasa:tax-scope-idle')
    await flush()
    finish(old)
    await flush()
    expect(get('agent-note').textContent).toContain('2025')
    expect(get('agent-note').textContent).not.toContain('2026')
  })
  it('uses shared install/start/close controls while in Commercialista mode', async () => {
    const { api } = await setup(true, false)
    get('tax-ai-open').click()
    await flush()
    expect(get('agent-send').disabled).toBe(true)
    get('tax-ai-prepare').click()
    await flush()
    expect(get('agent-send').disabled).toBe(false)
    get('tax-ai-close').click()
    await flush()
    expect(api.close).toHaveBeenCalledOnce()
    expect(get('agent-send').disabled).toBe(true)
  })
})

describe('independent assistant conversations and stable drafts', () => {
  it('preserves the draft, caret and transcript through repeated same-scope refreshes', async () => {
    const { dispatch, api } = await setup(true, true)
    get('agent-tax-mode').click()
    await flush()
    get('agent-input').value = 'Explain my missing data'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    const transcript = [...get('agent-messages').childNodes]
    get('agent-input').value = 'I am still typing this question'
    get('agent-input').focus.mockClear()
    for (let i = 0; i < 3; i++) {
      dispatch('kasa:tax-scope-busy')
      expect(get('agent-input').disabled).toBe(false)
      expect(get('agent-input').value).toBe('I am still typing this question')
      dispatch('kasa:tax-scope-updated')
      dispatch('kasa:tax-scope-idle')
      await flush()
    }
    expect(get('agent-input').value).toBe('I am still typing this question')
    expect(get('agent-messages').childNodes).toEqual(transcript)
    expect(get('agent-input').focus).not.toHaveBeenCalled()
    expect(api.stop).not.toHaveBeenCalled()
    expect(get('agent-send').disabled).toBe(false)
  })
  it('keeps distinct transcripts and drafts behind the two selector buttons', async () => {
    const { api } = await setup(true, true)
    get('agent-input').value = 'Kasa question'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    const kasaTranscript = [...get('agent-messages').childNodes]
    get('agent-input').value = 'Kasa draft'
    get('agent-tax-mode').click()
    await flush()
    expect(get('agent-messages').childNodes).toHaveLength(0)
    expect(get('agent-input').value).toBe('')
    get('agent-input').value = 'Tax question'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    const taxTranscript = [...get('agent-messages').childNodes]
    get('agent-input').value = 'Tax draft'
    get('agent-security-mode').click()
    expect(get('agent-messages').childNodes).toEqual(kasaTranscript)
    expect(get('agent-input').value).toBe('Kasa draft')
    get('agent-tax-mode').click()
    await flush()
    expect(get('agent-messages').childNodes).toEqual(taxTranscript)
    expect(get('agent-input').value).toBe('Tax draft')
    expect(api.reset).not.toHaveBeenCalled()
    expect(api.chat).toHaveBeenCalledWith('Kasa question', undefined)
    expect(api.commercialistaChat).toHaveBeenCalledWith('Tax question', expect.any(String))
  })
  it('New chat clears only the selected assistant, including its draft', async () => {
    const { api } = await setup(true, true)
    get('agent-input').value = 'Keep Kasa draft'
    get('agent-tax-mode').click()
    await flush()
    get('agent-input').value = 'Tax question'
    await get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    get('agent-input').value = 'Remove tax draft'
    await get('agent-clear').click()
    expect(get('agent-input').value).toBe('')
    expect(get('agent-messages').childNodes).toHaveLength(0)
    expect(api.reset).not.toHaveBeenCalled()
    get('agent-security-mode').click()
    expect(get('agent-input').value).toBe('Keep Kasa draft')
    await get('agent-clear').click()
    expect(api.reset).toHaveBeenCalledOnce()
    expect(get('agent-input').value).toBe('')
  })
  it('restores drafts for each profile/year without carrying them to a different selection', async () => {
    const { scope, dispatch } = await setup(true, true)
    get('agent-tax-mode').click()
    await flush()
    get('agent-input').value = 'My 2026 question'
    scope.taxpayers[0].profile.taxYear = 2025
    dispatch('kasa:tax-scope-idle')
    await flush()
    expect(get('agent-input').value).toBe('')
    get('agent-input').value = 'My 2025 question'
    scope.taxpayers[0].profile.taxYear = 2026
    dispatch('kasa:tax-scope-idle')
    await flush()
    expect(get('agent-input').value).toBe('My 2026 question')
    expect(get('agent-note').textContent).toContain('2026')
  })
  it('does not cancel an ongoing answer just because the same selection refreshed', async () => {
    const { api, dispatch, emit } = await setup(true, true)
    let finish!: (answer: string) => void
    api.commercialistaChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    get('agent-tax-mode').click()
    await flush()
    get('agent-input').value = 'Explain'
    const pending = get('agent-form').onsubmit!({ preventDefault: vi.fn() })
    dispatch('kasa:tax-scope-busy')
    dispatch('kasa:tax-scope-idle')
    await flush()
    expect(api.stop).not.toHaveBeenCalled()
    expect(get('agent-security-mode').disabled).toBe(true)
    emit({ type: 'turn-end', text: '' })
    finish('Completed tax answer')
    await pending
    expect(get('agent-messages').childNodes.at(-1)?.childNodes.at(-1)?.textContent).toBe(
      'Completed tax answer'
    )
    expect(get('agent-security-mode').disabled).toBe(false)
  })
  it('retains a draft when scope reads fail, and restores sending after retry', async () => {
    const { taxScope, dispatch } = await setup(true, true)
    get('agent-tax-mode').click()
    await flush()
    get('agent-input').value = 'Keep this through errors'
    taxScope.get.mockRejectedValueOnce(new Error('Database unavailable'))
    dispatch('kasa:tax-scope-idle')
    await flush()
    expect(get('agent-input').value).toBe('Keep this through errors')
    expect(get('agent-send').disabled).toBe(true)
    get('tax-ai-open').click()
    await flush()
    expect(get('agent-input').value).toBe('Keep this through errors')
    expect(get('agent-send').disabled).toBe(false)
  })
})
