import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KasaSnapshot } from '../../preload/index.d'
import type { TaxDisposalBasis } from '../../shared/tax-disposal-basis'
import { emptyValuation } from '../../shared/tax-enrichment'
import {
  changeTaxScope,
  recordKeys,
  type ScopeCommand,
  type TaxScope
} from '../../shared/tax-scope'
import { createDisposalFacts } from './personal-disposal'
import { buildTaxReport } from './tax-report'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const pageElements = new Map(
  [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)].map((match) => [
    match[2],
    match[1].toUpperCase()
  ])
)

// The real controller and calculation use fixture data, with no browser or Electron process.
class Element {
  value = ''
  hidden = false
  disabled = false
  checked = false
  dataset: Record<string, string> = {}
  children: Element[] = []
  href = ''
  target = ''
  rel = ''
  listeners = new Map<string, (() => void)[]>()
  private text = ''
  onclick?: () => unknown
  onchange?: () => unknown
  onsubmit?: (event: Event) => unknown

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.text = value
    this.children = []
  }

  set innerHTML(_value: string) {
    throw new Error('Saved tax data must be rendered as text')
  }

  replaceChildren(...children: Element[]): void {
    this.text = ''
    this.children = children
    if (this.tagName === 'SELECT') this.value = children[0]?.value ?? ''
  }

  append(...children: Element[]): void {
    this.children.push(...children)
  }

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener()
  }
}

type Fixture = { scope: TaxScope; snapshot: KasaSnapshot }

function fixtures(): Fixture {
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
  const source = {
    id: 'saved-source',
    label: 'Saved database source',
    backend: 'wdk' as const,
    asset: {
      symbol: 'BTC',
      canonicalId: 'bitcoin',
      network: 'bitcoin',
      decimals: 8,
      environment: 'live' as const
    }
  }
  return {
    scope: {
      version: 1,
      databaseId: 'disposal-ui-fixture',
      activeTaxpayerId: 'selected',
      taxpayers: [
        { id: 'selected', label: 'Selected taxpayer', profile },
        { id: 'other', label: 'Other taxpayer', profile: { ...profile } }
      ],
      accounts: [
        {
          id: 'selected-account',
          taxpayerId: 'selected',
          label: 'Selected account',
          ownershipBps: 10000,
          kind: 'self-custody',
          sourceId: source.id
        },
        {
          id: 'other-account',
          taxpayerId: 'other',
          label: 'Other account',
          ownershipBps: 10000,
          kind: 'provider',
          sourceId: source.id
        }
      ],
      assets: [{ id: 'asset', ...source.asset }],
      assignments: [
        { recordKey: 'payment:1', accountId: 'selected-account', assetId: 'asset' },
        { recordKey: 'payment:2', accountId: 'other-account', assetId: 'asset' }
      ],
      enrichments: [
        {
          recordKey: 'payment:1',
          accountId: 'selected-account',
          assetId: 'asset',
          classification: 'sale',
          valuation: {
            eur: '1000',
            date: '2026-05-10',
            source: 'Saved sale statement',
            reference: 'sale-1'
          },
          fee: {
            status: 'none',
            amount: '',
            assetId: '',
            purpose: '',
            reference: '',
            valuation: emptyValuation()
          },
          relatedRecordKey: ''
        }
      ]
    },
    snapshot: {
      invoices: [],
      proposals: [],
      payments: [1, 2].map((nodeIdx) => ({
        nodeIdx,
        direction: 'out',
        invoiceId: null,
        received: 1,
        receivedRaw: 100000000,
        status: 'settled',
        txid: `saved-disposal-${nodeIdx}`,
        blockTime: Date.parse('2026-05-10T10:00:00Z') / 1000,
        source
      }))
    }
  }
}

