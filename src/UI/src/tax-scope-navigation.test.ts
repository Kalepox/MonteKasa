import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KasaSnapshot } from '../../preload/index.d'
import {
  changeTaxScope,
  recordKeys,
  type ScopeCommand,
  type TaxScope
} from '../../shared/tax-scope'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const pageElements = new Map(
  [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)].map((match) => [
    match[2],
    match[1].toUpperCase()
  ])
)

// Only the DOM features used by the real scope renderer. No app or wallet starts.
class Element {
  value = ''
  hidden = false
  disabled = false
  required = false
  checked = false
  open = false
  tabIndex = 0
  dataset: Record<string, string> = {}
  children: Element[] = []
  private text = ''
  onchange?: () => void
  onclick?: () => void
  onsubmit?: (event: { preventDefault(): void }) => void
  focus = vi.fn()
  scrollIntoView = vi.fn()
  addEventListener = vi.fn()

  constructor(
    readonly tagName: string,
    readonly id = ''
  ) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }

  set textContent(text: string) {
    this.text = text
    this.children = []
  }

  set innerHTML(_html: string) {
    throw new Error('Saved scope values must be rendered as text')
  }

  replaceChildren(...children: Element[]): void {
    this.text = ''
    this.children = children
    if (this.tagName === 'SELECT') this.value = children[0]?.value ?? ''
  }

  append(...children: Element[]): void {
    this.children.push(...children)
  }
}

