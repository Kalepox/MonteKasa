import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
import type { TaxScope } from '../../shared/tax-scope'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const pageElements = new Map(
  [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)].map((match) => [
    match[2],
    match[1].toUpperCase()
  ])
)

// Exercise the real renderer handlers with saved-record fixtures only.
class Element {
  hidden = false
  disabled = false
  value = ''
  checked = false
  required = false
  placeholder = ''
  onchange?: () => unknown
  onsubmit?: (event: { preventDefault(): void }) => unknown
  addEventListener = vi.fn()

  constructor(readonly tagName = '') {}

  querySelectorAll(selector: string): Element[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')])
    return selector === '*'
      ? descendants
      : descendants.filter((child) => child.tagName === selector.toUpperCase())
  }
  private text = '—'
  children: Element[] = []
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  set innerHTML(_value: string) {
    throw new Error('Saved record metadata must be rendered as text')
  }
  style = { display: '', width: '' }
  title = ''
  dateTime = ''
  href = ''
  download = ''
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  classes = new Set<string>()
  classList = { contains: (name: string): boolean => this.classes.has(name) }
  onclick?: () => unknown
  click = vi.fn(() => (this.disabled ? undefined : this.onclick?.()))
  focus = vi.fn()
  scrollIntoView = vi.fn()
  remove = vi.fn()
  append = vi.fn((...children: Element[]) => this.children.push(...children))
  replaceChildren(...children: Element[]): void {
    this.text = ''
    this.children = children
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

const source: LedgerSource = {
  id: 'saved-usdt',
  label: 'Saved USDT source',
  backend: 'wdk',
  asset: {
    symbol: 'USDT',
    canonicalId: 'asset:usdt',
    network: 'ethereum',
    decimals: 6,
    environment: 'live'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function records(amount = 12.345678): KasaSnapshot {
  return {
    proposals: [],
    invoices: [
      {
        id: 'saved-invoice',
        client: 'Saved client',
        amount,
        received: 2.000001,
        state: 'Underpaid',
        createdAt: Date.parse('2026-05-10T10:00:00Z') / 1000,
        expiresAt: Date.parse('2026-05-11T10:00:00Z') / 1000,
        rgbInvoice: 'fixture-invoice',
        recipientId: 'fixture-recipient',
        source,
        amountRaw: Number(amount.toFixed(6).replace('.', '')),
        receivedRaw: 2000001
      }
    ],
    payments: [
      {
        nodeIdx: 7,
        direction: 'in',
        invoiceId: 'saved-invoice',
        received: 2.000001,
        status: 'settled',
        txid: 'saved-transaction',
        blockTime: Date.parse('2026-05-10T10:01:00Z') / 1000,
        source,
        receivedRaw: 2000001
      }
    ]
  }
}

function scopeFor(saved = records()): TaxScope {
  return {
    version: 1,
    databaseId: 'fixture-database',
    activeTaxpayerId: 'personal',
    taxpayers: [
      {
        id: 'personal',
        label: 'Personal profile',
        profile: {
          version: 1,
          country: 'IT',
          taxYear: 2026,
          userType: 'personal',
          personalRegime: 'dichiarativo',
          businessType: null,
          businessRegime: null,
          recordsCoverage: 'complete'
        }
      }
    ],
    accounts: [
      {
        id: 'personal-account',
        taxpayerId: 'personal',
        label: 'Personal account',
        kind: 'self-custody',
        ownershipBps: 10000
      }
    ],
    assets: [{ id: 'declared-usdt', ...source.asset }],
    assignments: [
      ...saved.invoices.map((invoice) => ({
        recordKey: `invoice:${invoice.id}`,
        accountId: 'personal-account',
        assetId: 'declared-usdt'
      })),
      ...saved.payments.map((payment) => ({
        recordKey: `payment:${payment.nodeIdx}`,
        accountId: 'personal-account',
        assetId: 'declared-usdt'
      }))
    ]
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(
  initial: Promise<KasaSnapshot> = Promise.resolve(records()),
  initialScope: TaxScope = scopeFor()
) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'))
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    const tag = pageElements.get(id)
    if (!tag) throw new Error(`Reports element is missing from index.html: ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(tag))
    return elements.get(id)!
  }
  get('view-tax').dataset.taxPage = 'overview'
  get('tax-reports-freshness').hidden = true
  type Listener = (event?: { detail: unknown }) => void
  const listeners = new Map<string, Listener[]>()
  const emit = (name: string, detail?: unknown): void => {
    for (const listener of listeners.get(name) ?? []) listener({ detail })
  }
  const unsubscribe = vi.fn()
  let changed = (): void => {}
  let mutated = (): void => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  const snapshot = vi.fn<() => Promise<KasaSnapshot>>().mockReturnValueOnce(initial)
  snapshot.mockResolvedValue(records())
  const status = vi.fn<() => unknown>(() => {
    throw new Error('Reports must not access wallet status')
  })
  const forbiddenAccess = vi.fn(() => {
    throw new Error('Reports must not access wallets, security actions or AI')
  })
  const getScope = vi.fn<() => Promise<TaxScope>>().mockResolvedValue(initialScope)
  const dispatchEvent = vi.fn((event: CustomEvent) => {
    emit(event.type, event.detail)
    return true
  })
  const windowFixture = {
    taxScope: { get: getScope, change: forbiddenAccess, organise: forbiddenAccess },
    taxProfile: { get: forbiddenAccess, save: forbiddenAccess },
    kasa: {
      snapshot,
      status,
      onChanged: vi.fn((callback: () => void) => {
        changed = callback
        return unsubscribe
      })
    },
    dispatchEvent,
    addEventListener: vi.fn((name: string, callback: (event?: { detail: unknown }) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback])
    })
  }
  for (const name of ['wallet', 'agent', 'security'])
    Object.defineProperty(windowFixture, name, { get: forbiddenAccess })
  const anchors: Element[] = []
  const blobs: Blob[] = []
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:fixture-export'
  })
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('document', {
    getElementById: get,
    body: new Element(),
    createElement: (tag: string): Element => {
      expect([
        'a',
        'tr',
        'th',
        'td',
        'small',
        'details',
        'summary',
        'p',
        'div',
        'span',
        'strong',
        'h3',
        'h4',
        'button',
        'article',
        'li',
        'ul',
        'dl',
        'dt',
        'dd',
        'option'
      ]).toContain(tag)
      const element = new Element(tag.toUpperCase())
      element.textContent = ''
      if (tag === 'a') anchors.push(element)
      return element
    }
  })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe = observe
      disconnect = disconnect
      constructor(callback: () => void) {
        mutated = callback
      }
    }
  )
  await import('./commercialista-reports')
  await flush()
  return {
    get,
    rows: (): Element[] => get('tax-report-groups').children,
    metric: (column: number): string =>
      get('tax-report-groups').children[0].children[column].textContent,
    snapshot,
    getScope,
    dispatchEvent,
    emit,
    status,
    forbiddenAccess,
    changed: (): void => changed(),
    mutate: (): void => mutated(),
    unload: (): void => emit('beforeunload'),
    unsubscribe,
    observe,
    disconnect,
    get anchors(): Element[] {
      // The estimator also renders source links; export assertions concern downloads only.
      return anchors.filter((anchor) => Boolean(anchor.download))
    },
    blobs,
    createObjectURL,
    revokeObjectURL
  }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('database-only Commercialista Reports', () => {
  it('loads its independent renderer module from the app page', () => {
    expect(html).toContain('<script type="module" src="/src/commercialista-reports.ts"></script>')
    expect(html).not.toContain('onclick="exportTaxCSV()"')
  })

  it('loads saved totals without accessing wallet status or AI and keeps records unchanged', async () => {
    const saved = records()
    const original = structuredClone(saved)
    for (const collection of [saved.invoices, saved.payments, saved.proposals]) {
      collection.forEach(Object.freeze)
      Object.freeze(collection)
    }
    Object.freeze(saved)
    const pending = deferred<KasaSnapshot>()
    const f = await setup(pending.promise)
    expect(f.get('commercialista-status').textContent).toContain(
      'Loading the selected profile and saved records'
    )
    expect(f.get('tax-reports-summary').getAttribute('aria-busy')).toBe('true')
    expect(f.get('tax-reports-refresh').disabled).toBe(false)
    expect(f.get('tax-reports-freshness').hidden).toBe(true)
    expect(f.get('tax-dashboard-content').hidden).toBe(true)
    expect(f.get('tax-dashboard-freshness').hidden).toBe(true)
    pending.resolve(saved)
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.metric(2)).toBe('2.000001 USDT1 record')
    expect(f.get('tax-underpaid').textContent).toBe('1')
    expect(f.get('tax-unsettled').textContent).toBe('0')
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
    expect(f.get('tax-reports-summary').getAttribute('aria-busy')).toBe('false')
    expect(f.get('tax-reports-freshness').hidden).toBe(false)
    expect(f.get('tax-reports-updated').dateTime).toBe('2026-10-18T10:00:00.000Z')
    expect(f.get('tax-reports-updated').textContent).not.toBe('—')
    expect(f.get('tax-dashboard-content').hidden).toBe(false)
    expect(f.get('tax-dashboard-context').textContent).toContain('Personal profile')
    expect(f.get('tax-dashboard-context').textContent).toContain('2026')
    expect(f.get('tax-dashboard-updated').dateTime).toBe(f.get('tax-reports-updated').dateTime)
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
    expect(saved).toEqual(original)
  })

  it('can refresh and export while wallet status would never resolve', async () => {
    const f = await setup()
    f.status.mockImplementation(() => new Promise(() => {}))
    f.snapshot.mockResolvedValue(records(45))
    f.get('tax-reports-refresh').click()
    await flush()
    expect(f.metric(1)).toBe('45.000000 USDT1 record')
    f.get('tax-reports-export').click()
    await flush()
    expect(f.anchors[0].click).toHaveBeenCalledOnce()
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('shows separate asset, network and test sources with settled directions kept separate', async () => {
    const saved = records()
    const bitcoin: LedgerSource = {
      ...source,
      id: 'saved-bitcoin',
      label: 'Saved Bitcoin source',
      asset: {
        ...source.asset,
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        decimals: 8
      }
    }
    const tron: LedgerSource = {
      ...source,
      id: 'saved-tron',
      asset: { ...source.asset, network: 'tron' }
    }
    const test: LedgerSource = {
      ...bitcoin,
      id: 'saved-test',
      asset: { ...bitcoin.asset, environment: 'test' }
    }
    saved.invoices.push({
      ...saved.invoices[0],
      id: 'btc-invoice',
      source: bitcoin,
      amountRaw: 123456789,
      receivedRaw: 100000001
    })
    saved.payments.push(
      { ...saved.payments[0], nodeIdx: 8, direction: 'out', receivedRaw: 3000000 },
      ...['pending', 'failed', 'unknown'].map((status, index) => ({
        ...saved.payments[0],
        nodeIdx: 9 + index,
        status,
        receivedRaw: 900000000
      })),
      { ...saved.payments[0], nodeIdx: 12, source: bitcoin, receivedRaw: 1 },
      { ...saved.payments[0], nodeIdx: 13, source: tron, receivedRaw: 4000000 },
      { ...saved.payments[0], nodeIdx: 14, source: test, receivedRaw: 500000000 }
    )
    const f = await setup(Promise.resolve(saved), scopeFor(saved))
    const [usdt, btc, otherNetwork, testRow] = f.rows()
    expect(f.rows()).toHaveLength(4)
    expect(usdt.children[0].textContent).toContain('USDT · ethereum')
    expect(usdt.children[0].textContent).toContain('Live environment (saved)')
    expect(usdt.children[0].textContent).toContain('Payment observations: 5 · Not settled: 3')
    expect(usdt.children.slice(1).map((cell) => cell.textContent)).toEqual([
      '12.345678 USDT1 record',
      '2.000001 USDT1 record',
      '3.000000 USDT1 record'
    ])
    expect(btc.children[0].textContent).toContain('BTC · bitcoin')
    expect(btc.children.slice(1).map((cell) => cell.textContent)).toEqual([
      '1.23456789 BTC1 record',
      '0.00000001 BTC1 record',
      '—'
    ])
    expect(otherNetwork.children[0].textContent).toContain('USDT · tron')
    expect(otherNetwork.children[2].textContent).toBe('4.000000 USDT1 record')
    expect(testRow.children[0].textContent).toContain('Test / demo')
    expect(testRow.children[2].textContent).toBe('5.00000000 BTC1 record')
    expect(f.get('tax-unsettled').textContent).toBe('3')
    expect(f.get('tax-year-status').textContent).toContain('2026')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('keeps unknown, conflicting and unsafe amounts visible without misleading totals', async () => {
    const saved = records()
    saved.payments = []
    saved.invoices = [
      { ...saved.invoices[0], id: 'unknown', source: undefined },
      {
        ...saved.invoices[0],
        id: 'unsafe',
        source: { ...source, id: 'unsafe-source' },
        amountRaw: Number.MAX_SAFE_INTEGER + 1
      },
      { ...saved.invoices[0], id: 'conflict-one', source },
      {
        ...saved.invoices[0],
        id: 'conflict-two',
        source: { ...source, asset: { ...source.asset, network: 'tron' } }
      }
    ]
    const f = await setup(Promise.resolve(saved), scopeFor(saved))
    const [unknown, unsafe, conflictOne, conflictTwo] = f.rows()
    expect(f.rows()).toHaveLength(4)
    expect(unknown.children[0].textContent).toContain('Asset not identified')
    expect(unknown.children[0].textContent).toContain('Unknown source')
    expect(unknown.children[0].textContent).toContain('no currency is assumed')
    expect(unknown.children[1].textContent).toBe('Not totalled1 record · 1 unavailable')
    expect(unsafe.children[1].textContent).toBe('Not totalled1 record · 1 unavailable')
    expect(unsafe.children[2].textContent).toBe('—')
    for (const row of [conflictOne, conflictTwo]) {
      expect(row.children[0].textContent).toContain('Conflicting saved source details')
      expect(row.children[1].textContent).toBe('Not totalled1 record · 1 unavailable')
      expect(row.children[2].textContent).toBe('—')
    }
    expect(f.get('tax-invoice-count').textContent).toBe('4')
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('renders saved source metadata as literal text, including markup-like values', async () => {
    const saved = records()
    const metadata: LedgerSource = {
      ...source,
      id: '<svg onload="sendFunds()">',
      label: '<img src=x onerror="sendFunds()">',
      asset: { ...source.asset, symbol: '<script>sendFunds()</script>', network: '<b>network</b>' }
    }
    saved.invoices[0].source = metadata
    saved.payments[0].source = metadata
    const f = await setup(Promise.resolve(saved), scopeFor(saved))
    expect(f.rows()).toHaveLength(1)
    const heading = f.rows()[0].children[0]
    expect(heading.textContent).toContain(metadata.label)
    expect(heading.textContent).toContain(metadata.id)
    expect(heading.textContent).toContain(metadata.asset.symbol)
    expect(heading.textContent).toContain(metadata.asset.network)
    expect(heading.children[1].children[0].textContent).toBe('Saved source details')
    expect(f.metric(1)).toBe(`12.345678 ${metadata.asset.symbol}1 record`)
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('shows an empty ledger without implying zero tax, even if proposals exist', async () => {
    const saved: KasaSnapshot = {
      invoices: [],
      payments: [],
      proposals: [
        {
          id: 'proposal',
          invoiceId: 'missing',
          kind: 'refund',
          amount: 10,
          reason: 'fixture',
          status: 'pending',
          txid: null,
          error: null
        }
      ]
    }
    const f = await setup(Promise.resolve(saved), scopeFor(saved))
    expect(f.get('commercialista-status').textContent).toContain(
      'No linked or assigned, dated records for this profile and year.'
    )
    expect(f.get('commercialista-status').textContent).toContain('do not mean zero tax is due')
    expect(f.get('tax-invoice-count').textContent).toBe('0')
    expect(f.rows()).toHaveLength(1)
    expect(f.rows()[0].textContent).toContain('No assigned, dated records in this year')
    expect(f.get('tax-reports-freshness').hidden).toBe(false)
  })

  it('keeps initial errors distinct from an empty ledger and allows a manual retry', async () => {
    const pending = deferred<KasaSnapshot>()
    const f = await setup(pending.promise)
    pending.reject(new Error('Database unavailable'))
    await flush()
    expect(f.get('commercialista-status').textContent).toContain(
      'Saved profile records could not be loaded.'
    )
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-reports-freshness').hidden).toBe(true)
    expect(f.get('tax-reports-summary').getAttribute('aria-busy')).toBe('false')
    expect(f.get('tax-dashboard-status').textContent).toContain('could not be loaded')
    expect(f.get('tax-dashboard-content').hidden).toBe(true)
    expect(f.get('tax-dashboard-freshness').hidden).toBe(true)
    f.get('tax-reports-refresh').click()
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
  })

  it('retains the previous summary and timestamp on refresh failure, then recovers', async () => {
    const f = await setup()
    const lastUpdated = f.get('tax-reports-updated').dateTime
    const pending = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(pending.promise)
    f.changed()
    expect(f.get('commercialista-status').textContent).toContain('previous summary remains visible')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    pending.reject(new Error('Database read failed'))
    await flush()
    expect(f.get('commercialista-status').textContent).toContain('summary may be out of date')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.get('tax-reports-updated').dateTime).toBe(lastUpdated)
    expect(f.get('tax-dashboard-updated').dateTime).toBe(lastUpdated)
    expect(f.get('tax-dashboard-content').hidden).toBe(false)
    expect(f.get('tax-dashboard-status').textContent).toContain('may be out of date')
    vi.setSystemTime(new Date('2026-10-18T10:05:00.000Z'))
    f.snapshot.mockResolvedValueOnce(records(30))
    f.changed()
    await flush()
    expect(f.metric(1)).toBe('30.000000 USDT1 record')
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
    expect(f.get('tax-reports-updated').dateTime).toBe('2026-10-18T10:05:00.000Z')
    expect(f.get('tax-dashboard-updated').dateTime).toBe('2026-10-18T10:05:00.000Z')
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores an older refresh that finishes with %s after a newer result',
    async (outcome) => {
      const f = await setup()
      const older = deferred<KasaSnapshot>()
      const newer = deferred<KasaSnapshot>()
      f.snapshot.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      f.changed()
      await flush()
      f.get('tax-reports-refresh').click()
      await flush()
      newer.resolve(records(80))
      await flush()
      if (outcome === 'resolve') older.resolve(records(10))
      else older.reject(new Error('Older request failed'))
      await flush()
      expect(f.metric(1)).toBe('80.000000 USDT1 record')
      expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
      expect(f.get('tax-reports-context').textContent).toContain('2026')
      expect(f.get('tax-reports-summary').getAttribute('aria-busy')).toBe('false')
    }
  )

  it('does not clear the newer loading state when an older request finishes', async () => {
    const f = await setup()
    const older = deferred<KasaSnapshot>()
    const newer = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    f.changed()
    await flush()
    f.get('tax-reports-refresh').click()
    await flush()
    older.resolve(records(10))
    await flush()
    expect(f.get('tax-reports-summary').getAttribute('aria-busy')).toBe('true')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    newer.resolve(records(90))
    await flush()
    expect(f.metric(1)).toBe('90.000000 USDT1 record')
  })

  it('refreshes when Reports becomes visible, including reopening the Tax screen', async () => {
    const f = await setup()
    const root = f.get('view-tax')
    expect(f.observe).toHaveBeenCalledWith(root, {
      attributes: true,
      attributeFilter: ['class', 'data-tax-page']
    })
    root.dataset.taxPage = 'reports'
    f.mutate()
    expect(f.snapshot).toHaveBeenCalledOnce()
    root.classes.add('on')
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    f.mutate()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    root.dataset.taxPage = 'activity'
    f.mutate()
    root.dataset.taxPage = 'reports'
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(3)
    root.classes.delete('on')
    f.mutate()
    root.classes.add('on')
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(4)
  })

  it('exports a fresh database snapshot and releases the download URL', async () => {
    const f = await setup()
    const pending = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(pending.promise)
    f.get('tax-reports-export').click()
    await flush()
    expect(f.get('tax-reports-export').disabled).toBe(true)
    f.get('tax-reports-export').click()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    pending.resolve(records(70))
    await flush()
    expect(f.anchors).toHaveLength(1)
    expect(f.anchors[0].href).toBe('blob:fixture-export')
    expect(f.anchors[0].download).toContain('2026')
    expect(f.anchors[0].download).toContain('undated')
    expect(f.anchors[0].click).toHaveBeenCalledOnce()
    expect(await f.blobs[0].text()).toContain('70.000000')
    expect(await f.blobs[0].text()).toContain('saved-invoice')
    expect(f.get('tax-reports-export-status').textContent).toContain('exported')
    expect(f.get('tax-reports-export').disabled).toBe(false)
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    vi.advanceTimersByTime(1000)
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-export')
  })

  it('keeps export failures separate from the summary and allows another export', async () => {
    const f = await setup()
    const summaryStatus = f.get('commercialista-status').textContent
    const lastUpdated = f.get('tax-reports-updated').dateTime
    f.snapshot.mockRejectedValueOnce(new Error('Export read failed'))
    f.get('tax-reports-export').click()
    await flush()
    expect(f.get('tax-reports-export-status').textContent).toContain('Export failed:')
    expect(f.createObjectURL).not.toHaveBeenCalled()
    expect(f.get('commercialista-status').textContent).toBe(summaryStatus)
    expect(f.get('tax-reports-updated').dateTime).toBe(lastUpdated)
    expect(f.get('tax-reports-export').disabled).toBe(false)
    f.get('tax-reports-export').click()
    await flush()
    expect(f.anchors[0].click).toHaveBeenCalledOnce()
    expect(f.get('tax-reports-export-status').textContent).toContain('exported')
  })

  it('unsubscribes and discards pending summary and export responses after unload', async () => {
    const f = await setup()
    const refresh = deferred<KasaSnapshot>()
    const exporting = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(exporting.promise).mockReturnValueOnce(refresh.promise)
    f.get('tax-reports-export').click()
    await flush()
    f.changed()
    await flush()
    f.unload()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.disconnect).toHaveBeenCalledOnce()
    const statusAtUnload = f.get('commercialista-status').textContent
    const exportStatusAtUnload = f.get('tax-reports-export-status').textContent
    refresh.resolve(records(99))
    exporting.resolve(records(99))
    await flush()
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.get('commercialista-status').textContent).toBe(statusAtUnload)
    expect(f.get('tax-reports-export-status').textContent).toBe(exportStatusAtUnload)
    expect(f.createObjectURL).not.toHaveBeenCalled()
    f.changed()
    f.get('tax-reports-refresh').click()
    expect(f.snapshot).toHaveBeenCalledTimes(3)
  })

  it('limits summary, rows and the primary export to the saved taxpayer and year', async () => {
    const saved = records()
    saved.invoices.push(
      { ...saved.invoices[0], id: 'business-invoice', client: 'Business only' },
      {
        ...saved.invoices[0],
        id: 'prior-year-invoice',
        client: 'Prior year',
        createdAt: Date.parse('2025-06-01T10:00:00Z') / 1000
      },
      { ...saved.invoices[0], id: 'unassigned-invoice', client: 'Unassigned only' }
    )
    saved.payments.push(
      { ...saved.payments[0], nodeIdx: 8, invoiceId: 'business-invoice', txid: 'business-payment' },
      { ...saved.payments[0], nodeIdx: 9, txid: 'undated-personal', blockTime: null },
      {
        ...saved.payments[0],
        nodeIdx: 10,
        txid: 'prior-year-payment',
        blockTime: Date.parse('2025-06-01T10:00:00Z') / 1000
      }
    )
    const scope = scopeFor(saved)
    scope.taxpayers.push({
      id: 'business',
      label: 'Business profile',
      profile: {
        ...scope.taxpayers[0].profile,
        userType: 'business',
        personalRegime: null,
        businessType: 'company',
        businessRegime: 'ordinary'
      }
    })
    scope.accounts.push({ ...scope.accounts[0], id: 'business-account', taxpayerId: 'business' })
    scope.assignments = scope.assignments
      .filter((assignment) => assignment.recordKey !== 'invoice:unassigned-invoice')
      .map((assignment) =>
        ['invoice:business-invoice', 'payment:8'].includes(assignment.recordKey)
          ? { ...assignment, accountId: 'business-account' }
          : assignment
      )
    const f = await setup(Promise.resolve(saved), scope)
    f.snapshot.mockResolvedValue(saved)
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-reports-context').textContent).toContain('2026')
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.metric(2)).toBe('2.000001 USDT1 record')
    const rows = f.get('tax-year-rows').textContent
    expect(rows).toContain('saved-invoice')
    expect(rows).toContain('Undated payment')
    expect(rows).not.toContain('Business only')
    expect(rows).not.toContain('Prior year')
    expect(rows).not.toContain('Unassigned only')
    expect(f.get('tax-reports-attention').textContent.toLowerCase()).toContain('unassigned')
    expect(f.get('tax-reports-attention').textContent.toLowerCase()).toContain('no usable date')
    f.get('tax-reports-export').click()
    await flush()
    const scopedCsv = await f.blobs[0].text()
    expect(scopedCsv).toContain('Personal profile')
    expect(scopedCsv).toContain('saved-invoice')
    expect(scopedCsv).toContain('Undated payment')
    expect(scopedCsv).not.toContain('Business only')
    expect(scopedCsv).not.toContain('Prior year')
    expect(scopedCsv).not.toContain('Unassigned only')
    f.get('tax-reports-all-export').click()
    await flush()
    const allCsv = await f.blobs[1].text()
    expect(f.anchors[1].download).toBe('tax-records-entire-database-all-dates.csv')
    expect(allCsv).toContain('Business only')
    expect(allCsv).toContain('Prior year')
    expect(allCsv).toContain('Unassigned only')
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it.each(['kasa:tax-scope-updated', 'kasa:tax-activity-updated', 'kasa:tax-profile-saved'])(
    'clears previous profile data immediately on %s and reloads the saved selection',
    async (event) => {
      const f = await setup()
      const scope = scopeFor()
      scope.taxpayers[0].label = 'New selected profile'
      scope.taxpayers[0].profile.taxYear = 2025
      const pending = deferred<TaxScope>()
      f.getScope.mockReturnValueOnce(pending.promise)
      f.emit(event)
      expect(f.get('tax-invoice-count').textContent).toBe('—')
      expect(f.get('tax-year-rows').children).toHaveLength(0)
      expect(f.get('tax-reports-export').disabled).toBe(true)
      expect(f.get('tax-reports-freshness').hidden).toBe(true)
      expect(f.get('tax-dashboard-content').hidden).toBe(true)
      expect(f.get('tax-dashboard-freshness').hidden).toBe(true)
      expect(f.get('tax-dashboard-months').children).toHaveLength(0)
      expect(f.get('tax-dashboard-estimates').children).toHaveLength(0)
      pending.resolve(scope)
      await flush()
      expect(f.get('tax-reports-context').textContent).toContain('New selected profile')
      expect(f.get('tax-reports-context').textContent).toContain('2025')
      expect(f.get('tax-invoice-count').textContent).toBe('0')
      expect(f.get('tax-year-rows').textContent).not.toContain('saved-invoice')
      expect(f.get('tax-dashboard-context').textContent).toContain('New selected profile')
      expect(f.get('tax-dashboard-context').textContent).toContain('2025')
    }
  )

  it('blocks reporting during profile changes and ignores responses for the previous selection', async () => {
    const f = await setup()
    const old = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(old.promise)
    f.changed()
    await flush()
    f.emit('kasa:tax-scope-busy')
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-reports-export').disabled).toBe(true)
    old.resolve(records(99))
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-dashboard-content').hidden).toBe(true)
    const callsWhileBusy = f.snapshot.mock.calls.length
    f.changed()
    f.emit('kasa:tax-scope-updated')
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(callsWhileBusy)
    const next = scopeFor()
    next.taxpayers[0].profile.taxYear = 2025
    f.getScope.mockResolvedValue(next)
    f.emit('kasa:tax-scope-idle')
    await flush()
    expect(f.get('tax-reports-context').textContent).toContain('2025')
    expect(f.get('tax-invoice-count').textContent).toBe('0')
    expect(f.get('tax-reports-export').disabled).toBe(false)
  })

  it('clears earlier totals when saved scope cannot be read, without a legacy profile fallback', async () => {
    const f = await setup()
    f.getScope.mockRejectedValueOnce(new Error('Scope unavailable'))
    f.changed()
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-year-rows').children).toHaveLength(0)
    expect(f.get('tax-reports-freshness').hidden).toBe(true)
    expect(f.get('tax-reports-export').disabled).toBe(true)
    expect(f.get('commercialista-status').textContent).toContain('Scope unavailable')
    expect(f.get('tax-dashboard-status').textContent).toContain('Scope unavailable')
    expect(f.get('tax-dashboard-content').hidden).toBe(true)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it.each(['no selection', 'unknown selection'])(
    'keeps the all-database export available with %s and never substitutes all-profile totals',
    async (condition) => {
      const scope = scopeFor()
      if (condition === 'no selection') delete scope.activeTaxpayerId
      else scope.activeTaxpayerId = 'missing-profile'
      const f = await setup(Promise.resolve(records()), scope)
      expect(f.get('tax-invoice-count').textContent).toBe('—')
      expect(f.get('tax-year-rows').children).toHaveLength(0)
      expect(f.get('tax-reports-export').disabled).toBe(true)
      expect(f.get('tax-reports-all-export').disabled).toBe(false)
      expect(f.get('tax-dashboard-content').hidden).toBe(true)
      expect(f.get('tax-dashboard-status').textContent).toContain('Choose or create')
      f.get('tax-reports-all-export').click()
      await flush()
      expect(f.anchors[0].download).toBe('tax-records-entire-database-all-dates.csv')
      expect(await f.blobs[0].text()).toContain('saved-invoice')
      expect(f.forbiddenAccess).not.toHaveBeenCalled()
    }
  )

  it('shows partial or unknown ownership without multiplying the saved amounts', async () => {
    const scope = scopeFor()
    scope.accounts[0].ownershipBps = 5000
    const f = await setup(Promise.resolve(records()), scope)
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.metric(2)).toBe('2.000001 USDT1 record')
    expect(f.get('tax-reports-ownership').textContent.toLowerCase()).toContain('ownership')
    expect(f.get('tax-reports-ownership').textContent).toMatch(/partial|share|50/i)
    const next = structuredClone(scope)
    next.accounts[0].ownershipBps = null
    f.getScope.mockResolvedValue(next)
    f.emit('kasa:tax-scope-updated')
    await flush()
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.get('tax-reports-ownership').textContent.toLowerCase()).toContain('unknown')
  })

  it.each(['year', 'assignments', 'database'])(
    'rejects an export when the saved %s changes during the database read',
    async (change) => {
      const f = await setup()
      const saved = deferred<KasaSnapshot>()
      f.snapshot.mockReturnValueOnce(saved.promise)
      f.get('tax-reports-export').click()
      await flush()
      const next = scopeFor()
      if (change === 'year') next.taxpayers[0].profile.taxYear = 2025
      else if (change === 'assignments') next.assignments = []
      else next.databaseId = 'another-database'
      f.getScope.mockResolvedValue(next)
      saved.resolve(records())
      await flush()
      expect(f.createObjectURL).not.toHaveBeenCalled()
      expect(f.get('tax-reports-export-status').textContent).toMatch(/changed|retry|again/i)
      expect(f.forbiddenAccess).not.toHaveBeenCalled()
    }
  )

  it('discards a pending scoped export as soon as a profile-change event arrives', async () => {
    const f = await setup()
    const saved = deferred<KasaSnapshot>()
    f.snapshot.mockReturnValueOnce(saved.promise)
    f.get('tax-reports-export').click()
    await flush()
    f.emit('kasa:tax-scope-busy')
    saved.resolve(records())
    await flush()
    expect(f.createObjectURL).not.toHaveBeenCalled()
    expect(f.get('tax-reports-export').disabled).toBe(true)
    expect(f.get('tax-invoice-count').textContent).toBe('—')
  })

  it('retains the successful report when an unchanged Activity refresh cannot read the database', async () => {
    const scope = scopeFor()
    const f = await setup(Promise.resolve(records()), scope)
    const updated = f.get('tax-reports-updated').dateTime
    f.snapshot.mockRejectedValueOnce(new Error('Database temporarily unavailable'))
    f.emit('kasa:tax-activity-updated', { scope: structuredClone(scope) })
    await flush()
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.get('tax-reports-updated').dateTime).toBe(updated)
    expect(f.get('tax-reports-freshness').hidden).toBe(false)
    expect(f.get('commercialista-status').textContent).toContain('may be out of date')
    expect(f.get('tax-dashboard-updated').dateTime).toBe(updated)
    expect(f.get('tax-dashboard-content').hidden).toBe(false)
    expect(f.get('tax-dashboard-status').textContent).toContain('may be out of date')
  })

  it('restores cached results after a scope refresh only when the saved declarations still match', async () => {
    const f = await setup()
    const updated = f.get('tax-reports-updated').dateTime
    f.emit('kasa:tax-scope-busy')
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    f.snapshot.mockRejectedValueOnce(new Error('Database unavailable after scope read'))
    f.emit('kasa:tax-scope-idle')
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.metric(1)).toBe('12.345678 USDT1 record')
    expect(f.get('tax-reports-updated').dateTime).toBe(updated)
    expect(f.get('commercialista-status').textContent).toContain('may be out of date')

    expect(f.get('tax-dashboard-updated').dateTime).toBe(updated)
    expect(f.get('tax-dashboard-content').hidden).toBe(false)
    expect(f.get('tax-dashboard-status').textContent).toContain('may be out of date')

    const next = scopeFor()
    next.taxpayers[0].profile.taxYear = 2025
    f.emit('kasa:tax-scope-busy')
    f.getScope.mockResolvedValue(next)
    f.snapshot.mockRejectedValueOnce(new Error('Different selection read failed'))
    f.emit('kasa:tax-scope-idle')
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-year-rows').children).toHaveLength(0)
    expect(f.get('tax-reports-freshness').hidden).toBe(true)
    expect(f.get('tax-reports-export').disabled).toBe(true)
    expect(f.get('tax-dashboard-content').hidden).toBe(true)
    expect(f.get('tax-dashboard-freshness').hidden).toBe(true)
  })

  it('does not restore an earlier report after ownership assignments change even in the same profile and year', async () => {
    const f = await setup()
    const next = scopeFor()
    next.assignments = []
    f.getScope.mockResolvedValue(next)
    f.snapshot.mockRejectedValueOnce(new Error('Database unavailable'))
    f.emit('kasa:tax-scope-updated')
    await flush()
    expect(f.get('tax-invoice-count').textContent).toBe('—')
    expect(f.get('tax-year-rows').children).toHaveLength(0)
    expect(f.get('tax-reports-export').disabled).toBe(true)
  })

  it('can review saved records for a non-Italian profile without claiming a tax calculation', async () => {
    const scope = scopeFor()
    scope.taxpayers[0].profile.country = 'other'
    const original = structuredClone(scope)
    const f = await setup(Promise.resolve(records()), scope)
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.get('tax-reports-export').disabled).toBe(false)
    f.get('tax-reports-export').click()
    await flush()
    const csv = await f.blobs[0].text()
    expect(csv).toContain('country: other')
    expect(csv).toContain('Not a tax calculation')
    expect(scope).toEqual(original)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })
})

describe('database-only Commercialista Overview', () => {
  it('shares the selected profile/year and counts payment observations without adding invoice requests', async () => {
    const saved = records()
    const bitcoin: LedgerSource = {
      ...source,
      id: 'saved-bitcoin',
      label: 'Saved Bitcoin source',
      asset: {
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        decimals: 8,
        environment: 'live'
      }
    }
    saved.invoices[0].receivedRaw = 900000000
    saved.invoices.push({ ...saved.invoices[0], id: 'extra-request' })
    saved.payments.push(
      {
        ...saved.payments[0],
        nodeIdx: 8,
        direction: 'out',
        receivedRaw: 3000000,
        blockTime: Date.parse('2026-06-10T10:00:00Z') / 1000
      },
      {
        ...saved.payments[0],
        nodeIdx: 9,
        status: 'pending',
        blockTime: Date.parse('2026-06-11T10:00:00Z') / 1000
      },
      {
        ...saved.payments[0],
        nodeIdx: 10,
        source: bitcoin,
        receivedRaw: 100000001,
        blockTime: Date.parse('2026-12-12T10:00:00Z') / 1000
      },
      { ...saved.payments[0], nodeIdx: 11, blockTime: null },
      {
        ...saved.payments[0],
        nodeIdx: 12,
        blockTime: Date.parse('2025-05-10T10:00:00Z') / 1000
      },
      { ...saved.payments[0], nodeIdx: 13, receivedRaw: 100000000 },
      { ...saved.payments[0], nodeIdx: 14, receivedRaw: 200000000 }
    )
    const scope = scopeFor(saved)
    scope.taxpayers.push({
      ...scope.taxpayers[0],
      id: 'other-person',
      label: 'Another taxpayer'
    })
    scope.accounts.push({ ...scope.accounts[0], id: 'other-account', taxpayerId: 'other-person' })
    scope.assets.push({ id: 'declared-bitcoin', ...bitcoin.asset })
    scope.assignments = scope.assignments
      .filter((assignment) => assignment.recordKey !== 'payment:13')
      .map((assignment) => {
        if (assignment.recordKey === 'payment:14')
          return { ...assignment, accountId: 'other-account' }
        if (assignment.recordKey === 'payment:10')
          return { ...assignment, assetId: 'declared-bitcoin' }
        return assignment
      })
    const original = structuredClone({ saved, scope })
    const f = await setup(Promise.resolve(saved), scope)
    expect(f.get('tax-dashboard-context').textContent).toBe(
      'Personal profile · Personal · 2026 · Europe/Rome calendar year'
    )
    expect(f.get('tax-dashboard-coverage').textContent).toContain(
      '4 dated payment records and 2 invoice requests'
    )
    expect(f.get('tax-dashboard-coverage').textContent).toContain('not been independently verified')
    expect(
      f.get('tax-dashboard-cards').children.map((card) => card.children[1].textContent)
    ).toEqual(['2', '1', '1'])
    const months = f.get('tax-dashboard-months').children
    expect(months).toHaveLength(12)
    expect(months[4].children.map((cell) => cell.textContent)).toEqual(['May', '1', '0', '0'])
    expect(months[5].children.map((cell) => cell.textContent)).toEqual(['Jun', '0', '1', '1'])
    expect(months[11].children.map((cell) => cell.textContent)).toEqual(['Dec', '1', '0', '0'])
    for (const column of [1, 2, 3]) {
      const count = months.reduce((sum, row) => sum + Number(row.children[column].textContent), 0)
      expect(String(count)).toBe(
        f.get('tax-dashboard-cards').children[column - 1].children[1].textContent
      )
    }
    const assets = f.get('tax-dashboard-assets').children
    expect(assets).toHaveLength(2)
    expect(assets[0].textContent).toContain('2.000001 USDT')
    expect(assets[0].textContent).toContain('3.000000 USDT')
    expect(assets[0].textContent).not.toContain('900.000000')
    expect(assets[0].textContent).not.toContain('100.000000')
    expect(assets[0].textContent).not.toContain('200.000000')
    expect(assets[1].textContent).toContain('1.00000001 BTC')
    expect(f.get('tax-dashboard-exclusions').textContent).toContain('1 undated records')
    expect(f.get('tax-dashboard-exclusions').textContent).toContain('1 records from other years')
    expect(f.get('tax-dashboard-exclusions').textContent).toContain('1 unassigned')
    expect(f.get('tax-dashboard-updated').dateTime).toBe(f.get('tax-reports-updated').dateTime)
    expect({ saved, scope }).toEqual(original)
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it.each(['personal', 'business'] as const)(
    'shows applicable %s requirements as unavailable estimates without reporting zero tax',
    async (userType) => {
      const scope = scopeFor()
      if (userType === 'business') {
        Object.assign(scope.taxpayers[0].profile, {
          userType,
          personalRegime: null,
          businessType: 'company',
          businessRegime: 'ordinary'
        })
      }
      const f = await setup(Promise.resolve(records()), scope)
      const estimates = f.get('tax-dashboard-estimates')
      expect(estimates.children.length).toBeGreaterThan(0)
      for (const card of estimates.children)
        expect(card.children[1].textContent).toBe('Not yet estimable')
      expect(estimates.textContent).not.toMatch(/€\s*0|0[,.]00\s*EUR/)
      if (userType === 'personal') {
        expect(estimates.textContent).toContain('Personal gains and losses')
        expect(estimates.textContent).toContain('Annual holding tax')
        expect(estimates.textContent).not.toContain('Business income')
        expect(estimates.children.some((card) => card.children[0].textContent === 'VAT')).toBe(
          false
        )
      } else {
        expect(estimates.textContent).toContain('Business income')
        expect(estimates.textContent).toContain('VAT')
        expect(estimates.textContent).not.toContain('Personal gains and losses')
      }
      expect(f.forbiddenAccess).not.toHaveBeenCalled()
    }
  )

  it('refreshes the shared data when Overview is entered or refreshed manually', async () => {
    const f = await setup()
    const root = f.get('view-tax')
    root.classes.add('on')
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    f.mutate()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    root.dataset.taxPage = 'reports'
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(3)
    root.dataset.taxPage = 'overview'
    f.mutate()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(4)
    f.snapshot.mockResolvedValueOnce(records(99))
    f.get('tax-dashboard-refresh').click()
    await flush()
    expect(f.snapshot).toHaveBeenCalledTimes(5)
    expect(f.metric(1)).toBe('99.000000 USDT1 record')
    expect(f.get('tax-dashboard-updated').dateTime).toBe(f.get('tax-reports-updated').dateTime)
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('renders untrusted saved profile and source labels as literal text in the Overview', async () => {
    const saved = records()
    const metadata: LedgerSource = {
      ...source,
      label: '<img src=x onerror="sendFunds()">',
      asset: { ...source.asset, symbol: '<script>sendFunds()</script>' }
    }
    saved.invoices[0].source = metadata
    saved.payments[0].source = metadata
    const scope = scopeFor(saved)
    scope.taxpayers[0].label = '<svg onload="sendFunds()">'
    const f = await setup(Promise.resolve(saved), scope)
    expect(f.get('tax-dashboard-context').textContent).toContain(scope.taxpayers[0].label)
    expect(f.get('tax-dashboard-assets').textContent).toContain(metadata.label)
    expect(f.get('tax-dashboard-assets').textContent).toContain(metadata.asset.symbol)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('opens review actions for the selected taxpayer and record without saving or sending funds', async () => {
    const f = await setup()
    const steps = f.get('tax-dashboard-next').children
    const review = steps.find((step) => step.children[0].textContent === 'Review record details')!
    expect(review).toBeDefined()
    review.children[2].click()
    expect(f.dispatchEvent).toHaveBeenCalledOnce()
    expect(f.dispatchEvent.mock.calls[0][0].type).toBe('kasa:tax-review-record')
    expect(f.dispatchEvent.mock.calls[0][0].detail).toEqual({
      taxpayerId: 'personal',
      recordKey: 'invoice:saved-invoice'
    })
    const checklist = steps.find(
      (step) => step.children[0].textContent === 'Review calculation requirements'
    )!
    checklist.children[2].click()
    expect(f.dispatchEvent.mock.calls[1][0].type).toBe('kasa:tax-navigate')
    expect(f.dispatchEvent.mock.calls[1][0].detail).toEqual({ target: 'scope-checklist-title' })
    expect(f.get('scope-checklist-title').focus).toHaveBeenCalledOnce()
    expect(f.get('scope-checklist-title').scrollIntoView).toHaveBeenCalledOnce()
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it.each(['enrichmentDirty', 'activityEditing', 'scopeBusy', 'taxBasisDirty'])(
    'blocks next-step navigation when %s is active without discarding edits',
    async (flag) => {
      const f = await setup()
      const root = f.get('view-tax')
      root.dataset[flag] = 'true'
      for (const step of f.get('tax-dashboard-next').children) step.children[2].click()
      expect(f.dispatchEvent).not.toHaveBeenCalled()
      expect(root.dataset[flag]).toBe('true')
      expect(f.get('tax-dashboard-status').textContent).toMatch(/Wait|Save or discard/)
      expect(f.forbiddenAccess).not.toHaveBeenCalled()
    }
  )
})

describe('Reports and focused questions share the saved-data context', () => {
  it.each([
    'scopeBusy',
    'enrichmentDirty',
    'activityEditing',
    'taxQuestionsDirty',
    'taxBasisDirty'
  ])(
    'explains why the dashboard focused-question action is blocked while %s is active',
    async (flag) => {
      const f = await setup()
      const root = f.get('view-tax')
      const buttons = f
        .get('tax-dashboard-estimates')
        .querySelectorAll('button')
        .filter((button) => button.textContent === 'Answer focused questions')
      expect(buttons).toHaveLength(2)
      const selectedCalculation = f.get('tax-questions-calculation').value
      f.get('tax-question-reference').value = 'Unsaved supporting reference'
      f.get('tax-question-notes').value = 'Unsaved preparation notes'
      root.dataset[flag] = 'true'
      for (const button of buttons) button.click()
      expect(f.dispatchEvent).not.toHaveBeenCalled()
      expect(f.get('tax-dashboard-status').textContent).toBe(
        flag === 'scopeBusy'
          ? 'Wait for the saved profile to finish loading.'
          : 'Save or discard your open record or preparation edits before opening another record or section.'
      )
      expect(root.dataset[flag]).toBe('true')
      expect(f.get('tax-question-reference').value).toBe('Unsaved supporting reference')
      expect(f.get('tax-question-notes').value).toBe('Unsaved preparation notes')
      expect(f.get('tax-questions-calculation').value).toBe(selectedCalculation)
      expect(f.get('tax-questions-title').focus).not.toHaveBeenCalled()
      expect(f.get('tax-questions-title').scrollIntoView).not.toHaveBeenCalled()
      expect(f.snapshot).toHaveBeenCalledOnce()
      expect(f.getScope).toHaveBeenCalledOnce()
      expect(f.forbiddenAccess).not.toHaveBeenCalled()
    }
  )

  it('renders focused questions from the same read and opens the relevant saved record', async () => {
    const f = await setup()
    expect(f.get('tax-questions-content').hidden).toBe(false)
    expect(f.get('tax-questions-context').textContent).toContain('Personal profile · 2026')
    expect(f.get('tax-questions-calculation').children.map((option) => option.value)).toEqual([
      'personal-gains',
      'holding-tax'
    ])
    expect(f.get('tax-question-records').textContent).toContain('Explain what happened · 2')
    expect(f.get('tax-question-records').textContent).toContain(
      'The app already has the recorded payment or invoice amount'
    )
    const buttons = f.get('tax-question-records').querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    buttons[0].click()
    const review = f.dispatchEvent.mock.calls.find(
      ([event]) => event.type === 'kasa:tax-review-record'
    )?.[0]
    expect(review?.detail).toEqual({
      taxpayerId: 'personal',
      recordKey: 'invoice:saved-invoice',
      section: 'purpose'
    })
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.getScope).toHaveBeenCalledOnce()
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('clears old questions with the Reports selection and repopulates only the newly saved year', async () => {
    const f = await setup()
    const changedScope = scopeFor()
    changedScope.taxpayers[0].profile.taxYear = 2025
    const pending = deferred<TaxScope>()
    f.getScope.mockReturnValueOnce(pending.promise)
    f.emit('kasa:tax-profile-saved')
    expect(f.get('tax-questions-content').hidden).toBe(true)
    expect(f.get('tax-question-records').children).toHaveLength(0)
    expect(f.get('tax-question-save').disabled).toBe(true)
    pending.resolve(changedScope)
    await flush()
    expect(f.get('tax-questions-content').hidden).toBe(false)
    expect(f.get('tax-questions-context').textContent).toContain('Personal profile · 2025')
    expect(f.get('tax-question-records').querySelectorAll('button')).toHaveLength(0)
    expect(f.get('tax-question-records').textContent).toContain('does not verify the records')
    expect(f.get('tax-invoice-count').textContent).toBe('0')
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    expect(f.getScope).toHaveBeenCalledTimes(2)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('keeps database Reports available while withholding unsupported country questions', async () => {
    const scope = scopeFor()
    scope.taxpayers[0].profile.country = 'other'
    const f = await setup(Promise.resolve(records()), scope)
    expect(f.get('tax-questions-content').hidden).toBe(true)
    expect(f.get('tax-questions-status').textContent).toContain('not supported for this country')
    expect(f.get('tax-question-save').disabled).toBe(true)
    expect(f.get('tax-reports-summary').hidden).toBe(false)
    expect(f.get('tax-invoice-count').textContent).toBe('1')
    expect(f.get('tax-reports-export').disabled).toBe(false)
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })
})

describe('Reports and the personal disposal estimator share saved database records', () => {
  function disposalFixture(): { saved: KasaSnapshot; scope: TaxScope } {
    const saved = records()
    saved.invoices = []
    saved.payments[0] = {
      ...saved.payments[0],
      direction: 'out',
      invoiceId: null,
      source: {
        ...source,
        id: 'saved-bitcoin',
        label: 'Saved Bitcoin source',
        asset: {
          symbol: 'BTC',
          canonicalId: 'bitcoin',
          network: 'bitcoin',
          decimals: 8,
          environment: 'live'
        }
      },
      receivedRaw: 10000000
    }
    const scope = scopeFor(saved)
    scope.accounts[0].sourceId = 'saved-bitcoin'
    scope.assets[0] = { id: 'declared-usdt', ...saved.payments[0].source!.asset }
    scope.enrichments = [
      {
        ...scope.assignments[0],
        classification: 'sale',
        valuation: {
          eur: '1000',
          date: '2026-05-10',
          source: 'Fixture proceeds statement',
          reference: 'Statement A'
        },
        fee: {
          status: 'none',
          amount: '',
          assetId: '',
          purpose: '',
          reference: '',
          valuation: { eur: '', date: '', source: '', reference: '' }
        },
        relatedRecordKey: ''
      }
    ]
    return { saved, scope }
  }

  it('uses one scope and snapshot read for Reports, questions and the disposal panel', async () => {
    const { saved, scope } = disposalFixture()
    const original = structuredClone({ saved, scope })
    const f = await setup(Promise.resolve(saved), scope)
    expect(f.get('tax-personal-content').hidden).toBe(false)
    expect(f.get('tax-personal-context').textContent).toContain('Personal profile · 2026')
    expect(f.get('tax-personal-rows').textContent).toContain('Payment 7')
    expect(f.get('tax-basis-record').value).toBe('payment:7')
    expect(f.get('tax-personal-status').textContent).toContain('Not yet estimable')
    expect(f.get('tax-personal-summary').textContent).not.toContain('0.00 EUR')
    expect(f.get('tax-questions-content').hidden).toBe(false)
    expect(f.get('tax-reports-context').textContent).toContain('Personal profile')
    expect(f.get('tax-personal-sources').querySelectorAll('a').length).toBeGreaterThan(0)
    expect(f.getScope).toHaveBeenCalledOnce()
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
    expect({ saved, scope }).toEqual(original)
  })

  it('clears the old disposal panel immediately when the selected profile/year changes', async () => {
    const { saved, scope } = disposalFixture()
    const f = await setup(Promise.resolve(saved), scope)
    const next = structuredClone(scope)
    next.taxpayers[0].label = 'New profile year'
    next.taxpayers[0].profile.taxYear = 2025
    const pending = deferred<TaxScope>()
    f.getScope.mockReturnValueOnce(pending.promise)
    f.snapshot.mockResolvedValue(saved)
    f.emit('kasa:tax-scope-updated')
    expect(f.get('tax-personal-content').hidden).toBe(true)
    expect(f.get('tax-personal-summary').hidden).toBe(true)
    expect(f.get('tax-basis-save').disabled).toBe(true)
    pending.resolve(next)
    await flush()
    expect(f.get('tax-personal-content').hidden).toBe(false)
    expect(f.get('tax-personal-context').textContent).toContain('New profile year · 2025')
    expect(f.get('tax-personal-rows').textContent).not.toContain('Payment 7')
    expect(f.get('tax-basis-form').hidden).toBe(true)
    expect(f.getScope).toHaveBeenCalledTimes(2)
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('restores the disposal panel from the same cached snapshot only after unchanged scope is confirmed', async () => {
    const { saved, scope } = disposalFixture()
    const f = await setup(Promise.resolve(saved), scope)
    f.emit('kasa:tax-scope-busy')
    expect(f.get('tax-personal-content').hidden).toBe(true)
    f.snapshot.mockRejectedValueOnce(new Error('Fixture database read unavailable'))
    f.emit('kasa:tax-scope-idle')
    await flush()
    expect(f.get('tax-personal-content').hidden).toBe(false)
    expect(f.get('tax-personal-context').textContent).toContain('Personal profile · 2026')
    expect(f.get('tax-personal-rows').textContent).toContain('Payment 7')
    expect(f.get('commercialista-status').textContent).toContain('may be out of date')
    expect(f.getScope).toHaveBeenCalledTimes(2)
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('navigates from Overview to the disposal estimator without a separate database read', async () => {
    const f = await setup()
    const button = f
      .get('tax-dashboard-estimates')
      .querySelectorAll('button')
      .find((item) => item.textContent === 'Review Bitcoin disposal estimate')
    expect(button).toBeDefined()
    button!.click()
    const navigations = f.dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'kasa:tax-navigate')
    expect(navigations).toHaveLength(1)
    expect(navigations[0].detail).toEqual({ target: 'tax-personal-title' })
    expect(f.get('tax-personal-title').focus).toHaveBeenCalledOnce()
    expect(f.get('tax-personal-title').scrollIntoView).toHaveBeenCalledOnce()
    expect(f.getScope).toHaveBeenCalledOnce()
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it.each([
    'scopeBusy',
    'enrichmentDirty',
    'activityEditing',
    'taxQuestionsDirty',
    'taxBasisDirty'
  ])('blocks disposal navigation while %s is active and preserves the open draft', async (flag) => {
    const f = await setup()
    const button = f
      .get('tax-dashboard-estimates')
      .querySelectorAll('button')
      .find((item) => item.textContent === 'Review Bitcoin disposal estimate')!
    f.get('tax-basis-cost').value = '45.12345678'
    f.get('view-tax').dataset[flag] = 'true'
    button.click()
    expect(f.dispatchEvent).not.toHaveBeenCalled()
    expect(f.get('tax-personal-title').focus).not.toHaveBeenCalled()
    expect(f.get('tax-personal-title').scrollIntoView).not.toHaveBeenCalled()
    expect(f.get('tax-dashboard-status').textContent).toMatch(/Wait|Save or discard/)
    expect(f.get('tax-basis-cost').value).toBe('45.12345678')
    expect(f.get('view-tax').dataset[flag]).toBe('true')
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
  })

  it('locks focused questions and their save/navigation handlers while a cost review is open', async () => {
    const f = await setup()
    const calculation = f.get('tax-questions-calculation').value
    const question = f.get('tax-question-prompt').textContent
    f.get('tax-basis-cost').value = 'Unsaved cost draft'
    f.get('view-tax').dataset.taxBasisDirty = 'true'
    f.emit('kasa:tax-basis-dirty', { dirty: true })
    expect(f.get('tax-question-fields').disabled).toBe(true)
    expect(f.get('tax-question-save').disabled).toBe(true)
    expect(f.get('tax-questions-calculation').disabled).toBe(true)
    for (const button of f.get('tax-question-records').querySelectorAll('button')) {
      expect(button.disabled).toBe(true)
      button.click()
    }
    f.emit('kasa:tax-open-questions', { calculationId: 'holding-tax' })
    await f.get('tax-question-form').onsubmit?.({ preventDefault: vi.fn() })
    await flush()
    expect(f.get('tax-questions-calculation').value).toBe(calculation)
    expect(f.get('tax-question-prompt').textContent).toBe(question)
    expect(f.get('tax-basis-cost').value).toBe('Unsaved cost draft')
    expect(f.get('tax-questions-title').focus).not.toHaveBeenCalled()
    expect(f.dispatchEvent).not.toHaveBeenCalled()
    expect(f.getScope).toHaveBeenCalledOnce()
    expect(f.snapshot).toHaveBeenCalledOnce()
    expect(f.forbiddenAccess).not.toHaveBeenCalled()
    f.get('view-tax').dataset.taxBasisDirty = 'false'
    f.emit('kasa:tax-basis-dirty', { dirty: false })
    expect(f.get('tax-question-fields').disabled).toBe(false)
    expect(f.get('tax-questions-calculation').disabled).toBe(false)
  })
})