function basisFor(data: Fixture): TaxDisposalBasis {
  return {
    taxpayerId: 'selected',
    taxYear: 2026,
    recordKey: 'payment:1',
    facts: createDisposalFacts(data.scope, data.snapshot, 'payment:1'),
    transactionKind: 'fiat-sale',
    costBasisEur: '600',
    reference: 'LIFO allocation schedule',
    reviewed: true
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(initial = fixtures()) {
  vi.resetModules()
  const data = structuredClone(initial)
  const original = structuredClone(initial)
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    const tag = pageElements.get(id)
    if (!tag) throw new Error(`Disposal element is missing from index.html: ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(tag))
    return elements.get(id)!
  }
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const dispatchEvent = vi.fn((event: Event) => {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
    return true
  })
  const forbidden = vi.fn(() => {
    throw new Error('Disposal review must not access wallets, AI or write original ledger records')
  })
  const getScope = vi.fn<() => Promise<TaxScope>>().mockImplementation(async () => data.scope)
  const getSnapshot = vi
    .fn<() => Promise<KasaSnapshot>>()
    .mockImplementation(async () => data.snapshot)
  const change = vi
    .fn<(command: ScopeCommand) => Promise<TaxScope>>()
    .mockImplementation(async (command) => {
      if (command.kind !== 'disposal-basis')
        throw new Error('Only disposal cost metadata may change')
      data.scope = changeTaxScope(
        data.scope,
        command,
        null,
        recordKeys(data.snapshot),
        'fixture-id'
      )
      return data.scope
    })
  const allowOnly = <T extends object>(value: T): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        if (!Reflect.has(target, key)) return forbidden()
        return Reflect.get(target, key, receiver)
      }
    })
  const windowFixture = allowOnly({
    kasa: allowOnly({ snapshot: getSnapshot }),
    taxScope: allowOnly({ get: getScope, change }),
    dispatchEvent,
    addEventListener: (name: string, callback: (event: Event) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback])
    }
  })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal('document', {
    getElementById: get,
    createElement: (tag: string): Element => new Element(tag.toUpperCase())
  })
  const controller = await import('./personal-disposal-ui')
  const render = (scope = data.scope, snapshot = data.snapshot): void => {
    const report = buildTaxReport(scope, snapshot)
    if (!report) throw new Error('The fixture must have a selected taxpayer')
    controller.updatePersonalDisposal(scope, snapshot, report)
  }
  render()
  const edit = (id: string, value: string | boolean): void => {
    if (typeof value === 'boolean') get(id).checked = value
    else get(id).value = value
    get('tax-basis-form').emit('input')
  }
  return {
    get,
    data,
    original,
    render,
    controller,
    forbidden,
    getScope,
    getSnapshot,
    change,
    dispatchEvent,
    edit,
    draft: (): void => {
      edit('tax-basis-kind', 'fiat-sale')
      edit('tax-basis-cost', '600')
      edit('tax-basis-reference', 'LIFO allocation schedule')
      edit('tax-basis-reviewed', true)
    },
    submit: async (): Promise<void> => {
      await get('tax-basis-form').onsubmit?.(new Event('submit', { cancelable: true }))
      await flush()
    },
    emit: (type: string, detail: unknown = undefined): void => {
      dispatchEvent(new CustomEvent(type, { detail }))
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('personal Bitcoin disposal controller', () => {
  it('renders scoped saved records without reading another API or inventing zero costs', async () => {
    const f = await setup()

    expect(f.get('tax-personal-context').textContent).toContain('Selected taxpayer · 2026')
    expect(f.get('tax-basis-record').children.map((option) => option.value)).toEqual(['payment:1'])
    expect(f.get('tax-basis-cost').value).toBe('')
    expect(f.get('tax-personal-summary').textContent).toContain('Not yet estimable')
    expect(f.get('tax-personal-summary').textContent).not.toContain('0.00 EUR')
    expect(f.get('tax-personal-excluded').textContent).toContain('1 excluded')
    expect(f.getScope).not.toHaveBeenCalled()
    expect(f.getSnapshot).not.toHaveBeenCalled()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it('rechecks the saved database and writes only scoped cost metadata', async () => {
    const f = await setup()
    f.draft()
    f.edit('tax-basis-reference', '  LIFO allocation schedule  ')

    await f.submit()

    expect(f.getScope).toHaveBeenCalledTimes(1)
    expect(f.getSnapshot).toHaveBeenCalledTimes(1)
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'disposal-basis',
      basis: basisFor(f.original)
    })
    expect(f.data.snapshot).toEqual(f.original.snapshot)
    expect({ ...f.data.scope, disposalBases: undefined }).toEqual({
      ...f.original.scope,
      disposalBases: undefined
    })
    expect(f.get('tax-personal-summary').textContent).toContain('400.00 EUR')
    expect(f.get('tax-personal-summary').textContent).toContain('132.00 EUR')
    expect(f.get('tax-personal-status').textContent).toContain('Provisional')
    expect(f.get('tax-basis-status').textContent).toContain('Payment records are unchanged')
    expect(f.get('view-tax').dataset.taxBasisDirty).toBe('false')
    expect(
      f.dispatchEvent.mock.calls.some(([event]) => event.type === 'kasa:tax-scope-updated')
    ).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('loads a saved cost review and leaves its evidence unchanged during rendering', async () => {
    const data = fixtures()
    data.scope.disposalBases = [basisFor(data)]
    const f = await setup(data)

    expect(f.get('tax-basis-kind').value).toBe('fiat-sale')
    expect(f.get('tax-basis-cost').value).toBe('600')
    expect(f.get('tax-basis-reviewed').checked).toBe(true)
    expect(f.get('tax-personal-summary').textContent).toContain('132.00 EUR')
    expect(f.get('tax-personal-method').textContent).toContain('2026-10-18')
    expect(f.data).toEqual(f.original)
    expect(f.change).not.toHaveBeenCalled()
  })

  it('requires a supported saved purpose before allowing cost review', async () => {
    const data = fixtures()
    data.scope.enrichments![0].classification = 'unknown'
    const f = await setup(data)

    expect(f.get('tax-basis-form').hidden).toBe(true)
    expect(f.get('tax-basis-save').disabled).toBe(true)
    expect(f.get('tax-basis-details').disabled).toBe(false)
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
  })

  it('requires renewed confirmation when the evidence refers to older saved facts', async () => {
    const data = fixtures()
    data.scope.disposalBases = [basisFor(data)]
    data.scope.enrichments![0].valuation.eur = '1200'
    const f = await setup(data)

    expect(f.get('tax-basis-cost').value).toBe('600')
    expect(f.get('tax-basis-reference').value).toBe('LIFO allocation schedule')
    expect(f.get('tax-basis-reviewed').checked).toBe(false)
    expect(f.get('tax-basis-status').textContent).toContain('changed')
    expect(f.get('tax-personal-summary').textContent).toContain('Not yet estimable')
    expect(f.data).toEqual(f.original)
    expect(f.change).not.toHaveBeenCalled()
  })

  it.each(['country', 'year', 'regime'] as const)(
    'keeps unsupported %s results unavailable, not zero',
    async (unsupported) => {
      const data = fixtures()
      if (unsupported === 'country') data.scope.taxpayers[0].profile.country = 'other'
      if (unsupported === 'year') data.scope.taxpayers[0].profile.taxYear = 2024
      if (unsupported === 'regime') data.scope.taxpayers[0].profile.personalRegime = 'amministrato'
      const f = await setup(data)

      expect(f.get('tax-personal-status').textContent).toContain('outside the supported')
      expect(f.get('tax-personal-summary').textContent).toContain('Unsupported')
      expect(f.get('tax-personal-summary').textContent).not.toContain('0.00 EUR')
      expect(f.get('tax-basis-form').hidden).toBe(true)
      expect(f.get('tax-basis-save').disabled).toBe(true)
      await f.submit()
      expect(f.getScope).not.toHaveBeenCalled()
      expect(f.getSnapshot).not.toHaveBeenCalled()
      expect(f.change).not.toHaveBeenCalled()
    }
  )

  it('locks record navigation and related editors until a draft is discarded', async () => {
    const f = await setup()
    f.draft()
    expect(f.get('view-tax').dataset.taxBasisDirty).toBe('true')
    expect(f.get('tax-basis-record').disabled).toBe(true)
    expect(f.get('tax-basis-details').disabled).toBe(true)
    f.get('tax-basis-record').value = 'payment:2'
    f.get('tax-basis-record').onchange?.()
    f.get('tax-basis-details').onclick?.()

    expect(f.get('tax-basis-record').value).toBe('payment:1')
    expect(f.get('tax-basis-cost').value).toBe('600')
    expect(
      f.dispatchEvent.mock.calls.some(([event]) => event.type === 'kasa:tax-review-record')
    ).toBe(false)
    f.get('tax-basis-discard').onclick?.()
    expect(f.get('tax-basis-cost').value).toBe('')
    expect(f.get('view-tax').dataset.taxBasisDirty).toBe('false')
    expect(f.get('tax-basis-record').disabled).toBe(false)
    expect(f.change).not.toHaveBeenCalled()
  })

  it('opens the existing saved record editor without changing data', async () => {
    const f = await setup()
    f.get('tax-basis-details').onclick?.()
    const event = f.dispatchEvent.mock.calls
      .map(([entry]) => entry as CustomEvent)
      .find((entry) => entry.type === 'kasa:tax-review-record')
    expect(event?.detail).toEqual({ taxpayerId: 'selected', recordKey: 'payment:1' })
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('preserves a draft across an identical refresh and a temporary unavailable context', async () => {
    const f = await setup()
    f.draft()
    f.render(structuredClone(f.data.scope), structuredClone(f.data.snapshot))
    expect(f.get('tax-basis-cost').value).toBe('600')
    f.controller.clearPersonalDisposal()
    expect(f.get('tax-basis-cost').value).toBe('600')
    expect(f.get('tax-basis-save').disabled).toBe(true)
    expect(f.get('tax-personal-summary').hidden).toBe(true)
    await f.submit()
    expect(f.getScope).not.toHaveBeenCalled()
    f.render()
    expect(f.get('tax-basis-save').disabled).toBe(false)
    expect(f.get('tax-basis-reference').value).toBe('LIFO allocation schedule')
  })

  it.each(['profile', 'year', 'database', 'payment', 'enrichment', 'cost review'] as const)(
    'rejects a stale %s read before writing while retaining the draft',
    async (changed) => {
      const f = await setup()
      f.draft()
      f.data.scope = structuredClone(f.data.scope)
      f.data.snapshot = structuredClone(f.data.snapshot)
      if (changed === 'profile') f.data.scope.activeTaxpayerId = 'other'
      if (changed === 'year') f.data.scope.taxpayers[0].profile.taxYear = 2025
      if (changed === 'database') f.data.scope.databaseId = 'other-database'
      if (changed === 'payment') f.data.snapshot.payments[0].receivedRaw = 50000000
      if (changed === 'enrichment') f.data.scope.enrichments![0].valuation.eur = '1200'
      if (changed === 'cost review')
        f.data.scope.disposalBases = [{ ...basisFor(f.data), reference: 'Saved in another view' }]

      await f.submit()

      expect(f.getScope).toHaveBeenCalledTimes(1)
      expect(f.getSnapshot).toHaveBeenCalledTimes(1)
      expect(f.change).not.toHaveBeenCalled()
      expect(f.get('tax-basis-cost').value).toBe('600')
      expect(f.get('tax-basis-reference').value).toBe('LIFO allocation schedule')
      expect(f.get('tax-basis-status').textContent).toContain('changed')
      expect(f.get('view-tax').dataset.taxBasisDirty).toBe('true')
    }
  )

  it('hides an obsolete summary and blocks saving when refreshed facts change', async () => {
    const f = await setup()
    f.draft()
    const next = structuredClone(f.data.snapshot)
    next.payments[0].status = 'pending'
    f.render(f.data.scope, next)

    expect(f.get('tax-personal-summary').hidden).toBe(true)
    expect(f.get('tax-basis-save').disabled).toBe(true)
    expect(f.get('tax-basis-discard').disabled).toBe(false)
    expect(f.get('tax-basis-reference').value).toBe('LIFO allocation schedule')
    await f.submit()
    expect(f.getScope).not.toHaveBeenCalled()
    expect(f.change).not.toHaveBeenCalled()
  })

  it('hides the old subtotal when another disposal changes during an unrelated cost draft', async () => {
    const data = fixtures()
    data.scope.assignments[1].accountId = 'selected-account'
    data.scope.enrichments!.push({
      ...structuredClone(data.scope.enrichments![0]),
      recordKey: 'payment:2'
    })
    data.scope.disposalBases = [
      basisFor(data),
      {
        ...basisFor(data),
        recordKey: 'payment:2',
        facts: createDisposalFacts(data.scope, data.snapshot, 'payment:2')
      }
    ]
    const f = await setup(data)
    expect(f.get('tax-personal-summary').textContent).toContain('264.00 EUR')
    f.edit('tax-basis-cost', '500')
    const refreshed = structuredClone(f.data.snapshot)
    refreshed.payments[1].status = 'pending'

    f.render(f.data.scope, refreshed)

    for (const id of [
      'tax-personal-summary',
      'tax-personal-reasons',
      'tax-personal-rows',
      'tax-personal-excluded'
    ])
      expect(f.get(id).hidden).toBe(true)
    expect(f.get('tax-basis-cost').value).toBe('500')
    expect(f.get('tax-basis-record').value).toBe('payment:1')
    expect(f.get('tax-basis-save').disabled).toBe(false)
    expect(f.get('view-tax').dataset.taxBasisDirty).toBe('true')
    expect(f.change).not.toHaveBeenCalled()
  })

  it.each(['scope', 'snapshot', 'write'] as const)(
    'retains the draft after a failed %s operation',
    async (failed) => {
      const f = await setup()
      f.draft()
      if (failed === 'scope') f.getScope.mockRejectedValueOnce(new Error('Scope unavailable'))
      if (failed === 'snapshot')
        f.getSnapshot.mockRejectedValueOnce(new Error('Ledger unavailable'))
      if (failed === 'write') f.change.mockRejectedValueOnce(new Error('Metadata write failed'))

      await f.submit()

      if (failed !== 'write') expect(f.change).not.toHaveBeenCalled()
      expect(f.get('tax-basis-cost').value).toBe('600')
      expect(f.get('tax-basis-reviewed').checked).toBe(true)
      expect(f.get('tax-basis-status').textContent).toContain('Could not save')
      expect(f.get('view-tax').dataset.taxBasisDirty).toBe('true')
      expect(
        f.dispatchEvent.mock.calls.some(([event]) => event.type === 'kasa:tax-scope-updated')
      ).toBe(false)
      expect(f.data).toEqual(f.original)
    }
  )

  it('blocks saving and navigation during edits in other sections', async () => {
    const f = await setup()
    f.draft()
    for (const [flag, event] of [
      ['scopeBusy', 'kasa:tax-scope-busy'],
      ['enrichmentDirty', 'kasa:tax-enrichment-dirty'],
      ['activityEditing', 'kasa:tax-activity-editing'],
      ['taxQuestionsDirty', 'kasa:tax-questions-dirty']
    ]) {
      f.get('view-tax').dataset[flag] = 'true'
      f.emit(event)
      expect(f.get('tax-basis-save').disabled).toBe(true)
      expect(f.get('tax-basis-fields').disabled).toBe(true)
      await f.submit()
      expect(f.change).not.toHaveBeenCalled()
      f.get('view-tax').dataset[flag] = 'false'
      f.emit(event)
    }
    expect(f.getScope).not.toHaveBeenCalled()
    expect(f.getSnapshot).not.toHaveBeenCalled()
    expect(f.get('tax-basis-save').disabled).toBe(false)
  })

  it('rejects context changes during the fresh database read', async () => {
    const f = await setup()
    f.draft()
    const pending = deferred<KasaSnapshot>()
    f.getSnapshot.mockReturnValueOnce(pending.promise)
    const saving = f.submit()
    await flush()
    expect(f.get('tax-basis-save').disabled).toBe(true)
    expect(f.get('tax-basis-discard').disabled).toBe(true)
    f.render({ ...f.data.scope, activeTaxpayerId: 'other' })
    pending.resolve(f.data.snapshot)
    await saving

    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('tax-basis-reference').value).toBe('LIFO allocation schedule')
    expect(f.get('tax-basis-status').textContent).toContain('changed')
  })

  it('submits once while a metadata write is pending and keeps the ledger untouched', async () => {
    const f = await setup()
    f.draft()
    const pending = deferred<TaxScope>()
    f.change.mockReturnValueOnce(pending.promise)
    const saving = f.submit()
    await flush()
    await f.submit()
    expect(f.change).toHaveBeenCalledTimes(1)
    expect(f.get('tax-basis-fields').disabled).toBe(true)
    expect(f.get('tax-basis-discard').disabled).toBe(true)
    pending.resolve({ ...f.data.scope, disposalBases: [basisFor(f.data)] })
    await saving

    expect(f.get('view-tax').dataset.taxBasisDirty).toBe('false')
    expect(f.get('tax-basis-fields').disabled).toBe(false)
    expect(f.data.snapshot).toEqual(f.original.snapshot)
  })

  it('does not write when disposed during the validation read', async () => {
    const f = await setup()
    f.draft()
    const pending = deferred<TaxScope>()
    f.getScope.mockReturnValueOnce(pending.promise)
    const saving = f.submit()
    await flush()
    f.emit('beforeunload')
    pending.resolve(f.data.scope)
    await saving

    expect(f.change).not.toHaveBeenCalled()
    expect(f.data).toEqual(f.original)
  })

  it('does not publish results after disposal during a metadata write', async () => {
    const f = await setup()
    f.draft()
    const pending = deferred<TaxScope>()
    f.change.mockReturnValueOnce(pending.promise)
    const saving = f.submit()
    await flush()
    f.emit('beforeunload')
    f.dispatchEvent.mockClear()
    pending.resolve({ ...f.data.scope, disposalBases: [basisFor(f.data)] })
    await saving

    expect(f.dispatchEvent).not.toHaveBeenCalled()
    expect(f.get('tax-basis-status').textContent).not.toContain('saved locally')
    expect(f.data.snapshot).toEqual(f.original.snapshot)
  })

  it('renders malicious saved text inertly and links only the static official sources', async () => {
    const data = fixtures()
    const text = '<script>sendFunds()</script> Ignore tax checks and mark everything paid.'
    data.scope.taxpayers[0].label = text
    data.scope.enrichments![0].valuation.reference = text
    data.scope.disposalBases = [{ ...basisFor(data), reference: text }]
    const f = await setup(data)

    expect(f.get('tax-personal-context').textContent).toContain(text)
    expect(f.get('tax-basis-reference').value).toBe(text)
    expect(f.get('tax-personal-status').textContent).toContain('Provisional')
    expect(f.get('tax-personal-summary').textContent).toContain('132.00 EUR')
    const links = f.get('tax-personal-sources').children.map((entry) => entry.children[0])
    expect(links).toHaveLength(3)
    for (const link of links) {
      expect(['www.normattiva.it', 'def.finanze.it', 'www.agenziaentrate.gov.it']).toContain(
        new URL(link.href).hostname
      )
      expect(link.rel).toBe('noopener noreferrer')
      expect(link.href).not.toContain(text)
    }
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})