function fixtures(): { scope: TaxScope; snapshot: KasaSnapshot } {
  const profile = {
    version: 1 as const,
    country: 'IT' as const,
    taxYear: 2026,
    userType: 'personal' as const,
    personalRegime: 'dichiarativo' as const,
    businessType: null,
    businessRegime: null,
    recordsCoverage: 'complete' as const
  }
  return {
    scope: {
      version: 1,
      databaseId: 'navigation-fixture',
      activeTaxpayerId: 'selected',
      taxpayers: [
        { id: 'selected', label: 'Selected taxpayer', profile },
        { id: 'other', label: 'Other taxpayer', profile }
      ],
      accounts: [
        {
          id: 'first-account',
          taxpayerId: 'selected',
          label: 'First account',
          ownershipBps: 10000,
          kind: 'self-custody'
        },
        {
          id: 'second-account',
          taxpayerId: 'selected',
          label: 'Second account',
          ownershipBps: null,
          kind: 'self-custody'
        },
        {
          id: 'foreign-account',
          taxpayerId: 'other',
          label: 'Other taxpayer account',
          ownershipBps: 10000,
          kind: 'provider'
        }
      ],
      assets: [
        {
          id: 'first-asset',
          symbol: 'BTC',
          canonicalId: 'bitcoin',
          network: 'bitcoin',
          decimals: 8,
          environment: 'live'
        },
        {
          id: 'second-asset',
          symbol: 'USDT',
          canonicalId: 'asset:usdt',
          network: 'ethereum',
          decimals: 6,
          environment: 'test'
        }
      ],
      assignments: [
        { recordKey: 'payment:1', accountId: 'first-account', assetId: 'first-asset' },
        { recordKey: 'payment:2', accountId: 'second-account', assetId: 'second-asset' },
        { recordKey: 'payment:3', accountId: 'foreign-account', assetId: 'first-asset' }
      ]
    },
    snapshot: {
      invoices: [],
      proposals: [],
      payments: [1, 2, 3].map((nodeIdx) => ({
        nodeIdx,
        direction: 'in',
        invoiceId: null,
        received: 1,
        status: 'settled',
        txid: `saved-payment-${nodeIdx}`,
        blockTime: Date.parse('2026-05-10T10:00:00Z') / 1000
      }))
    }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(prepare?: (data: ReturnType<typeof fixtures>) => void) {
  vi.resetModules()
  const data = fixtures()
  prepare?.(data)
  const original = structuredClone(data)
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    const tag = pageElements.get(id)
    if (!tag) throw new Error(`Tax scope element is missing from index.html: ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(tag, id))
    return elements.get(id)!
  }
  const listeners = new Map<string, (event: Event) => void>()
  const dispatchEvent = vi.fn((event: Event) => {
    listeners.get(event.type)?.(event)
    return true
  })
  const forbidden = vi.fn(() => {
    throw new Error('Navigation must not write saved records or access wallets/AI')
  })
  const snapshot = vi.fn().mockResolvedValue(data.snapshot)
  const getScope = vi.fn().mockResolvedValue(data.scope)
  const change = vi.fn<(command: ScopeCommand) => Promise<TaxScope>>().mockImplementation(forbidden)
  const windowFixture = {
    kasa: { snapshot, status: forbidden, send: forbidden, wallet: forbidden },
    taxScope: { get: getScope, change, organise: forbidden },
    taxProfile: { get: forbidden, save: forbidden },
    dispatchEvent,
    addEventListener: vi.fn((name: string, callback: (event: Event) => void) => {
      listeners.set(name, callback)
    })
  }
  for (const name of ['wallet', 'agent', 'security'])
    Object.defineProperty(windowFixture, name, { get: forbidden })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal('document', {
    getElementById: get,
    createElement: (tag: string): Element => {
      expect(['option', 'li', 'details', 'summary', 'ul']).toContain(tag)
      return new Element(tag.toUpperCase())
    }
  })
  await import('./tax-scope')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(get('tax-scope-status').textContent).toContain('Saved information loaded')
  expect(get('view-tax').dataset.scopeBusy).toBe('false')
  dispatchEvent.mockClear()
  return {
    get,
    data,
    original,
    snapshot,
    getScope,
    change,
    forbidden,
    dispatchEvent,
    review: (
      taxpayerId: string,
      recordKey: string,
      section?: 'purpose' | 'value' | 'fees' | 'related'
    ): void => {
      windowFixture.dispatchEvent(
        new CustomEvent('kasa:tax-review-record', { detail: { taxpayerId, recordKey, section } })
      )
    },
    restrict: (): void => {
      get('scope-account').value = 'first-account'
      get('scope-account').onchange?.()
      get('scope-asset').value = 'first-asset'
      get('scope-asset').onchange?.()
      get('enrichment-record').value = 'payment:1'
      get('enrichment-record').onchange?.()
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Overview navigation into the saved tax record editor', () => {
  it('refreshes filters, counts and calculation requirements together while preserving the unsaved history answer', async () => {
    const f = await setup()
    f.restrict()
    expect(f.get('scope-record-counts').textContent).toContain(
      'Selection: 0 invoices, 1 payment observations'
    )
    expect(f.get('scope-completeness').textContent).not.toContain(
      'Confirm the ownership share for accounts marked unsure.'
    )
    expect(f.get('scope-completeness').textContent).not.toContain(
      'Test assets are excluded from monetary tax estimates.'
    )
    f.get('scope-history').value = 'incomplete'
    f.get('scope-history').onchange?.()
    f.review('selected', 'payment:2')

    expect(f.get('scope-account').value).toBe('')
    expect(f.get('scope-asset').value).toBe('')
    expect(f.get('scope-record-counts').textContent).toContain(
      'Selection: 0 invoices, 2 payment observations'
    )
    expect(f.get('scope-completeness').textContent).toContain(
      'Confirm the ownership share for accounts marked unsure.'
    )
    expect(f.get('scope-completeness').textContent).toContain(
      'Test assets are excluded from monetary tax estimates.'
    )
    expect(f.get('scope-completeness').textContent).toContain(
      'Declared complete history still needs reconciliation'
    )
    expect(f.get('scope-history').value).toBe('incomplete')
    expect(f.get('scope-history-saved').textContent).toContain('Unsaved answer')
    expect(f.get('enrichment-record').value).toBe('payment:2')
    expect(f.get('enrichment-record').children.map((option) => option.value)).toEqual([
      '',
      'payment:1',
      'payment:2'
    ])
    expect(f.get('enrichment-record-context').textContent).toContain('saved-payment-2')
    expect(f.get('enrichment-fields').hidden).toBe(false)
    expect(f.get('enrichment-title').focus).toHaveBeenCalledOnce()
    expect(f.get('enrichment-title').scrollIntoView).toHaveBeenCalledOnce()
    const navigation = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'kasa:tax-navigate') as CustomEvent
    expect(navigation.detail).toEqual({ target: 'enrichment-title' })
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.getScope).toHaveBeenCalledOnce()
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it.each([
    ['wrong taxpayer', 'other', 'payment:2'],
    ['foreign record', 'selected', 'payment:3'],
    ['missing record', 'selected', 'payment:999']
  ])('rejects a %s without changing the current editor', async (_condition, taxpayerId, key) => {
    const f = await setup()
    f.restrict()
    const counts = f.get('scope-record-counts').textContent
    const requirements = f.get('scope-completeness').textContent
    f.review(taxpayerId, key)
    expect(f.get('scope-account').value).toBe('first-account')
    expect(f.get('scope-asset').value).toBe('first-asset')
    expect(f.get('scope-record-counts').textContent).toBe(counts)
    expect(f.get('scope-completeness').textContent).toBe(requirements)
    expect(f.get('enrichment-record').value).toBe('payment:1')
    expect(f.get('enrichment-title').focus).not.toHaveBeenCalled()
    expect(f.dispatchEvent.mock.calls.some(([event]) => event.type === 'kasa:tax-navigate')).toBe(
      false
    )
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it.each(['enrichment', 'activity'])(
    'preserves open %s edits when a review event requests another record',
    async (editor) => {
      const f = await setup()
      f.restrict()
      if (editor === 'enrichment') {
        f.get('enrichment-classification').value = 'purchase'
        f.get('enrichment-classification').onchange?.()
        expect(f.get('view-tax').dataset.enrichmentDirty).toBe('true')
      } else f.get('view-tax').dataset.activityEditing = 'true'
      f.review('selected', 'payment:2')
      expect(f.get('enrichment-record').value).toBe('payment:1')
      expect(f.get('scope-account').value).toBe('first-account')
      expect(f.get('scope-asset').value).toBe('first-asset')
      if (editor === 'enrichment') {
        expect(f.get('enrichment-classification').value).toBe('purchase')
        expect(f.get('view-tax').dataset.enrichmentDirty).toBe('true')
      } else expect(f.get('view-tax').dataset.activityEditing).toBe('true')
      expect(f.get('enrichment-title').focus).not.toHaveBeenCalled()
      expect(f.forbidden).not.toHaveBeenCalled()
      expect(f.data).toEqual(f.original)
    }
  )
})

describe('Focused tax question navigation and enrichment refresh', () => {
  it('opens the EUR value and evidence sections together for a value question', async () => {
    const f = await setup()
    f.restrict()
    f.review('selected', 'payment:2', 'value')
    expect(f.get('enrichment-record').value).toBe('payment:2')
    expect(f.get('enrichment-value-section').open).toBe(true)
    expect(f.get('enrichment-evidence-section').open).toBe(true)
    expect(f.get('enrichment-fee-section').open).toBe(false)
    expect(f.get('enrichment-value-section').focus).toHaveBeenCalledOnce()
    expect(f.get('enrichment-value-section').scrollIntoView).toHaveBeenCalledOnce()
    const navigation = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'kasa:tax-navigate') as CustomEvent
    expect(navigation.detail).toEqual({ target: 'enrichment-value-section' })
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it('opens only the fee section for a fee question', async () => {
    const f = await setup()
    f.review('selected', 'payment:1', 'fees')
    expect(f.get('enrichment-record').value).toBe('payment:1')
    expect(f.get('enrichment-fee-section').open).toBe(true)
    expect(f.get('enrichment-value-section').open).toBe(false)
    expect(f.get('enrichment-evidence-section').open).toBe(false)
    expect(f.get('enrichment-fee-section').focus).toHaveBeenCalledOnce()
    const navigation = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'kasa:tax-navigate') as CustomEvent
    expect(navigation.detail).toEqual({ target: 'enrichment-fee-section' })
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it.each([
    ['taxQuestionsDirty', 'kasa:tax-questions-dirty'],
    ['taxBasisDirty', 'kasa:tax-basis-dirty']
  ])('locks navigation and enrichment writes while %s is active', async (flag, event) => {
    const f = await setup()
    f.restrict()
    f.get('view-tax').dataset[flag] = 'true'
    f.dispatchEvent(new CustomEvent(event, { detail: { dirty: true } }))
    for (const id of [
      'tax-scope-fields',
      'scope-taxpayer',
      'enrichment-record',
      'enrichment-fields',
      'tax-scope-refresh'
    ])
      expect(f.get(id).disabled).toBe(true)
    f.review('selected', 'payment:2', 'value')
    expect(f.get('enrichment-record').value).toBe('payment:1')
    expect(f.get('scope-account').value).toBe('first-account')
    expect(f.get('scope-asset').value).toBe('first-asset')
    expect(f.get('enrichment-value-section').open).toBe(false)
    expect(f.get('enrichment-value-section').focus).not.toHaveBeenCalled()
    f.get('enrichment-form').onsubmit?.({ preventDefault: vi.fn() })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
    f.get('view-tax').dataset[flag] = 'false'
    f.dispatchEvent(new CustomEvent(event, { detail: { dirty: false } }))
    expect(f.get('scope-taxpayer').disabled).toBe(false)
    expect(f.get('enrichment-fields').disabled).toBe(false)
  })

  it('publishes the updated scope after saving enrichment without changing the saved ledger', async () => {
    const f = await setup()
    f.change.mockImplementation(async (command) =>
      changeTaxScope(f.data.scope, command, null, recordKeys(f.data.snapshot), 'unused-id')
    )
    f.restrict()
    f.get('enrichment-classification').value = 'sale'
    f.get('enrichment-classification').onchange?.()
    f.get('enrichment-eur').value = '250.50'
    f.get('enrichment-date').value = '2026-05-10'
    f.get('enrichment-source').value = 'Saved statement'
    f.get('enrichment-evidence').value = 'Statement record 1'
    f.get('enrichment-fee-status').value = 'none'
    f.get('enrichment-form').onsubmit?.({ preventDefault: vi.fn() })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.change).toHaveBeenCalledOnce()
    expect(f.change.mock.calls[0][0]).toMatchObject({
      kind: 'enrich',
      enrichment: {
        recordKey: 'payment:1',
        accountId: 'first-account',
        assetId: 'first-asset',
        classification: 'sale'
      }
    })
    const updates = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'kasa:tax-scope-updated') as CustomEvent<{
      scope: TaxScope
    }>[]
    expect(updates).toHaveLength(1)
    expect(updates[0].detail.scope.enrichments?.[0]).toMatchObject({
      recordKey: 'payment:1',
      classification: 'sale',
      valuation: { eur: '250.50', reference: 'Statement record 1' },
      fee: { status: 'none' }
    })
    expect(f.get('view-tax').dataset.enrichmentDirty).toBe('false')
    expect(f.get('enrichment-status').textContent).toContain('Saved locally')
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data.snapshot).toEqual(f.original.snapshot)
    expect(f.data.scope).toEqual(f.original.scope)
  })
})

describe('Manual review of profile-only relationships', () => {
  const profileOnly = (data: ReturnType<typeof fixtures>): void => {
    data.scope.assignments = data.scope.assignments.filter(
      (entry) => entry.recordKey !== 'payment:1'
    )
    data.scope.recordProfiles = [{ recordKey: 'payment:1', taxpayerId: 'selected' }]
  }

  it('shows the linked taxpayer and removes only the profile relationship after explicit confirmation', async () => {
    const f = await setup(profileOnly)
    f.change.mockImplementation(async (command) =>
      changeTaxScope(f.data.scope, command, null, recordKeys(f.data.snapshot), 'unused-id')
    )
    f.get('scope-record').value = 'payment:1'
    f.get('scope-record').onchange?.()
    expect(f.get('scope-assignment-owner').textContent).toContain(
      'Currently linked to Selected taxpayer'
    )
    expect(f.get('scope-assignment-owner').textContent).toContain(
      'ownership details still need review'
    )
    expect(f.get('scope-replace-field').hidden).toBe(false)
    expect(f.get('scope-unassign').disabled).toBe(true)
    expect(f.get('scope-unassign').textContent).toBe('Remove profile link')
    f.get('scope-unassign').onclick?.()
    expect(f.change).not.toHaveBeenCalled()

    f.get('scope-replace-confirm').checked = true
    f.get('scope-replace-confirm').onchange?.()
    expect(f.get('scope-unassign').disabled).toBe(false)
    // A stale enabled button must not override the current confirmation value.
    f.get('scope-replace-confirm').checked = false
    f.get('scope-unassign').onclick?.()
    expect(f.change).not.toHaveBeenCalled()
    f.get('scope-replace-confirm').checked = true
    f.get('scope-unassign').onclick?.()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({ kind: 'unassign', recordKey: 'payment:1' })
    const updates = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'kasa:tax-scope-updated') as CustomEvent<{
      scope: TaxScope
    }>[]
    expect(updates.at(-1)?.detail.scope.recordProfiles).toEqual([])
    expect(updates.at(-1)?.detail.scope.assignments).toEqual(f.original.scope.assignments)
    expect(updates.at(-1)?.detail.scope.autoAssignmentExclusions).toContain('payment:1')
    expect(f.data.snapshot).toEqual(f.original.snapshot)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('requires replacement confirmation before moving another profile’s link into the selected account', async () => {
    const f = await setup((data) => {
      profileOnly(data)
      data.scope.recordProfiles![0].taxpayerId = 'other'
    })
    f.change.mockImplementation(async (command) =>
      changeTaxScope(f.data.scope, command, null, recordKeys(f.data.snapshot), 'unused-id')
    )
    f.get('scope-record').value = 'payment:1'
    f.get('scope-record').onchange?.()
    f.get('scope-assign-account').value = 'first-account'
    f.get('scope-assign-account').onchange?.()
    f.get('scope-assign-asset').value = 'first-asset'
    f.get('scope-assign-asset').onchange?.()
    expect(f.get('scope-assignment-owner').textContent).toContain(
      'Currently linked to Other taxpayer'
    )
    expect(f.get('scope-replace-confirm').required).toBe(true)
    expect(f.get('scope-assign-save').disabled).toBe(true)
    f.get('scope-assignment-form').onsubmit?.({ preventDefault: vi.fn() })
    expect(f.change).not.toHaveBeenCalled()

    f.get('scope-replace-confirm').checked = true
    f.get('scope-replace-confirm').onchange?.()
    expect(f.get('scope-assign-save').disabled).toBe(false)
    // Recheck confirmation on submit even if no change event refreshed controls.
    f.get('scope-replace-confirm').checked = false
    f.get('scope-assignment-form').onsubmit?.({ preventDefault: vi.fn() })
    expect(f.change).not.toHaveBeenCalled()
    f.get('scope-replace-confirm').checked = true
    f.get('scope-assignment-form').onsubmit?.({ preventDefault: vi.fn() })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'assign',
      recordKey: 'payment:1',
      accountId: 'first-account',
      assetId: 'first-asset'
    })
    expect(f.data.snapshot).toEqual(f.original.snapshot)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('lets the same profile add account and asset details without treating that as a profile change', async () => {
    const f = await setup(profileOnly)
    f.get('scope-record').value = 'payment:1'
    f.get('scope-record').onchange?.()
    f.get('scope-assign-account').value = 'first-account'
    f.get('scope-assign-account').onchange?.()
    f.get('scope-assign-asset').value = 'first-asset'
    f.get('scope-assign-asset').onchange?.()
    expect(f.get('scope-replace-confirm').required).toBe(false)
    expect(f.get('scope-assign-save').disabled).toBe(false)
    expect(f.get('scope-unassign').disabled).toBe(true)
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})
