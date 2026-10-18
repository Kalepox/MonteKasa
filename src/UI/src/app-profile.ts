import {
  appProfileLabel,
  readLegacyAppProfile,
  validateAppProfileFields,
  type AppProfile,
  type AppProfileFields,
  type AppProfileState
} from '../../shared/app-profile'
import { savedTaxYears } from '../../shared/tax-selection'

const element = (id: string): HTMLElement => document.getElementById(id)!
const input = (id: string): HTMLInputElement => element(id) as HTMLInputElement
const selector = element('app-profile-select') as HTMLSelectElement
const yearSelector = element('tax-summary-year') as HTMLSelectElement
const form = element('app-profile-form') as HTMLFormElement
const root = element('view-tax')
const fieldIds = {
  name: 'prof-name',
  email: 'prof-email',
  company: 'prof-co',
  taxId: 'prof-vat',
  address: 'prof-addr',
  currency: 'prof-currency'
} as const
const blank: AppProfileFields = {
  name: '',
  email: '',
  company: '',
  taxId: '',
  address: '',
  currency: 'USDT'
}
let state: AppProfileState | null = null
let dirty = false
let busy = false
let creating = false
let queued = false
let disposed = false
let selectionUnconfirmed = false
let createAttempt: { fields: AppProfileFields; requestId: string; submitted: boolean } | null = null

const active = (): AppProfile | undefined =>
  state?.profiles.find((profile) => profile.id === state?.activeProfileId)
const externalEdit = (): boolean =>
  [
    'scopeBusy',
    'activityEditing',
    'enrichmentDirty',
    'taxQuestionsDirty',
    'taxBasisDirty',
    'taxHistoryDirty',
    'setupActive',
    'taxSetupDirty'
  ].some((key) => root.dataset[key] === 'true')
const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
const status = (text: string): void => {
  element('app-profile-status').textContent = text
}

function controls(): void {
  const locked = busy || selectionUnconfirmed || externalEdit() || !state
  element('app-profile-lock-status').hidden = !externalEdit()
  selector.disabled = locked || dirty || creating || !state?.profiles.length
  input('app-profile-new').disabled = locked || dirty || creating
  element('app-profile-retry').hidden = (Boolean(state) && !selectionUnconfirmed) || busy
  element('tax-summary-retry').hidden = !selectionUnconfirmed
  input('tax-summary-retry').disabled = busy
  ;(element('app-profile-fields') as HTMLFieldSetElement).disabled =
    locked || Boolean(createAttempt)
  input('app-profile-save').disabled = locked || !dirty
  input('app-profile-save').textContent = createAttempt
    ? 'Retry save'
    : creating || !active()
      ? 'Create profile'
      : 'Save changes'
  input('app-profile-cancel').disabled = busy || selectionUnconfirmed || !(dirty || creating)
  yearSelector.disabled = locked || dirty || creating || !active()?.taxpayerId
  input('tax-summary-setup').disabled = locked || dirty || creating || !active()
}

function setFlag(kind: 'dirty' | 'busy', value: boolean): void {
  if (kind === 'dirty') dirty = value
  else busy = value
  const key = kind === 'dirty' ? 'appProfileDirty' : 'appProfileBusy'
  const exposed = value || (kind === 'busy' && selectionUnconfirmed)
  const changed = root.dataset[key] !== String(exposed)
  root.dataset[key] = String(exposed)
  if (changed)
    window.dispatchEvent(
      new CustomEvent(`kasa:app-profile-${kind}`, { detail: { [kind]: exposed } })
    )
  controls()
}

function fields(): AppProfileFields {
  return Object.fromEntries(
    Object.entries(fieldIds).map(([name, id]) => [name, input(id).value])
  ) as AppProfileFields
}

function preview(): void {
  const values = fields()
  const name = values.name.trim() || values.company.trim()
  element('prev-name').textContent = name || 'Your name'
  element('prev-co').textContent = values.company.trim()
  element('prev-vat').textContent = values.taxId.trim() || 'Not provided'
  element('prev-av').textContent = initials(name)
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2) || '—'
  )
}

