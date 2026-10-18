import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppProfileCommand, AppProfileState } from '../../shared/app-profile'
import type { TaxProfile } from '../../shared/tax-profile'
import { newSetupDraft, setupDraftKey } from './tax-setup-flow'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const tags = new Map(
  [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/gi)].map((match) => [
    match[2],
    match[1].toUpperCase()
  ])
)

class Element {
  value = ''
  hidden = false
  disabled = false
  checked = false
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  children: Element[] = []
  private text = ''
  onclick?: () => unknown
  onchange?: (event: { target: Element }) => unknown
  oninput?: (event: { target: Element }) => unknown
  onsubmit?: (event: { preventDefault(): void }) => unknown
  focus = vi.fn()
  reportValidity = vi.fn(() => true)
  reset = vi.fn()
  constructor(
    readonly tagName: string,
    readonly id = ''
  ) {}
  get textContent(): string {
    return this.text + this.children.map((entry) => entry.textContent).join('')
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  get selectedOptions(): { textContent: string }[] {
    return [{ textContent: this.value }]
  }
  append(...children: Element[]): void {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]): void {
    this.text = ''
    this.children = children
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...((selector.startsWith('input[') && child.tagName === 'INPUT') ||
      child.tagName === selector.toUpperCase()
        ? [child]
        : []),
      ...child.querySelectorAll(selector)
    ])
  }
  querySelector(selector: string): Element | undefined {
    if (selector.includes(':checked'))
      return this.querySelectorAll('input').find((entry) => entry.checked)
    if (selector === '[value="forfettario"]')
      return this.children.find((entry) => entry.value === 'forfettario')
    return undefined
  }
}

const profile: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'incomplete'
}
function fixture(linked = true): AppProfileState {
  return {
    databaseId: 'fixture-db',
    activeProfileId: 'app-alice',
    legacyImported: true,
    profiles: [
      {
        id: 'app-alice',
        name: 'Alice',
        company: 'Alice Company',
        email: '',
        taxId: '',
        address: '',
        currency: 'EUR',
        taxpayerId: linked ? 'tax-alice' : null
      },
      {
        id: 'app-bob',
        name: 'Bob',
        company: '',
        email: '',
        taxId: '',
        address: '',
        currency: 'EUR',
        taxpayerId: 'tax-bob'
      }
    ],
    scope: {
      version: 1,
      databaseId: 'fixture-db',
      appProfileId: 'app-alice',
      activeTaxpayerId: linked ? 'tax-alice' : undefined,
      taxpayers: [
        {
          id: 'tax-alice',
          label: 'Alice',
          profile: { ...profile },
          yearProfiles: [{ ...profile, taxYear: 2025, personalRegime: 'amministrato' }]
        },
        { id: 'tax-bob', label: 'Bob', profile: { ...profile } },
        { id: 'legacy-deniz', label: 'Deniz', profile: { ...profile } }
      ],
      accounts: [],
      assets: [],
      assignments: []
    }
  }
}

