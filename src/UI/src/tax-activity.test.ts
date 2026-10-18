import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeTaxScope,
  recordKeys,
  type ScopeCommand,
  type TaxActivitySnapshot
} from '../../shared/tax-scope'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const pageIds = new Map(
  [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)].map((match) => [
    match[2],
    match[1].toUpperCase()
  ])
)

class Element {
  value = ''
  hidden = false
  disabled = false
  dataset: Record<string, string> = {}
  children: Element[] = []
  private text = ''
  onclick?: () => unknown
  onchange?: () => unknown
  onsubmit?: (event: Event) => unknown
  focus = vi.fn()
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  set textContent(text: string) {
    this.text = text
    this.children = []
  }
  set innerHTML(_text: string) {
    throw new Error('Activity must render saved data as text')
  }
  append(...children: Element[]): void {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]): void {
    this.text = ''
    this.children = children
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag.toUpperCase() ? [child] : []),
      ...child.querySelectorAll(tag)
    ])
  }
}

function fixtures(): TaxActivitySnapshot {
  const profile = {
    version: 1 as const,
    country: 'IT' as const,
    taxYear: 2026,
    userType: 'personal' as const,
    personalRegime: 'dichiarativo' as const,
    businessType: null,
    businessRegime: null,
    recordsCoverage: 'unknown' as const
  }
  return {
    scope: {
      version: 1,
      databaseId: 'activity-fixture',
      activeTaxpayerId: 'me',
      taxpayers: [
        { id: 'me', label: 'My profile', profile },
        { id: 'other', label: 'Other profile', profile }
      ],
      accounts: [
        {
          id: 'other-account',
          taxpayerId: 'other',
          label: 'Other',
          kind: 'unknown',
          ownershipBps: 10000
        }
      ],
      assets: [
        {
          id: 'btc',
          canonicalId: 'btc',
          symbol: 'BTC',
          network: 'bitcoin',
          decimals: 8,
          environment: 'live'
        }
      ],
      assignments: [{ recordKey: 'payment:2', accountId: 'other-account', assetId: 'btc' }],
      recordProfiles: [{ recordKey: 'payment:3', taxpayerId: 'other' }]
    },
    snapshot: {
      invoices: [
        {
          id: 'request',
          client: 'Saved client',
          amount: 1,
          received: 1,
          createdAt: 1,
          expiresAt: 2,
          rgbInvoice: 'saved-invoice',
          recipientId: 'saved-recipient',
          state: 'Paid'
        }
      ],
      payments: [
        {
          nodeIdx: 1,
          direction: 'in',
          invoiceId: 'request',
          txid: 'fixture-in',
          received: 1,
          status: 'settled',
          blockTime: 1
        },
        {
          nodeIdx: 2,
          direction: 'out',
          invoiceId: null,
          txid: 'fixture-out',
          received: 2,
          status: 'settled',
          blockTime: 1
        },
        {
          nodeIdx: 3,
          direction: 'out',
          invoiceId: null,
          txid: null,
          received: 3,
          status: 'failed',
          blockTime: 1
        }
      ],
      proposals: []
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function setup(data = fixtures()): Promise<{
  data: TaxActivitySnapshot
  get: (id: string) => Element
  getScope: ReturnType<typeof vi.fn<() => Promise<TaxActivitySnapshot['scope']>>>
  organise: ReturnType<typeof vi.fn<() => Promise<TaxActivitySnapshot>>>
  change: ReturnType<typeof vi.fn<(command: ScopeCommand) => Promise<TaxActivitySnapshot['scope']>>>
  forbidden: ReturnType<typeof vi.fn>
  dispatchEvent: (event: Event) => boolean
  click: () => Promise<void>
}> {
  vi.resetModules()
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    if (!pageIds.has(id)) throw new Error(`Missing real page element ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(pageIds.get(id)!))
    return elements.get(id)!
  }
  get('tax-source-form').hidden = true
  get('tax-activity-filter').value = 'profile'
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const dispatchEvent = (event: Event): boolean => {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
    return true
  }
  const forbidden = vi.fn(() => {
    throw new Error('Activity must not access wallets, AI or mutate payments')
  })
  const getScope = vi
    .fn<() => Promise<TaxActivitySnapshot['scope']>>()
    .mockImplementation(async () => structuredClone(data.scope))
  const change = vi
    .fn<(command: ScopeCommand) => Promise<TaxActivitySnapshot['scope']>>()
    .mockImplementation(async (command) => {
      data.scope = changeTaxScope(
        data.scope,
        command,
        null,
        recordKeys(data.snapshot),
        'fixture-id'
      )
      return structuredClone(data.scope)
    })
  const organise = vi.fn(async () => structuredClone(data))
  const windowFixture = {
    taxScope: { organise, get: getScope, change },
    kasa: {
      onChanged: vi.fn(() => vi.fn()),
      snapshot: forbidden,
      status: forbidden,
      send: forbidden
    },
    dispatchEvent,
    addEventListener: (name: string, listener: (event: Event) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    }
  }
  for (const name of ['wallet', 'agent', 'security'])
    Object.defineProperty(windowFixture, name, { get: forbidden })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal('document', {
    getElementById: get,
    createElement: (tag: string) => new Element(tag.toUpperCase())
  })
  await import('./tax-activity')
  await flush()
  return {
    data,
    get,
    getScope,
    organise,
    change,
    forbidden,
    dispatchEvent,
    click: async () => {
      get('tax-activity-link-profile').onclick?.()
      await flush()
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('link saved activity to the selected taxpayer', () => {
  it('drains the queued app-profile refresh when its earlier database response arrives after the switch', async () => {
    const data = fixtures()
    data.scope.recordProfiles!.push({ recordKey: 'payment:1', taxpayerId: 'me' })
    const f = await setup(data)
    expect(f.get('tax-activity-rows').textContent).toContain('My profile')
    const previous = structuredClone(data)
    let resolve!: (value: TaxActivitySnapshot) => void
    f.organise.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes
      })
    )
    f.get('tax-activity-refresh').onclick?.()
    await flush()
    f.get('view-tax').dataset.appProfileBusy = 'true'
    f.dispatchEvent(new Event('kasa:app-profile-busy'))
    data.scope.activeTaxpayerId = 'other'
    f.dispatchEvent(new CustomEvent('kasa:app-profile-updated', { detail: { scope: data.scope } }))
    f.get('view-tax').dataset.appProfileBusy = 'false'
    f.dispatchEvent(new Event('kasa:app-profile-busy'))
    resolve(previous)
    await flush()
    expect(f.organise).toHaveBeenCalledTimes(3)
    expect(f.get('tax-activity-rows').textContent).toContain('Other profile')
    expect(f.get('tax-activity-rows').textContent).not.toContain('My profile')
    expect(f.change).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it.each(['appProfileDirty', 'appProfileBusy', 'taxSetupDirty'])(
    'blocks linking while %s is active',
    async (flag) => {
      const f = await setup()
      f.get('view-tax').dataset[flag] = 'true'
      f.dispatchEvent(
        new Event(
          flag === 'taxSetupDirty'
            ? 'kasa:tax-setup-dirty'
            : flag === 'appProfileDirty'
              ? 'kasa:app-profile-dirty'
              : 'kasa:app-profile-busy'
        )
      )
      expect(f.get('tax-activity-link-profile').disabled).toBe(true)
      await f.click()
      expect(f.change).not.toHaveBeenCalled()
      expect(f.forbidden).not.toHaveBeenCalled()
    }
  )

  it('links only unowned saved invoices and payments without inventing account or asset details', async () => {
    const f = await setup()
    const before = structuredClone(f.data)
    expect(f.get('tax-activity-link-profile').disabled).toBe(false)
    await f.click()
    expect(f.change).toHaveBeenCalledWith({
      kind: 'link-records',
      taxpayerId: 'me',
      recordKeys: ['invoice:request', 'payment:1']
    })
    expect(f.data.scope.recordProfiles).toEqual([
      { recordKey: 'payment:3', taxpayerId: 'other' },
      { recordKey: 'invoice:request', taxpayerId: 'me' },
      { recordKey: 'payment:1', taxpayerId: 'me' }
    ])
    expect(f.data.snapshot).toEqual(before.snapshot)
    expect(f.data.scope.accounts).toEqual(before.scope.accounts)
    expect(f.data.scope.assets).toEqual(before.scope.assets)
    expect(f.data.scope.assignments).toEqual(before.scope.assignments)
    expect(f.get('tax-activity-link-profile').disabled).toBe(true)
    expect(f.get('tax-activity-rows').textContent).toContain('My profile')
    expect(f.get('tax-activity-rows').textContent).toContain('Account and asset details needed')
    expect(f.get('tax-activity-summary').textContent).toContain('0 without a profile')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('preserves records linked elsewhere after the original view was loaded', async () => {
    const f = await setup()
    f.data.scope.recordProfiles!.push({ recordKey: 'payment:1', taxpayerId: 'other' })
    await f.click()
    expect(f.change).toHaveBeenCalledWith({
      kind: 'link-records',
      taxpayerId: 'me',
      recordKeys: ['invoice:request']
    })
    expect(f.data.scope.recordProfiles).toContainEqual({
      recordKey: 'payment:1',
      taxpayerId: 'other'
    })
  })

  it('rejects a stale active taxpayer before writing', async () => {
    const f = await setup()
    f.data.scope.activeTaxpayerId = 'other'
    await f.click()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('tax-activity-status').textContent).toContain('selected profile changed')
    expect(f.get('view-tax').dataset.activityEditing).toBe('false')
  })

  it('rejects a stale database before writing', async () => {
    const f = await setup()
    f.data.scope.databaseId = 'other-database'
    await f.click()
    expect(f.change).not.toHaveBeenCalled()
  })

  it.each(['enrichmentDirty', 'taxQuestionsDirty', 'taxBasisDirty', 'scopeBusy'])(
    'protects open %s work',
    async (flag) => {
      const f = await setup()
      f.get('view-tax').dataset[flag] = 'true'
      f.dispatchEvent(new CustomEvent('kasa:tax-scope-busy'))
      expect(f.get('tax-activity-link-profile').disabled).toBe(true)
      await f.click()
      expect(f.getScope).not.toHaveBeenCalled()
      expect(f.change).not.toHaveBeenCalled()
    }
  )

  it('protects an open source form', async () => {
    const f = await setup()
    f.get('tax-source-form').hidden = false
    await f.click()
    expect(f.change).not.toHaveBeenCalled()
  })

  it('disables the action when there is no selected profile', async () => {
    const fixture = fixtures()
    delete fixture.scope.activeTaxpayerId
    const f = await setup(fixture)
    expect(f.get('tax-activity-link-profile').disabled).toBe(true)
    await f.click()
    expect(f.change).not.toHaveBeenCalled()
  })

  it('keeps profile navigation locked until a failed write ends, with all saved data preserved', async () => {
    const f = await setup()
    const before = structuredClone(f.data)
    let reject: (reason: Error) => void = () => undefined
    f.change.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectSave) => {
          reject = rejectSave
        })
    )
    await f.click()
    expect(f.get('view-tax').dataset.activityEditing).toBe('true')
    expect(f.get('tax-activity-link-profile').disabled).toBe(true)
    reject(new Error('Fixture write failed'))
    await flush()
    expect(f.get('view-tax').dataset.activityEditing).toBe('false')
    expect(f.get('tax-activity-link-profile').disabled).toBe(false)
    expect(f.get('tax-activity-status').textContent).toContain('Fixture write failed')
    expect(f.data).toEqual(before)
  })
})
