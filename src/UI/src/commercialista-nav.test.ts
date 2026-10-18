import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))

class Element {
  hidden = false
  textContent = ''
  dataset: Record<string, string> = {}
  querySelectorAll = vi.fn(() => [])
  focus = vi.fn()
}

// Exercise the navigation module without starting the app or reading saved data.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(initial: Record<string, string> = {}) {
  vi.resetModules()
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    if (!pageIds.has(id)) throw new Error(`Navigation element is missing from index.html: ${id}`)
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const root = get('view-tax')
  root.dataset = { ...initial }
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const dispatchEvent = (event: Event): void => {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
  }
  const forbidden = vi.fn(() => {
    throw new Error('Navigation must not read databases, access wallets or make changes')
  })
  const windowFixture = {
    dispatchEvent,
    addEventListener: vi.fn((name: string, callback: (event: Event) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback])
    })
  }
  for (const name of ['kasa', 'taxScope', 'taxProfile', 'wallet', 'agent'])
    Object.defineProperty(windowFixture, name, { get: forbidden })
  vi.stubGlobal('document', { getElementById: get })
  vi.stubGlobal('window', windowFixture)
  await import('./commercialista-nav')
  return {
    root,
    status: get('tax-navigation-status'),
    forbidden,
    update: (flag: string, value: boolean, event: string): void => {
      root.dataset[flag] = String(value)
      dispatchEvent(new CustomEvent(event, { detail: { dirty: value, editing: value } }))
    },
    emit: (event: string, dirty = false): void => {
      dispatchEvent(new CustomEvent(event, { detail: { dirty, editing: dirty } }))
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Commercialista unsaved changes navigation notice', () => {
  it('keeps the cost review notice when other editors emit clean events', async () => {
    const f = await setup()
    f.update('taxBasisDirty', true, 'kasa:tax-basis-dirty')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    f.update('enrichmentDirty', false, 'kasa:tax-enrichment-dirty')
    f.update('activityEditing', false, 'kasa:tax-activity-editing')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('unsaved cost review in Reports')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('reveals another pending editor when the cost review is saved or discarded', async () => {
    const f = await setup({ taxBasisDirty: 'true', taxQuestionsDirty: 'true' })
    expect(f.status.textContent).toContain('unsaved cost review')
    f.update('taxBasisDirty', false, 'kasa:tax-basis-dirty')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('preparation answer')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    expect(f.status.hidden).toBe(true)
    expect(f.status.textContent).toBe('')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('uses the saved cost draft flag rather than a stale clean event payload', async () => {
    const f = await setup({ taxBasisDirty: 'true' })
    f.emit('kasa:tax-basis-dirty', false)
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('unsaved cost review')
    f.root.dataset.taxBasisDirty = 'false'
    f.emit('kasa:tax-basis-dirty', true)
    expect(f.status.hidden).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('keeps the preparation notice when the scope editor subsequently emits a clean state', async () => {
    const f = await setup()
    f.update('taxQuestionsDirty', true, 'kasa:tax-questions-dirty')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('preparation answer in Reports')

    f.update('enrichmentDirty', false, 'kasa:tax-enrichment-dirty')

    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('preparation answer in Reports')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('retains record edit guidance when question and ownership editors emit clean events', async () => {
    const f = await setup()
    f.update('enrichmentDirty', true, 'kasa:tax-enrichment-dirty')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    f.update('activityEditing', false, 'kasa:tax-activity-editing')

    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('unsaved record details in Activity')
  })

  it('retains source ownership guidance while other editors are clean', async () => {
    const f = await setup()
    f.update('activityEditing', true, 'kasa:tax-activity-editing')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    f.update('enrichmentDirty', false, 'kasa:tax-enrichment-dirty')

    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('Finish or cancel source ownership in Activity')
  })

  it('reveals the next pending editor and hides the notice only after all editors are clean', async () => {
    const f = await setup({
      taxQuestionsDirty: 'true',
      enrichmentDirty: 'true',
      activityEditing: 'true'
    })
    expect(f.status.textContent).toContain('preparation answer')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('unsaved record details')

    f.update('enrichmentDirty', false, 'kasa:tax-enrichment-dirty')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('source ownership')

    f.update('activityEditing', false, 'kasa:tax-activity-editing')
    expect(f.status.hidden).toBe(true)
    expect(f.status.textContent).toBe('')
  })

  it('uses current editor flags rather than a stale or unrelated event payload', async () => {
    const f = await setup({ taxQuestionsDirty: 'true' })
    f.emit('kasa:tax-questions-dirty', false)
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('preparation answer')

    f.root.dataset.taxQuestionsDirty = 'false'
    f.emit('kasa:tax-enrichment-dirty', true)
    expect(f.status.hidden).toBe(true)
  })

  it('starts with no notice when every editor is clean', async () => {
    const f = await setup()
    expect(f.status.hidden).toBe(true)
    expect(f.status.textContent).toBe('')
    expect(f.root.dataset.taxPage).toBe('overview')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('keeps app identity edits visible until both profile editing and loading finish', async () => {
    const f = await setup({ appProfileDirty: 'true', appProfileBusy: 'true' })
    expect(f.status.textContent).toContain('finish loading or saving')
    f.update('appProfileBusy', false, 'kasa:app-profile-busy')
    expect(f.status.textContent).toContain('identity edits in Profile')
    f.update('taxQuestionsDirty', false, 'kasa:tax-questions-dirty')
    expect(f.status.hidden).toBe(false)
    f.update('appProfileDirty', false, 'kasa:app-profile-dirty')
    expect(f.status.hidden).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('does not independently change taxpayers through legacy profile selection events', async () => {
    const f = await setup()
    f.emit('kasa:tax-profile-select')
    expect(f.status.textContent).toContain('Choose another person or business in Profile')
    expect(f.status.hidden).toBe(false)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('explains how to keep or discard a history draft before changing the tax year', async () => {
    const f = await setup()
    f.update('taxHistoryDirty', true, 'kasa:tax-history-dirty')
    expect(f.status.hidden).toBe(false)
    expect(f.status.textContent).toContain('history answer')
    expect(f.status.textContent).toContain('tax years')
    f.update('taxHistoryDirty', false, 'kasa:tax-history-dirty')
    expect(f.status.hidden).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})