// Exercise the real wizard without starting Electron or reading user data.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(
  initial = fixture(),
  saved = new Map<string, string>(),
  failLegacy = false,
  delayedLegacy?: {
    value: Promise<TaxProfile | null>
    imported(update: (next: AppProfileState) => void): void
  }
) {
  vi.resetModules()
  let state = structuredClone(initial)
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    if (!tags.has(id)) throw new Error(`Missing wizard markup: ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(tags.get(id)!, id))
    return elements.get(id)!
  }
  const el = (id: string): Element => get(`tax-profile-${id}`)
  const form = el('form')
  form.hidden = true
  const radios = ['personal', 'business'].map((value) => {
    const radio = new Element('INPUT')
    radio.value = value
    return radio
  })
  form.children = radios
  const forfait = new Element('OPTION')
  forfait.value = 'forfettario'
  el('regime').append(forfait)
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const events: Event[] = []
  const dispatchEvent = (event: Event): void => {
    events.push(event)
    if (event.type === 'kasa:tax-setup-opened') get('view-tax').dataset.setupActive = 'true'
    if (event.type === 'kasa:tax-setup-closed') delete get('view-tax').dataset.setupActive
    for (const listener of listeners.get(event.type) ?? []) listener(event)
  }
  const appGet = vi.fn(async () => structuredClone(state))
  const change = vi.fn(async (command: AppProfileCommand) => {
    const next = structuredClone(state)
    const app = next.profiles.find((entry) => entry.id === next.activeProfileId)!
    if (command.kind === 'save-tax') {
      if (!app.taxpayerId) app.taxpayerId = 'new-taxpayer'
      const taxpayer = next.scope.taxpayers.find((entry) => entry.id === app.taxpayerId)
      if (taxpayer) taxpayer.profile = command.profile
      else
        next.scope.taxpayers.push({ id: app.taxpayerId, label: app.name, profile: command.profile })
    } else if (command.kind === 'link-taxpayer') app.taxpayerId = command.taxpayerId
    next.scope.activeTaxpayerId = app.taxpayerId ?? undefined
    state = next
    return structuredClone(next)
  })
  const forbidden = vi.fn(() => {
    throw new Error(
      'Tax setup must not access wallets, ledger, AI, or independent taxpayer creation'
    )
  })
  const windowFixture = {
    appProfiles: { get: appGet, change },
    taxProfile: {
      get: vi.fn(async () => {
        if (delayedLegacy) return delayedLegacy.value
        if (failLegacy) throw new Error('Corrupt legacy file')
        return null
      })
    },
    dispatchEvent,
    addEventListener: (name: string, listener: (event: Event) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    }
  }
  for (const name of ['wallet', 'agent', 'kasa', 'taxScope'])
    Object.defineProperty(windowFixture, name, { get: forbidden })
  vi.stubGlobal('document', {
    getElementById: get,
    createElement: (tag: string) => new Element(tag.toUpperCase())
  })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => saved.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      saved.set(key, value)
    },
    removeItem: (key: string): void => {
      saved.delete(key)
    }
  })
  await import('./tax-profile')
  const update = (next: AppProfileState): void => {
    state = structuredClone(next)
    dispatchEvent(new CustomEvent('kasa:app-profile-updated', { detail: structuredClone(next) }))
  }
  delayedLegacy?.imported(update)
  await vi.waitFor(() => expect(el('status').textContent).toContain('Tax details use'))
  return {
    el,
    get,
    form,
    radios,
    appGet,
    change,
    forbidden,
    events,
    saved,
    submit: async (): Promise<void> => {
      await form.onsubmit?.({ preventDefault: vi.fn() })
    },
    edit: (id: string, value: string): void => {
      el(id).value = value
      form.oninput?.({ target: el(id) })
    },
    year: (year: number): void => {
      el('year').value = String(year)
      form.oninput?.({ target: el('year') })
      form.onchange?.({ target: el('year') })
    },
    update,
    emit: (name: string, detail?: unknown): void => dispatchEvent(new CustomEvent(name, { detail }))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Commercialista follows app identity', () => {
  it.each(['app', 'year', 'no payload'])(
    'ignores late activity scope for %s after the selected app/year changes',
    async (stale) => {
      const f = await setup()
      const old = fixture()
      const next = fixture()
      if (stale === 'app') {
        next.activeProfileId = 'app-bob'
        next.scope.appProfileId = 'app-bob'
        next.scope.activeTaxpayerId = 'tax-bob'
      } else next.scope.taxpayers[0].profile = next.scope.taxpayers[0].yearProfiles![0]
      f.update(next)
      f.emit('kasa:tax-activity-updated', stale === 'no payload' ? undefined : { scope: old.scope })
      f.el('new').onclick?.()
      expect(f.el('name').value).toBe(stale === 'app' ? 'Bob' : 'Alice')
      expect(f.el('year').value).toBe(stale === 'app' ? '2026' : '2025')
      if (stale !== 'app') expect(f.el('personal').value).toBe('amministrato')
      expect(f.change).not.toHaveBeenCalled()
      expect(f.forbidden).not.toHaveBeenCalled()
    }
  )

  it('shows only the linked taxpayer and saves edits through the same app profile', async () => {
    const f = await setup()
    expect(f.el('existing').textContent).toContain('Alice')
    expect(f.el('existing').textContent).not.toContain('Deniz')
    expect(f.el('existing').textContent).not.toContain('Bob')
    f.el('new').onclick?.()
    expect(f.el('name').value).toBe('Alice')
    expect(f.get('view-tax').dataset.taxSetupDirty).toBe('true')
    f.edit('name', 'Never create this taxpayer')
    f.el('edit-activity').onclick?.()
    await f.submit()
    await f.submit()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'save-tax',
      profileId: 'app-alice',
      profile
    })
    expect(f.form.hidden).toBe(true)
    expect(f.get('view-tax').dataset.taxSetupDirty).toBe('false')
    expect(f.events.some((event) => event.type === 'kasa:tax-profile-created')).toBe(false)
    expect(f.events.some((event) => event.type === 'kasa:tax-scope-updated')).toBe(true)
    expect(f.events.some((event) => event.type === 'kasa:app-profiles-refresh')).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('derives the business name from app identity and keeps it read-only in markup', async () => {
    const f = await setup()
    f.el('new').onclick?.()
    f.radios[0].checked = false
    f.radios[1].checked = true
    f.form.oninput?.({ target: f.radios[1] })
    expect(f.el('name').value).toBe('Alice Company')
    expect(html).toMatch(/id="tax-profile-name"[^>]*readonly/)
  })

  it('creates tax details through the selected app identity and ignores submissions after saving', async () => {
    const f = await setup(fixture(false))
    f.el('new').onclick?.()
    f.radios[0].checked = true
    f.edit('country', 'IT')
    f.edit('personal', 'dichiarativo')
    f.el('edit-activity').onclick?.()
    await f.submit()
    await f.submit()
    await f.submit()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'save-tax',
      profileId: 'app-alice',
      profile: { ...profile, recordsCoverage: 'unknown' }
    })
    expect(f.events.filter((event) => event.type === 'kasa:tax-profile-created')).toHaveLength(1)
    expect(f.form.hidden).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('offers an explicit legacy link without choosing a similar name or another app taxpayer', async () => {
    const f = await setup(fixture(false))
    expect(f.el('existing').textContent).toContain('Deniz')
    expect(f.el('existing').textContent).not.toContain('Bob')
    expect(f.change).not.toHaveBeenCalled()
    const legacy = f.el('existing').children.find((entry) => entry.textContent.includes('Deniz'))!
    await legacy.querySelectorAll('button')[0].onclick?.()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'link-taxpayer',
      profileId: 'app-alice',
      taxpayerId: 'legacy-deniz'
    })
    expect(f.el('status').textContent).toContain('No records were merged')
  })

  it('locks app profile changes until a legacy relationship finishes saving', async () => {
    const f = await setup(fixture(false))
    let complete!: (value: AppProfileState) => void
    f.change.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const legacy = f.el('existing').children.find((entry) => entry.textContent.includes('Deniz'))!
    const pending = legacy.querySelectorAll('button')[0].onclick?.()
    expect(f.get('view-tax').dataset.taxSetupDirty).toBe('true')
    expect(f.el('new').disabled).toBe(true)
    const next = fixture(false)
    next.profiles[0].taxpayerId = 'legacy-deniz'
    next.scope.activeTaxpayerId = 'legacy-deniz'
    complete(next)
    await pending
    expect(f.get('view-tax').dataset.taxSetupDirty).toBe('false')
    expect(f.el('existing').textContent).toContain('Deniz')
  })

  it('delegates a new person or business to app profile creation', async () => {
    const f = await setup()
    f.el('create-app').onclick?.()
    expect(
      (f.events.find((event) => event.type === 'kasa:app-profile-open') as CustomEvent).detail
    ).toEqual({ create: true })
    expect(f.change).not.toHaveBeenCalled()
    expect(f.form.hidden).toBe(true)
  })

  it('preserves legacy drafts separately and restores only the selected app draft', async () => {
    const old = JSON.stringify({ ...newSetupDraft(profile), label: 'Legacy unrelated' })
    const saved = new Map([[setupDraftKey('fixture-db'), old]])
    const f = await setup(fixture(), saved)
    expect(f.el('draft-note').textContent).toContain('preserved separately')
    f.el('new').onclick?.()
    f.edit('personal', 'unknown')
    f.el('cancel').onclick?.()
    expect(saved.get(setupDraftKey('fixture-db'))).toBe(old)
    expect(JSON.parse(saved.get(setupDraftKey('fixture-db', 'app-alice'))!).personalRegime).toBe(
      'unknown'
    )
    const bob = fixture()
    bob.activeProfileId = 'app-bob'
    bob.scope.appProfileId = 'app-bob'
    bob.scope.activeTaxpayerId = 'tax-bob'
    f.update(bob)
    f.el('new').onclick?.()
    expect(f.el('name').value).toBe('Bob')
    expect(f.el('personal').value).toBe('dichiarativo')
    expect(saved.has(setupDraftKey('fixture-db', 'app-alice'))).toBe(true)
  })

  it('preserves an open draft and blocks stale saves when the active app changes', async () => {
    const f = await setup()
    f.el('new').onclick?.()
    f.edit('personal', 'unknown')
    f.el('edit-activity').onclick?.()
    await f.submit()
    const next = fixture()
    next.activeProfileId = 'app-bob'
    next.scope.appProfileId = 'app-bob'
    next.scope.activeTaxpayerId = 'tax-bob'
    f.update(next)
    expect(f.el('fields').disabled).toBe(true)
    expect(f.el('name').value).toBe('Alice')
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.el('status').textContent).toContain('changed')
    f.el('cancel').onclick?.()
    expect(f.el('existing').textContent).toContain('Bob')
    expect(f.saved.has(setupDraftKey('fixture-db', 'app-alice'))).toBe(true)
  })

  it.each(['appProfileDirty', 'appProfileBusy', 'taxHistoryDirty'])(
    'blocks tax setup and new app creation while %s is true',
    async (flag) => {
      const f = await setup()
      f.get('view-tax').dataset[flag] = 'true'
      f.emit(
        flag === 'taxHistoryDirty'
          ? 'kasa:tax-history-dirty'
          : flag === 'appProfileDirty'
            ? 'kasa:app-profile-dirty'
            : 'kasa:app-profile-busy'
      )
      expect(f.el('new').disabled).toBe(true)
      f.el('new').onclick?.()
      f.el('create-app').onclick?.()
      expect(f.form.hidden).toBe(true)
      expect(f.events.some((event) => event.type === 'kasa:app-profile-open')).toBe(false)
      expect(f.change).not.toHaveBeenCalled()
    }
  )

  it('loads the current app profile when the optional standalone legacy file is corrupt', async () => {
    const f = await setup(fixture(), new Map(), true)
    expect(f.el('new').disabled).toBe(false)
    expect(f.el('existing').textContent).toContain('Alice')
    expect(f.el('legacy').hidden).toBe(true)
  })

  it('does not overwrite a newer app identity after an older legacy read finishes', async () => {
    let complete!: (value: TaxProfile | null) => void
    const delayed = new Promise<TaxProfile | null>((resolve) => {
      complete = resolve
    })
    const bob = fixture()
    bob.activeProfileId = 'app-bob'
    bob.scope.appProfileId = 'app-bob'
    bob.scope.activeTaxpayerId = 'tax-bob'
    const f = await setup(fixture(), new Map(), false, {
      value: delayed,
      imported: (update) => {
        update(bob)
        complete(null)
      }
    })
    expect(f.el('existing').textContent).toContain('Bob')
    expect(f.el('existing').textContent).not.toContain('Alice')
    f.el('new').onclick?.()
    expect(f.el('name').value).toBe('Bob')
  })

  it('loads saved annual answers but does not copy them into an unconfigured year', async () => {
    const f = await setup()
    f.el('new').onclick?.()
    f.year(2025)
    expect(f.el('personal').value).toBe('amministrato')
    expect(f.el('status').textContent).toContain('Loaded saved tax details for 2025')
    f.year(2024)
    expect(f.el('personal').value).toBe('unknown')
    expect(f.el('country').value).toBe('')
    expect(f.radios.some((radio) => radio.checked)).toBe(false)
    expect(f.el('status').textContent).toContain("another year's answers have not been copied")
    expect(f.change).not.toHaveBeenCalled()
  })

  it('retains answers and the identity-scoped draft after a failed save', async () => {
    const f = await setup()
    f.change.mockRejectedValueOnce(new Error('Fixture write failure'))
    f.el('new').onclick?.()
    f.el('edit-activity').onclick?.()
    await f.submit()
    await f.submit()
    expect(f.form.hidden).toBe(false)
    expect(f.el('status').textContent).toContain('answers are retained')
    expect(f.saved.has(setupDraftKey('fixture-db', 'app-alice'))).toBe(true)
    expect(f.get('view-tax').dataset.taxSetupDirty).toBe('true')
  })
})