function render(): void {
  if (!state) return
  const profile = active()
  const values = creating ? blank : (profile ?? blank)
  for (const [name, id] of Object.entries(fieldIds))
    input(id).value = values[name as keyof AppProfileFields]
  selector.replaceChildren()
  if (!state.profiles.length) selector.append(new Option('No saved profiles yet', ''))
  for (const item of state.profiles) {
    const tax = state.scope.taxpayers.find((taxpayer) => taxpayer.id === item.taxpayerId)
    selector.append(new Option(appProfileLabel(item, tax?.profile.userType), item.id))
  }
  selector.value = state.activeProfileId ?? ''
  const linked = state.scope.taxpayers.find((taxpayer) => taxpayer.id === profile?.taxpayerId)
  element('tax-summary-profile').textContent = profile
    ? appProfileLabel(profile, linked?.profile.userType)
    : 'Choose or create an app profile'
  yearSelector.replaceChildren()
  for (const year of linked ? savedTaxYears(linked) : [])
    yearSelector.append(new Option(String(year), String(year)))
  if (!linked) yearSelector.append(new Option('Tax setup needed', ''))
  yearSelector.value = linked ? String(linked.profile.taxYear) : ''
  element('tax-summary-selection-status').textContent = linked
    ? `Summaries and the profile export use ${linked.profile.taxYear}. Other profiles and other years are excluded; undated records remain separate for review.`
    : 'Complete or link tax details for this app profile to see its summaries.'
  element('app-profile-link-status').textContent = creating
    ? 'Save this identity first, then add or connect its tax setup in Commercialista.'
    : linked
      ? `Connected to ${linked.label} · ${linked.profile.userType === 'business' ? 'Business' : 'Personal'} · tax year ${linked.profile.taxYear}. Manage tax details in Commercialista.`
      : 'No tax setup is connected to this profile yet. Commercialista can connect an existing setup or guide you through a new one.'
  element('sidebar-name').textContent = profile
    ? appProfileLabel(profile, linked?.profile.userType)
    : 'Your profile'
  element('sidebar-co').textContent = profile?.company ?? ''
  element('sidebar-av').textContent = initials(
    profile ? appProfileLabel(profile, linked?.profile.userType) : ''
  )
  preview()
  controls()
}

function publish(next: AppProfileState): void {
  window.dispatchEvent(new CustomEvent('kasa:app-profile-updated', { detail: next }))
}

function accept(next: AppProfileState): void {
  state = next
  selectionUnconfirmed = false
  creating = false
  createAttempt = null
  setFlag('dirty', false)
  render()
  publish(next)
}

function unconfirmSelection(): void {
  selectionUnconfirmed = true
  yearSelector.value = ''
  element('tax-summary-profile').textContent = 'Saved selection needs to be reloaded'
  element('tax-summary-selection-status').textContent =
    'The saved profile and year could not be confirmed. Reload the saved selection to resume summaries.'
}

function canChange(): boolean {
  if (busy || selectionUnconfirmed || !state) return false
  if (externalEdit()) {
    status('Save or cancel your open Commercialista edits before changing profiles.')
    return false
  }
  return true
}

async function refresh(): Promise<void> {
  if (disposed) return
  if (busy || dirty || creating) {
    queued = true
    return
  }
  queued = false
  setFlag('busy', true)
  try {
    let next = await window.appProfiles.get()
    if (disposed) return
    // Only an explicitly saved legacy identity can be migrated. Page placeholders
    // and example text never become stored profile fields.
    if (!next.profiles.length && !next.legacyImported) {
      let legacy: AppProfileFields | null = null
      try {
        legacy = readLegacyAppProfile(localStorage.getItem('kasa-business-profile'))
      } catch {
        /* An unavailable browser store must not prevent database profiles. */
      }
      if (legacy) next = await window.appProfiles.change({ kind: 'import-legacy', fields: legacy })
    }
    if (disposed) return
    accept(next)
    status(
      next.profiles.length
        ? 'Profiles loaded from this app database.'
        : 'Add your name or company to create your first profile. Nothing is saved until you choose Create profile.'
    )
    if (!next.profiles.length) {
      creating = true
      render()
    }
  } catch (error) {
    if (!disposed) {
      unconfirmSelection()
      status(`Profiles could not be loaded: ${errorText(error)}. Existing details are retained.`)
    }
  } finally {
    setFlag('busy', false)
    if (queued && !dirty && !creating && !disposed) void refresh()
  }
}

