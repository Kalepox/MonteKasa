import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/agent'

// Small DOM fixture: exercises the real UI handlers without adding a browser dependency.
class Element {
  hidden = false
  disabled = false
  textContent = ''
  value = ''
  innerHTML = ''
  onclick?: () => unknown
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>
  focus = vi.fn()
  append = vi.fn()
  setAttribute = vi.fn()
  addEventListener = vi.fn()
  replaceChildren = vi.fn()
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
  vi.stubGlobal('window', { agent: api, addEventListener: vi.fn() })
  await import('./agent')
  await flush()
  return { api, emit: (event: AgentEvent) => emit(event) }
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
    expect(get('tax-ai-status').textContent).toContain('tax chat is not available')
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
