import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppProfileCommand, AppProfileFields, AppProfileState } from '../../shared/app-profile'
import { validateAppProfileFields } from '../../shared/app-profile'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const ids = new Map(
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
  textContent = ''
  onclick?: () => unknown
  onchange?: () => unknown
  oninput?: () => unknown
  onsubmit?: (event: Event) => unknown
  focus = vi.fn()
  click = vi.fn(() => (this.disabled ? undefined : this.onclick?.()))
  reportValidity = vi.fn(() => true)
  constructor(readonly tagName: string) {}
  set innerHTML(_value: string) {
    throw new Error('Saved profile fields must render as text')
  }
  append(...children: Element[]): void {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]): void {
    this.children = children
  }
}

const identity: AppProfileFields = {
  name: 'Ada Example',
  email: 'ada@example.test',
  company: 'Example Studio',
  taxId: 'SAVED-ID',
  address: 'Saved address',
  currency: 'EUR'
}
function fixture(): AppProfileState {
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
    databaseId: 'app-profile-fixture',
    activeProfileId: 'app-person',
    legacyImported: false,
    profiles: [
      { ...identity, id: 'app-person', taxpayerId: 'person' },
      {
        ...identity,
        id: 'app-business',
        name: 'Owner',
        company: 'Other Company',
        taxpayerId: 'business'
      }
    ],
    scope: {
      version: 1,
      databaseId: 'app-profile-fixture',
      activeTaxpayerId: 'person',
      taxpayers: [
        { id: 'person', label: 'Saved personal taxes', profile },
        {
          id: 'business',
          label: 'Saved business taxes',
          profile: {
            ...profile,
            userType: 'business',
            personalRegime: null,
            businessType: 'company',
            businessRegime: 'ordinary'
          }
        }
      ],
      accounts: [],
      assets: [],
      assignments: []
    }
  }
}
function emptyFixture(): AppProfileState {
  return { ...fixture(), profiles: [], activeProfileId: null }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

async function setup(
  initial = fixture(),
  legacy: string | null = null,
  failLoad = false
): Promise<{
  state: { value: AppProfileState }
  get: (id: string) => Element
  getState: ReturnType<typeof vi.fn<() => Promise<AppProfileState>>>
  change: ReturnType<typeof vi.fn<(command: AppProfileCommand) => Promise<AppProfileState>>>
  storage: {
    getItem: ReturnType<typeof vi.fn>
    setItem: ReturnType<typeof vi.fn>
    removeItem: ReturnType<typeof vi.fn>
  }
  forbidden: ReturnType<typeof vi.fn>
  go: ReturnType<typeof vi.fn>
  events: Event[]
  emit: (name: string, detail?: unknown) => void
  set: (id: string, value: string) => void
  click: (id: string) => Promise<void>
  submit: () => Promise<void>
}> {
  vi.resetModules()
  const state = { value: initial }
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    if (!ids.has(id)) throw new Error(`Missing page element ${id}`)
    if (!elements.has(id)) elements.set(id, new Element(ids.get(id)!))
    return elements.get(id)!
  }
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const events: Event[] = []
  const emit = (name: string, detail?: unknown): void => {
    const event = new CustomEvent(name, { detail })
    events.push(event)
    for (const listener of listeners.get(name) ?? []) listener(event)
  }
  const forbidden = vi.fn(() => {
    throw new Error('Profile identity must not access wallets, payments or AI')
  })
  const storage = { getItem: vi.fn(() => legacy), setItem: forbidden, removeItem: forbidden }
  const getState = vi
    .fn<() => Promise<AppProfileState>>()
    .mockImplementation(async () => structuredClone(state.value))
  if (failLoad) getState.mockRejectedValueOnce(new Error('Fixture database unavailable'))
  const requests = new Map<string, string>()
  const change = vi
    .fn<(command: AppProfileCommand) => Promise<AppProfileState>>()
    .mockImplementation(async (command) => {
      const next = structuredClone(state.value)
      if (command.kind === 'create' || command.kind === 'import-legacy') {
        const prior = command.kind === 'create' ? requests.get(command.requestId) : undefined
        if (prior) next.activeProfileId = prior
        else {
          const profile = {
            ...validateAppProfileFields(command.fields),
            id: `created-${next.profiles.length}`,
            taxpayerId: null
          }
          next.profiles.push(profile)
          next.activeProfileId = profile.id
          if (command.kind === 'create') requests.set(command.requestId, profile.id)
          else next.legacyImported = true
        }
      } else if (command.kind === 'update') {
        const index = next.profiles.findIndex((profile) => profile.id === command.profileId)
        next.profiles[index] = {
          ...next.profiles[index],
          ...validateAppProfileFields(command.fields)
        }
      } else if (command.kind === 'select') next.activeProfileId = command.profileId
      else if (command.kind === 'select-tax-year') {
        const owner = next.profiles.find((entry) => entry.id === command.profileId)!
        const taxpayer = next.scope.taxpayers.find((entry) => entry.id === owner.taxpayerId)!
        const selected = taxpayer.yearProfiles?.find((entry) => entry.taxYear === command.taxYear)
        if (!selected) throw new Error('Set up this year first')
        taxpayer.profile = structuredClone(selected)
      } else throw new Error(`Unexpected identity UI command ${command.kind}`)
      state.value = next
      return structuredClone(next)
    })
  const go = vi.fn()
  const windowFixture = {
    appProfiles: { get: getState, change },
    go,
    addEventListener: (name: string, listener: (event: Event) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    dispatchEvent: (event: Event): boolean => {
      events.push(event)
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    }
  }
  for (const key of ['kasa', 'wallet', 'agent', 'taxScope', 'taxProfile'])
    Object.defineProperty(windowFixture, key, { get: forbidden })
  let request = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => `00000000-0000-4000-8000-${String(++request).padStart(12, '0')}`
  })
  vi.stubGlobal('window', windowFixture)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('document', { getElementById: get })
  vi.stubGlobal(
    'Option',
    class extends Element {
      constructor(text: string, value: string) {
        super('OPTION')
        this.textContent = text
        this.value = value
      }
    }
  )
  await import('./app-profile')
  await flush()
  return {
    state,
    get,
    getState,
    change,
    storage,
    forbidden,
    go,
    events,
    emit,
    set: (id, value): void => {
      get(id).value = value
      get(id).oninput?.()
    },
    click: async (id): Promise<void> => {
      get(id).onclick?.()
      await flush()
    },
    submit: async (): Promise<void> => {
      get('app-profile-form').onsubmit?.(new Event('submit', { cancelable: true }))
      await flush()
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('database app profile identity form', () => {
  it('switches among saved annual settings through the active app profile and publishes the new scope', async () => {
    const saved = fixture()
    const taxpayer = saved.scope.taxpayers[0]
    taxpayer.yearProfiles = [
      { ...taxpayer.profile, taxYear: 2025, recordsCoverage: 'incomplete' },
      { ...taxpayer.profile }
    ]
    const f = await setup(saved)
    expect(f.get('tax-summary-profile').textContent).toBe(identity.name)
    expect(f.get('tax-summary-year').children.map((option) => option.value)).toEqual([
      '2026',
      '2025'
    ])
    expect(f.get('tax-summary-year').value).toBe('2026')
    f.get('tax-summary-year').value = '2025'
    f.get('tax-summary-year').onchange?.()
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('true')
    await flush()
    expect(f.change).toHaveBeenCalledExactlyOnceWith({
      kind: 'select-tax-year',
      profileId: 'app-person',
      taxYear: 2025
    })
    expect(f.get('tax-summary-year').value).toBe('2025')
    expect(f.get('tax-summary-selection-status').textContent).toContain('2025')
    expect(f.state.value.scope.taxpayers[0].profile.recordsCoverage).toBe('incomplete')
    expect(f.state.value.scope.taxpayers[1].profile.taxYear).toBe(2026)
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('false')
    expect(f.events.filter((event) => event.type === 'kasa:app-profile-updated')).toHaveLength(2)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it.each([
    'appProfileDirty',
    'scopeBusy',
    'taxSetupDirty',
    'taxQuestionsDirty',
    'taxBasisDirty',
    'taxHistoryDirty',
    'enrichmentDirty',
    'activityEditing'
  ])('does not switch summary years during %s', async (flag) => {
    const saved = fixture()
    saved.scope.taxpayers[0].yearProfiles = [{ ...saved.scope.taxpayers[0].profile, taxYear: 2025 }]
    const f = await setup(saved)
    if (flag === 'appProfileDirty') f.set('prof-name', 'Unsaved identity')
    else f.get('view-tax').dataset[flag] = 'true'
    f.emit('kasa:tax-scope-busy')
    expect(f.get('tax-summary-year').disabled).toBe(true)
    f.get('tax-summary-year').value = '2025'
    f.get('tax-summary-year').onchange?.()
    await flush()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('tax-summary-year').value).toBe('2026')
    expect(f.get('tax-summary-selection-status').textContent).toContain('open edits')
  })

  it('rejects an unconfigured summary year and opens the existing tax setup instead', async () => {
    const f = await setup()
    f.get('tax-summary-year').value = '2024'
    f.get('tax-summary-year').onchange?.()
    await flush()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('tax-summary-year').value).toBe('2026')
    expect(f.get('tax-summary-selection-status').textContent).toContain('Set up this year')
    await f.click('tax-summary-setup')
    expect(f.get('tax-profile-new').click).toHaveBeenCalledOnce()
    expect(
      (f.events.find((event) => event.type === 'kasa:tax-navigate') as CustomEvent).detail
    ).toEqual({ target: 'tax-setup' })
    expect(f.change).not.toHaveBeenCalled()
  })

  it('reconciles a lost year-selection response without creating or copying tax settings', async () => {
    const saved = fixture()
    saved.scope.taxpayers[0].yearProfiles = [{ ...saved.scope.taxpayers[0].profile, taxYear: 2025 }]
    const f = await setup(saved)
    const change = f.change.getMockImplementation()!
    f.change.mockImplementationOnce(async (command) => {
      await change(command)
      throw new Error('Response interrupted')
    })
    f.get('tax-summary-year').value = '2025'
    f.get('tax-summary-year').onchange?.()
    await flush()
    expect(f.get('tax-summary-year').value).toBe('2025')
    expect(f.get('tax-summary-selection-status').textContent).toContain('Response interrupted')
    expect(f.change).toHaveBeenCalledOnce()
    expect(f.state.value.scope.taxpayers[0].yearProfiles).toEqual(
      saved.scope.taxpayers[0].yearProfiles
    )
  })

  it('withholds summaries until the saved year can be confirmed after an interrupted write', async () => {
    const saved = fixture()
    saved.scope.taxpayers[0].yearProfiles = [{ ...saved.scope.taxpayers[0].profile, taxYear: 2025 }]
    const f = await setup(saved)
    const change = f.change.getMockImplementation()!
    f.change.mockImplementationOnce(async (command) => {
      await change(command)
      throw new Error('Response interrupted')
    })
    f.getState
      .mockResolvedValueOnce(structuredClone(saved))
      .mockRejectedValueOnce(new Error('Read unavailable'))
    f.get('tax-summary-year').value = '2025'
    f.get('tax-summary-year').onchange?.()
    await flush()
    expect(f.get('tax-summary-year').value).toBe('')
    expect(f.get('tax-summary-year').disabled).toBe(true)
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('true')
    expect(f.get('tax-summary-retry').hidden).toBe(false)
    expect(f.get('tax-summary-selection-status').textContent).toContain(
      'Reload the saved selection'
    )
    await f.click('tax-summary-retry')
    expect(f.get('tax-summary-year').value).toBe('2025')
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('false')
    expect(f.get('tax-summary-retry').hidden).toBe(true)
    expect(f.change).toHaveBeenCalledOnce()
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('keeps an unavailable registry disabled and lets the user retry without saving defaults', async () => {
    const f = await setup(fixture(), null, true)
    expect(f.get('app-profile-retry').hidden).toBe(false)
    expect(f.get('app-profile-fields').disabled).toBe(true)
    expect(f.get('app-profile-status').textContent).toContain('Fixture database unavailable')
    expect(f.change).not.toHaveBeenCalled()
    await f.click('app-profile-retry')
    expect(f.get('app-profile-retry').hidden).toBe(true)
    expect(f.get('prof-name').value).toBe(identity.name)
    expect(f.change).not.toHaveBeenCalled()
  })

  it('withholds the selected year after a failed registry refresh until it can read current settings', async () => {
    const f = await setup()
    f.state.value.scope.taxpayers[0].profile.taxYear = 2025
    f.getState.mockRejectedValueOnce(new Error('Profile read unavailable'))
    f.emit('kasa:app-profiles-refresh')
    await flush()
    expect(f.get('tax-summary-year').value).toBe('')
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('true')
    expect(f.get('tax-summary-retry').hidden).toBe(false)
    await f.click('tax-summary-retry')
    expect(f.get('tax-summary-year').value).toBe('2025')
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('false')
    expect(f.change).not.toHaveBeenCalled()
  })

  it('does not expose the old profile selection after an interrupted profile-switch response', async () => {
    const f = await setup()
    const change = f.change.getMockImplementation()!
    f.change.mockImplementationOnce(async (command) => {
      await change(command)
      throw new Error('Switch response unavailable')
    })
    f.get('app-profile-select').value = 'app-business'
    f.get('app-profile-select').onchange?.()
    await flush()
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('true')
    expect(f.get('tax-summary-year').value).toBe('')
    expect(f.get('tax-summary-retry').hidden).toBe(false)
    await f.click('tax-summary-retry')
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('false')
    expect(f.get('tax-summary-profile').textContent).toBe('Other Company')
    expect(f.get('app-profile-select').value).toBe('app-business')
    expect(f.change).toHaveBeenCalledOnce()
  })
  it('loads saved fields, labels and tax link without overwriting legacy storage', async () => {
    const f = await setup()
    expect(f.get('prof-name').value).toBe(identity.name)
    expect(f.get('prof-currency').value).toBe('EUR')
    expect(f.get('app-profile-select').children.map((option) => option.textContent)).toEqual([
      'Ada Example',
      'Other Company'
    ])
    expect(f.get('app-profile-link-status').textContent).toContain('Saved personal taxes')
    expect(f.get('app-profile-link-status').textContent).toContain('2026')
    expect(f.get('sidebar-name').textContent).toBe(identity.name)
    expect(f.get('prev-vat').textContent).toBe('SAVED-ID')
    expect(f.change).not.toHaveBeenCalled()
    expect(f.storage.getItem).not.toHaveBeenCalled()
    expect(f.events.some((event) => event.type === 'kasa:app-profile-updated')).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it.each([null, '{}', 'malformed', '{"prof-name":200}', '{"prof-email":"test@example.test"}'])(
    'starts blank for absent or invalid legacy data %s',
    async (legacy) => {
      const f = await setup(emptyFixture(), legacy)
      expect(f.get('prof-name').value).toBe('')
      expect(f.get('prof-co').value).toBe('')
      expect(f.get('prof-vat').value).toBe('')
      expect(f.get('prev-name').textContent).toBe('Your name')
      expect(f.get('app-profile-save').textContent).toBe('Create profile')
      expect(f.change).not.toHaveBeenCalled()
      expect(f.forbidden).not.toHaveBeenCalled()
    }
  )

  it('imports only valid previously saved legacy values once and retains the source key', async () => {
    const f = await setup(
      emptyFixture(),
      JSON.stringify({
        'prof-name': 'Legacy identity',
        'prof-co': 'Legacy business',
        'prof-vat': 'LEGACY'
      })
    )
    expect(f.change).toHaveBeenCalledTimes(1)
    expect(f.change).toHaveBeenCalledWith({
      kind: 'import-legacy',
      fields: {
        name: 'Legacy identity',
        company: 'Legacy business',
        taxId: 'LEGACY',
        address: '',
        email: '',
        currency: 'USDT'
      }
    })
    expect(f.get('prof-name').value).toBe('Legacy identity')
    f.emit('kasa:app-profiles-refresh')
    await flush()
    expect(f.change).toHaveBeenCalledTimes(1)
    expect(f.storage.setItem).not.toHaveBeenCalled()
    expect(f.storage.removeItem).not.toHaveBeenCalled()
  })

  it('does not import legacy data again when a previous migration marker exists', async () => {
    const f = await setup(
      { ...emptyFixture(), legacyImported: true },
      JSON.stringify({ 'prof-name': 'Old identity' })
    )
    expect(f.storage.getItem).not.toHaveBeenCalled()
    expect(f.change).not.toHaveBeenCalled()
  })

  it('creates a new profile explicitly, using validated identity fields and a request UUID', async () => {
    const f = await setup()
    const taxBefore = structuredClone(f.state.value.scope)
    await f.click('app-profile-new')
    expect(f.get('prof-name').value).toBe('')
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('true')
    f.set('prof-name', ' New Person ')
    f.set('prof-currency', 'BTC')
    await f.submit()
    expect(f.change).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        requestId: expect.stringMatching(/^[\da-f-]{36}$/),
        fields: {
          name: 'New Person',
          email: '',
          company: '',
          taxId: '',
          address: '',
          currency: 'BTC'
        }
      })
    )
    expect(f.state.value.profiles).toHaveLength(3)
    expect(f.state.value.scope).toEqual(taxBefore)
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('false')
    expect(f.get('sidebar-name').textContent).toBe('New Person')
    expect(f.get('app-profile-link-status').textContent).toContain('No tax setup')
  })

  it('updates only the active profile and preserves its taxpayer connection', async () => {
    const f = await setup()
    const other = structuredClone(f.state.value.profiles[1])
    f.set('prof-co', 'Changed studio')
    await f.submit()
    expect(f.change).toHaveBeenCalledWith({
      kind: 'update',
      profileId: 'app-person',
      fields: { ...identity, company: 'Changed studio' }
    })
    expect(f.state.value.profiles[0].taxpayerId).toBe('person')
    expect(f.state.value.profiles[1]).toEqual(other)
  })

  it('rejects an unnamed new profile instead of saving placeholder text', async () => {
    const f = await setup()
    await f.click('app-profile-new')
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('app-profile-status').textContent).toContain('Enter a name or company name')
  })

  it('cancels a draft without changing saved profiles', async () => {
    const f = await setup()
    f.set('prof-name', 'Unsaved')
    await f.click('app-profile-cancel')
    expect(f.get('prof-name').value).toBe(identity.name)
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('false')
    expect(f.change).not.toHaveBeenCalled()
  })

  it('protects a dirty identity form from profile switches and refreshes', async () => {
    const f = await setup()
    f.set('prof-name', 'Draft name')
    f.get('app-profile-select').value = 'app-business'
    f.get('app-profile-select').onchange?.()
    f.emit('kasa:app-profiles-refresh')
    await flush()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('prof-name').value).toBe('Draft name')
    expect(f.get('app-profile-select').value).toBe('app-person')
    await f.click('app-profile-cancel')
    expect(f.getState).toHaveBeenCalledTimes(2)
  })

  it.each([
    'scopeBusy',
    'activityEditing',
    'enrichmentDirty',
    'taxQuestionsDirty',
    'taxBasisDirty',
    'setupActive',
    'taxSetupDirty'
  ])('protects Commercialista %s edits from switching profiles', async (flag) => {
    const f = await setup()
    f.get('view-tax').dataset[flag] = 'true'
    f.emit('kasa:tax-scope-busy')
    expect(f.get('app-profile-select').disabled).toBe(true)
    f.get('app-profile-select').value = 'app-business'
    f.get('app-profile-select').onchange?.()
    await f.click('app-profile-new')
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('prof-name').value).toBe(identity.name)
    expect(f.get('app-profile-status').textContent).toContain('Commercialista edits')
  })

  it('switches the active profile through the database API and publishes the resulting state', async () => {
    const f = await setup()
    f.get('app-profile-select').value = 'app-business'
    f.get('app-profile-select').onchange?.()
    await flush()
    expect(f.change).toHaveBeenCalledWith({ kind: 'select', profileId: 'app-business' })
    expect(f.get('sidebar-name').textContent).toBe('Other Company')
    expect(f.get('app-profile-link-status').textContent).toContain('Saved business taxes')
    const updates = f.events.filter(
      (event) => event.type === 'kasa:app-profile-updated'
    ) as CustomEvent<AppProfileState>[]
    expect(updates.at(-1)?.detail.activeProfileId).toBe('app-business')
  })

  it('preserves drafts and blocks writes after a stale profile or identity edit', async () => {
    const f = await setup()
    f.set('prof-name', 'My unsaved name')
    f.state.value.profiles[0].email = 'changed@example.test'
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('prof-name').value).toBe('My unsaved name')
    expect(f.get('app-profile-status').textContent).toContain('changed while you were editing')
    f.state.value.activeProfileId = 'app-business'
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('app-profile-status').textContent).toContain('active profile changed')
  })

  it('retries failed creation using the same UUID and original fields', async () => {
    const f = await setup()
    await f.click('app-profile-new')
    f.set('prof-name', 'Retained identity')
    f.change.mockRejectedValueOnce(new Error('Fixture failed response'))
    await f.submit()
    const first = f.change.mock.calls[0][0]
    expect(f.get('app-profile-fields').disabled).toBe(true)
    expect(f.get('app-profile-save').disabled).toBe(false)
    expect(f.get('app-profile-save').textContent).toBe('Retry save')
    f.set('prof-name', 'Synthetic ignored edit')
    await f.submit()
    expect(f.change.mock.calls[1][0]).toEqual(first)
    expect(f.get('prof-name').value).toBe('Retained identity')
    expect(f.state.value.profiles).toHaveLength(3)
  })

  it('does not bypass a stale active-profile check when a create has not been submitted', async () => {
    const f = await setup()
    await f.click('app-profile-new')
    f.set('prof-name', 'Draft identity')
    f.state.value.activeProfileId = 'app-business'
    await f.submit()
    await f.submit()
    expect(f.change).not.toHaveBeenCalled()
    expect(f.get('app-profile-status').textContent).toContain('active profile changed')
  })

  it('retries a committed creation after a lost response without creating another identity', async () => {
    const f = await setup()
    const write = f.change.getMockImplementation()!
    f.change.mockImplementationOnce(async (command) => {
      await write(command)
      throw new Error('Fixture lost response after save')
    })
    await f.click('app-profile-new')
    f.set('prof-name', 'Saved once')
    await f.submit()
    expect(f.state.value.profiles).toHaveLength(3)
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('true')
    await f.submit()
    expect(f.state.value.profiles).toHaveLength(3)
    expect(f.change.mock.calls[1][0]).toEqual(f.change.mock.calls[0][0])
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('false')
    expect(f.get('prof-name').value).toBe('Saved once')
  })

  it('rechecks saved profiles before cancelling an uncertain creation outcome', async () => {
    const f = await setup()
    await f.click('app-profile-new')
    f.set('prof-name', 'Retained identity')
    f.change.mockRejectedValueOnce(new Error('Fixture failed response'))
    await f.submit()
    f.getState.mockRejectedValueOnce(new Error('Fixture unavailable'))
    await f.click('app-profile-cancel')
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('true')
    expect(f.get('app-profile-status').textContent).toContain('Could not confirm saved profiles')
    await f.click('app-profile-cancel')
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('false')
    expect(f.get('prof-name').value).toBe(identity.name)
  })

  it('opens the existing Profile view and starts a draft only on an explicit create request', async () => {
    const f = await setup()
    f.emit('kasa:app-profile-open')
    expect(f.go).toHaveBeenCalledWith('profile')
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('false')
    f.emit('kasa:app-profile-open', { create: true })
    expect(f.get('prof-name').value).toBe('')
    expect(f.get('view-tax').dataset.appProfileDirty).toBe('true')
  })

  it('renders malicious-looking profile data literally and never contacts other app services', async () => {
    const state = fixture()
    state.profiles[0].name = '<script>sendFunds()</script>'
    const f = await setup(state)
    expect(f.get('prev-name').textContent).toBe('<script>sendFunds()</script>')
    expect(f.get('sidebar-name').textContent).toBe('<script>sendFunds()</script>')
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it('does not write after the page closes while checking saved profile state', async () => {
    const f = await setup()
    f.set('prof-name', 'Updated')
    let resolve: (value: AppProfileState) => void = () => undefined
    f.getState.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await f.submit()
    expect(f.get('view-tax').dataset.appProfileBusy).toBe('true')
    f.emit('beforeunload')
    resolve(f.state.value)
    await flush()
    expect(f.change).not.toHaveBeenCalled()
  })
})