function newProfile(): void {
  if (!canChange()) return
  if (dirty || creating) {
    status('Save or cancel your current profile draft before creating another.')
    return
  }
  creating = true
  createAttempt = null
  // An empty new-profile form is a draft too: tax setup must keep its current owner.
  setFlag('dirty', true)
  render()
  status('New profile. Enter a name or company name, then save before setting up its taxes.')
  input('prof-name').focus()
}

form.onsubmit = (event) => {
  event.preventDefault()
  void save()
}

async function save(): Promise<void> {
  if (!canChange() || !state || !dirty || !form.reportValidity()) return
  let values: AppProfileFields
  try {
    values = createAttempt?.fields ?? validateAppProfileFields(fields())
  } catch (error) {
    status(errorText(error))
    return
  }
  const databaseId = state.databaseId
  const original = active()
  if (!original) creating = true
  const activeId = state.activeProfileId
  const retry = createAttempt?.submitted ?? false
  if (creating && !createAttempt)
    createAttempt = { fields: values, requestId: crypto.randomUUID(), submitted: false }
  setFlag('busy', true)
  try {
    const current = await window.appProfiles.get()
    if (disposed) return
    if (current.databaseId !== databaseId || (!retry && current.activeProfileId !== activeId))
      throw new Error('The active profile changed. Cancel this draft and reload saved profiles')
    if (!creating) {
      const saved = current.profiles.find((profile) => profile.id === original?.id)
      if (!saved || JSON.stringify(saved) !== JSON.stringify(original))
        throw new Error(
          'This profile changed while you were editing. Cancel and review the saved details'
        )
    }
    if (createAttempt) createAttempt.submitted = true
    const next = createAttempt
      ? await window.appProfiles.change({
          kind: 'create',
          fields: createAttempt.fields,
          requestId: createAttempt.requestId
        })
      : await window.appProfiles.change({ kind: 'update', profileId: original!.id, fields: values })
    if (disposed) return
    accept(next)
    status('Profile saved in this app database. Existing payments are unchanged.')
  } catch (error) {
    if (!disposed)
      status(
        `Could not save: ${errorText(error)}. ${createAttempt ? 'Your original draft is kept. Retry saves the same request; Cancel checks the saved profiles.' : 'Your edits are retained.'}`
      )
  } finally {
    setFlag('busy', false)
    if (queued && !dirty && !creating && !disposed) void refresh()
  }
}

input('app-profile-cancel').onclick = () => {
  void cancel()
}
async function cancel(): Promise<void> {
  if (busy || !state) return
  if (createAttempt) {
    // A failed IPC response can follow a successful write. Check the registry
    // before abandoning the retry key, so the next attempt cannot create a duplicate.
    setFlag('busy', true)
    try {
      const next = await window.appProfiles.get()
      if (!disposed) {
        accept(next)
        status('Saved profiles reloaded. The unsaved draft was closed.')
      }
    } catch (error) {
      if (!disposed)
        status(
          `Could not confirm saved profiles: ${errorText(error)}. Your draft is retained; retry when ready.`
        )
    } finally {
      setFlag('busy', false)
    }
  } else {
    creating = false
    setFlag('dirty', false)
    render()
    status('Unsaved edits cancelled. Saved profile details are unchanged.')
  }
  if (queued && !dirty && !creating) void refresh()
}

selector.onchange = () => {
  void selectProfile()
}
async function selectProfile(): Promise<void> {
  const profileId = selector.value
  if (
    !canChange() ||
    dirty ||
    creating ||
    !state?.profiles.some((profile) => profile.id === profileId)
  ) {
    selector.value = state?.activeProfileId ?? ''
    if (dirty || creating) status('Save or cancel your profile draft before switching profiles.')
    return
  }
  if (profileId === state.activeProfileId) return
  const databaseId = state.databaseId
  setFlag('busy', true)
  try {
    const current = await window.appProfiles.get()
    if (disposed) return
    if (current.databaseId !== databaseId)
      throw new Error('The active database changed. Reload profiles before switching')
    const next = await window.appProfiles.change({ kind: 'select', profileId })
    if (!disposed) {
      accept(next)
      status('Active profile changed. Commercialista now uses this profile’s tax setup.')
    }
  } catch (error) {
    if (!disposed) {
      unconfirmSelection()
      selector.value = state?.activeProfileId ?? ''
      status(`Could not switch profiles: ${errorText(error)}.`)
    }
  } finally {
    setFlag('busy', false)
    if (queued && !dirty && !creating && !disposed) void refresh()
  }
}

yearSelector.onchange = () => void selectTaxYear()
async function selectTaxYear(): Promise<void> {
  const taxYear = Number(yearSelector.value)
  const profile = active()
  const taxpayer = state?.scope.taxpayers.find((entry) => entry.id === profile?.taxpayerId)
  if (!canChange() || dirty || creating || !profile || !taxpayer) {
    yearSelector.value = taxpayer ? String(taxpayer.profile.taxYear) : ''
    element('tax-summary-selection-status').textContent =
      'Save or cancel your open edits before changing the summary year.'
    return
  }
  if (taxYear === taxpayer.profile.taxYear) return
  if (!savedTaxYears(taxpayer).includes(taxYear)) {
    yearSelector.value = String(taxpayer.profile.taxYear)
    element('tax-summary-selection-status').textContent =
      'Set up this year’s tax details before selecting it.'
    return
  }
  const databaseId = state!.databaseId
  setFlag('busy', true)
  element('tax-summary-selection-status').textContent = 'Loading the saved tax year…'
  try {
    const current = await window.appProfiles.get()
    if (disposed) return
    if (current.databaseId !== databaseId || current.activeProfileId !== profile.id)
      throw new Error('The app profile changed. Reload before choosing a year')
    const next = await window.appProfiles.change({
      kind: 'select-tax-year',
      profileId: profile.id,
      taxYear
    })
    if (!disposed) accept(next)
  } catch (error) {
    if (!disposed) {
      // A lost response can follow a successful write. Read the saved selection
      // before showing a year again; never copy annual answers to recover it.
      try {
        const current = await window.appProfiles.get()
        if (!disposed) accept(current)
      } catch {
        if (!disposed) unconfirmSelection()
      }
      if (!disposed)
        element('tax-summary-selection-status').textContent =
          `Could not confirm the year change: ${errorText(error)}. ${selectionUnconfirmed ? 'Reload the saved selection to resume summaries.' : 'The saved selection has been reloaded.'}`
    }
  } finally {
    setFlag('busy', false)
    if (queued && !dirty && !creating && !disposed) void refresh()
  }
}

input('tax-summary-setup').onclick = () => {
  if (!canChange() || dirty || creating) return
  window.dispatchEvent(new CustomEvent('kasa:tax-navigate', { detail: { target: 'tax-setup' } }))
  input('tax-profile-new').click()
}

for (const id of Object.values(fieldIds)) {
  const changed = (): void => {
    if (busy || createAttempt || externalEdit()) return
    setFlag('dirty', true)
    preview()
  }
  input(id).oninput = changed
  input(id).onchange = changed
}
input('app-profile-new').onclick = newProfile
input('app-profile-retry').onclick = () => {
  void refresh()
}
input('tax-summary-retry').onclick = () => {
  void refresh()
}
window.addEventListener('kasa:app-profile-open', (event) => {
  ;(window as Window & { go?: (page: string) => void }).go?.('profile')
  if ((event as CustomEvent<{ create?: boolean }>).detail?.create) newProfile()
})
window.addEventListener('kasa:app-profiles-refresh', () => {
  void refresh()
})
for (const name of [
  'kasa:tax-scope-busy',
  'kasa:tax-scope-idle',
  'kasa:tax-activity-editing',
  'kasa:tax-enrichment-dirty',
  'kasa:tax-questions-dirty',
  'kasa:tax-basis-dirty',
  'kasa:tax-history-dirty',
  'kasa:tax-setup-opened',
  'kasa:tax-setup-closed',
  'kasa:tax-setup-dirty'
])
  window.addEventListener(name, controls)
window.addEventListener('beforeunload', () => {
  disposed = true
})
preview()
void refresh()
