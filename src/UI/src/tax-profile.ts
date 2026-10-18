import { currentTaxYear, taxProfileNotes, type TaxProfile } from '../../shared/tax-profile'
import type { Taxpayer, TaxScope } from '../../shared/tax-scope'
import { appProfileLabel, type AppProfile, type AppProfileState } from '../../shared/app-profile'
import { taxScopeKey } from '../../shared/tax-selection'
import {
  allowsForfettario,
  newSetupDraft,
  readSetupDraft,
  setupDraftKey,
  setupProfile,
  setupStepError,
  setupSteps,
  type TaxSetupDraft
} from './tax-setup-flow'

const el = (id: string): HTMLElement => document.getElementById(`tax-profile-${id}`)!
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement
const select = (id: string): HTMLSelectElement => el(id) as HTMLSelectElement
const form = el('form') as HTMLFormElement
const fields = el('fields') as HTMLFieldSetElement
let legacy: TaxProfile | null = null
let scope: TaxScope | null = null
let appState: AppProfileState | null = null
let pendingAppState: AppProfileState | null = null
let stateRevision = 0
let draftIdentity = ''
let draftTaxpayer = ''
let draft = newSetupDraft()
let savedDraft: TaxSetupDraft | null = null
let busy = true
let storageWarning = ''
const activeApp = (): AppProfile | undefined => {
  const current = appState
  return current?.profiles.find((entry) => entry.id === current.activeProfileId)
}
const activeTaxpayer = (): Taxpayer | undefined =>
  scope?.taxpayers.find((entry) => entry.id === activeApp()?.taxpayerId)
const identityKey = (state: AppProfileState): string =>
  JSON.stringify([state.databaseId, state.activeProfileId])
const taxpayerSignature = (state: AppProfileState): string => {
  const app = state.profiles.find((entry) => entry.id === state.activeProfileId)
  const taxpayer = state.scope.taxpayers.find((entry) => entry.id === app?.taxpayerId)
  return JSON.stringify([
    app?.taxpayerId ?? null,
    taxpayer?.profile ?? null,
    taxpayer?.yearProfiles ?? []
  ])
}
const draftKey = (): string | null =>
  scope && activeApp() ? setupDraftKey(scope.databaseId, activeApp()!.id) : null
const type = (): string =>
  form.querySelector<HTMLInputElement>('input[name="tax-profile-type"]:checked')?.value ?? ''
const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
const recordEditsPending = (): boolean =>
  document.getElementById('view-tax')?.dataset.taxHistoryDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.taxBasisDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.taxQuestionsDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.enrichmentDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.activityEditing === 'true' ||
  document.getElementById('view-tax')?.dataset.appProfileDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.appProfileBusy === 'true'

function canChangeProfile(): boolean {
  if (!recordEditsPending()) return true
  el('status').textContent =
    'Finish loading, or save or cancel your open profile and activity edits first.'
  return false
}

function setSetupEditing(editing: boolean): void {
  const root = document.getElementById('view-tax')!
  root.dataset.taxSetupDirty = String(editing)
  window.dispatchEvent(new CustomEvent('kasa:tax-setup-dirty', { detail: { dirty: editing } }))
}

for (let year = currentTaxYear(); year >= 2023; year--) {
  const option = document.createElement('option')
  option.value = option.textContent = String(year)
  select('year').append(option)
}

function updateDraftControls(): void {
  const locked = busy || recordEditsPending()
  input('new').disabled = locked || !form.hidden || !activeApp()
  input('new').textContent = savedDraft
    ? 'Continue tax setup'
    : activeTaxpayer()
      ? 'Edit tax details'
      : 'Complete tax details'
  input('create-app').disabled = locked || !form.hidden
  input('legacy').disabled = locked || !form.hidden || Boolean(savedDraft) || !activeApp()
  el('resume').hidden = !savedDraft || !form.hidden
  input('resume').disabled = locked
  el('discard').hidden = !savedDraft || !form.hidden
  input('discard').disabled = locked
  el('draft-note').textContent =
    storageWarning ||
    (savedDraft
      ? 'Your unfinished setup is saved on this device. Continue where you left off or discard only this draft.'
      : 'Setup progress is saved on this device. Existing profiles and records stay unchanged.')
  for (const button of el('existing').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = locked || !form.hidden
  fields.disabled = locked || Boolean(pendingAppState)
  input('cancel').disabled = busy
}

function updateFields(): void {
  const business = type() === 'business'
  for (const [name, visible] of [
    ['personal', !business],
    ['business', business],
    ['regime', business]
  ] as const) {
    el(`${name}-field`).hidden = !visible
    select(name).disabled = !visible
  }
  const allowed = allowsForfettario(select('business').value)
  const forfait = select('regime').querySelector<HTMLOptionElement>('[value="forfettario"]')!
  forfait.hidden = forfait.disabled = !allowed
  if (!allowed && select('regime').value === 'forfettario') select('regime').value = 'unknown'
  el('country-label').textContent = business
    ? 'Country of tax residence or establishment'
    : 'Country of tax residence'
  el('country-warning').hidden = select('country').value !== 'other'
  const app = activeApp()
  input('name').value = app ? appProfileLabel(app, business ? 'business' : 'personal') : ''
}

function readForm(): TaxSetupDraft {
  return {
    ...draft,
    label: activeApp()
      ? appProfileLabel(activeApp()!, type() === 'business' ? 'business' : 'personal')
      : '',
    country: select('country').value as TaxSetupDraft['country'],
    taxYear: Number(select('year').value),
    userType: type() as TaxSetupDraft['userType'],
    personalRegime: select('personal').value as TaxSetupDraft['personalRegime'],
    businessType: select('business').value as TaxSetupDraft['businessType'],
    businessRegime: select('regime').value as TaxSetupDraft['businessRegime']
  }
}

function saveDraft(): void {
  const key = draftKey()
  if (!key || form.hidden) return
  draft = readForm()
  savedDraft = { ...draft }
  try {
    localStorage.setItem(key, JSON.stringify(draft))
    if (storageWarning) el('status').textContent = 'Your setup progress is saved on this device.'
    storageWarning = ''
  } catch {
    storageWarning =
      'This device could not save setup progress. Keep this window open to retain your answers.'
    el('status').textContent = storageWarning
  }
  updateDraftControls()
}

function clearDraft(): boolean {
  try {
    const key = draftKey()
    if (key) localStorage.removeItem(key)
    savedDraft = null
    storageWarning = ''
  } catch {
    storageWarning =
      'This device could not remove the saved setup draft. Your saved profiles are unchanged.'
  }
  updateDraftControls()
  return !storageWarning
}

function showActivity(): void {
  el('activity-accounts').replaceChildren()
  if (!scope) return
  const accounts = scope.accounts.filter((account) => account.taxpayerId === activeTaxpayer()?.id)
  const accountIds = new Set(accounts.map((account) => account.id))
  const assignments = scope.assignments.filter((entry) => accountIds.has(entry.accountId))
  el('activity-summary').textContent = accounts.length
    ? `${accounts.length} saved account declaration${accounts.length === 1 ? '' : 's'} and ${assignments.length} record assignment${assignments.length === 1 ? '' : 's'} already exist for this app profile. You do not need to re-enter payments during setup.`
    : 'Payments made or received are recorded by the app. No accounts have been linked to a tax profile yet; this setup will not ask you to re-enter payments.'
  for (const account of accounts) {
    const owner = scope.taxpayers.find((taxpayer) => taxpayer.id === account.taxpayerId)
    const item = document.createElement('li')
    const share =
      account.ownershipBps === null
        ? 'ownership share not confirmed'
        : `${account.ownershipBps / 100}% declared ownership`
    item.textContent = `${account.label} · ${owner?.label ?? 'Existing profile'} · ${share}`
    el('activity-accounts').append(item)
  }
}

function summary(): void {
  const profile = setupProfile(draft)
  const rows: [string, string][] = [
    ['Profile name', draft.label.trim()],
    ['Activity', profile.userType === 'personal' ? 'Personal' : 'Business / professional'],
    [
      'Tax residence',
      profile.country === 'IT' ? 'Italy' : 'Another country — Italian calculations do not apply'
    ],
    ['Year to review', String(profile.taxYear)]
  ]
  for (const id of profile.userType === 'personal' ? ['personal'] : ['business', 'regime']) {
    rows.push([
      id === 'personal' ? 'Tax handling' : id === 'business' ? 'Business type' : 'Tax regime',
      select(id).selectedOptions[0].textContent ?? ''
    ])
  }
  rows.push([
    'Record history',
    profile.recordsCoverage === 'unknown'
      ? 'Still to review — records outside this app may be missing'
      : `${profile.recordsCoverage} — reused from previous setup, unverified`
  ])
  rows.push([
    'App activity',
    'Saved records stay unchanged. Account ownership and record assignment can be reviewed in Activity.'
  ])
  el('summary').replaceChildren()
  for (const [label, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    el('summary').append(dt, dd)
  }
}

function showStep(next: number, focus = true): void {
  draft.step = Math.max(0, Math.min(next, setupSteps.length - 1))
  for (let n = 0; n < setupSteps.length; n++) {
    const section = el(`step-${n}`) as HTMLFieldSetElement
    section.hidden = section.disabled = n !== draft.step
  }
  el('progress').textContent = `Step ${draft.step + 1} of ${setupSteps.length}`
  el('step-title').textContent = setupSteps[draft.step]
  el('back').hidden = draft.step === 0
  el('next').textContent = draft.step === setupSteps.length - 1 ? 'Save tax details' : 'Continue'
  updateFields()
  saveDraft()
  if (draft.step === 3) showActivity()
  if (draft.step === 4) summary()
  if (focus) el('step-title').focus()
}

function start(next = savedDraft ?? newSetupDraft(activeTaxpayer()?.profile ?? null)): void {
  if (busy || !activeApp() || !appState || !canChangeProfile()) return
  draft = { ...next }
  draftIdentity = identityKey(appState)
  draftTaxpayer = taxpayerSignature(appState)
  form.reset()
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="tax-profile-type"]'))
    radio.checked = radio.value === draft.userType
  input('name').value = draft.label
  for (const [id, value] of Object.entries({
    country: draft.country,
    year: String(draft.taxYear),
    personal: draft.personalRegime,
    business: draft.businessType,
    regime: draft.businessRegime
  }))
    select(id).value = value
  form.hidden = false
  setSetupEditing(true)
  el('notes').replaceChildren()
  el('status').textContent = activeTaxpayer()
    ? 'Edit tax details for your current app profile. Existing records and taxpayer identity stay linked.'
    : draft.reusedLegacy
      ? 'Previous tax answers copied into a draft for this app profile. Existing records are preserved.'
      : 'Complete tax details for your current app profile. You can save and close at any time.'
  window.dispatchEvent(new Event('kasa:tax-setup-opened'))
  showStep(draft.step)
}

function listProfiles(next: TaxScope): void {
  el('existing').replaceChildren()
  const app = activeApp()
  const linked = activeTaxpayer()
  const claimed = new Set(appState?.profiles.map((entry) => entry.taxpayerId).filter(Boolean))
  const available = linked ? [linked] : next.taxpayers.filter((entry) => !claimed.has(entry.id))
  for (const taxpayer of available) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `${taxpayer.label} · ${taxpayer.profile.userType === 'personal' ? 'Personal' : 'Business'} · ${taxpayer.profile.country === 'IT' ? 'Italy' : 'Other country'} · ${taxpayer.profile.taxYear}`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-s'
    button.textContent = linked ? 'Edit tax details' : 'Link these existing tax records'
    button.setAttribute(
      'aria-label',
      `${linked ? 'Edit' : 'Link'} ${taxpayer.label}, ${taxpayer.profile.taxYear}`
    )
    button.onclick = () => (linked ? start() : void linkTaxpayer(taxpayer.id))
    item.append(label, button)
    el('existing').append(item)
  }
  el('context').textContent = !app
    ? 'Create or select an app profile first. Commercialista uses that same identity.'
    : linked
      ? `${appProfileLabel(app, linked.profile.userType)} is linked to these saved tax details. Change app profiles in Profile to review a different person or business.`
      : available.length
        ? `Complete tax details for ${appProfileLabel(app)}, or explicitly link one of the existing tax records below. Names are not matched automatically; records are not merged.`
        : `Complete tax details for ${appProfileLabel(app)}. To set up a different person or business, create another app profile.`
  el('legacy').hidden = !legacy || Boolean(linked)
  updateDraftControls()
}

function restoreDraft(): void {
  savedDraft = null
  storageWarning = ''
  const key = draftKey()
  if (!key) return
  try {
    const raw = localStorage.getItem(key)
    savedDraft = readSetupDraft(raw)
    storageWarning =
      raw && !savedDraft
        ? 'An unreadable draft could not be restored. Saved tax details are unchanged.'
        : !raw && scope && localStorage.getItem(setupDraftKey(scope.databaseId))
          ? 'An older setup draft is preserved separately. It has not been applied to this app profile.'
          : ''
  } catch {
    storageWarning =
      'Saved setup progress is unavailable on this device. Saved tax details are unaffected.'
  }
}

function applyAppState(next: AppProfileState): void {
  const identityChanged = !appState || identityKey(appState) !== identityKey(next)
  appState = next
  scope = next.scope
  if (identityChanged || form.hidden) restoreDraft()
  listProfiles(scope)
  if (identityChanged)
    window.dispatchEvent(
      new CustomEvent('kasa:tax-profiles-loaded', {
        detail: { hasProfiles: Boolean(activeTaxpayer()), hasDraft: Boolean(savedDraft) }
      })
    )
}

function announceSaved(next: AppProfileState): void {
  window.dispatchEvent(new CustomEvent('kasa:tax-scope-updated', { detail: { scope: next.scope } }))
  window.dispatchEvent(new Event('kasa:app-profiles-refresh'))
}

async function linkTaxpayer(taxpayerId: string): Promise<void> {
  const app = activeApp()
  if (busy || !app || app.taxpayerId || !form.hidden || !canChangeProfile()) return
  busy = true
  setSetupEditing(true)
  updateDraftControls()
  try {
    const next = await window.appProfiles.change({
      kind: 'link-taxpayer',
      profileId: app.id,
      taxpayerId
    })
    applyAppState(next)
    announceSaved(next)
    el('status').textContent =
      'Existing tax records linked to this app profile. No records were merged or reassigned.'
    window.dispatchEvent(new Event('kasa:tax-profile-saved'))
  } catch (error) {
    el('status').textContent = `Tax records were not linked: ${errorText(error)}.`
  } finally {
    busy = false
    setSetupEditing(false)
    updateDraftControls()
  }
}

async function load(): Promise<void> {
  const revision = stateRevision
  busy = fields.disabled = true
  updateDraftControls()
  el('retry').hidden = true
  try {
    const current = await window.appProfiles.get()
    // A corrupt old standalone profile must not block the current app identity.
    legacy = await window.taxProfile.get().catch(() => null)
    busy = fields.disabled = false
    if (revision === stateRevision) applyAppState(current)
    else updateDraftControls()
    el('status').textContent =
      'Tax details use your current app profile. Saved payments and tax records are preserved.'
  } catch (error) {
    if (revision !== stateRevision) {
      busy = false
      updateDraftControls()
      return
    }
    el('status').textContent =
      `Could not load profiles: ${errorText(error)}. Saved information has not been changed.`
    el('retry').hidden = false
    window.dispatchEvent(new Event('kasa:tax-profiles-load-failed'))
  }
}

form.oninput = (event) => {
  if (busy) return
  if ((event.target as HTMLElement)?.id === 'tax-profile-year') return
  updateFields()
  saveDraft()
}
form.onchange = (event) => {
  if (busy) return
  const taxpayer = activeTaxpayer()
  const year = Number(select('year').value)
  if (
    (event.target as HTMLElement)?.id === 'tax-profile-year' &&
    taxpayer &&
    year !== draft.taxYear
  ) {
    const previous =
      taxpayer.profile.taxYear === year
        ? taxpayer.profile
        : taxpayer.yearProfiles?.find((entry) => entry.taxYear === year)
    start({ ...newSetupDraft(previous ?? null, year), taxYear: year, reusedLegacy: false })
    el('status').textContent = previous
      ? `Loaded saved tax details for ${year}. Saving will keep the other years' details.`
      : `No saved tax details for ${year}. Answer the questions for this year; another year's answers have not been copied.`
    return
  }
  updateFields()
  saveDraft()
}
el('new').onclick = () => start()
el('create-app').onclick = () => {
  if (busy || !form.hidden || !canChangeProfile()) return
  window.dispatchEvent(new CustomEvent('kasa:app-profile-open', { detail: { create: true } }))
}
el('legacy').onclick = () => start(newSetupDraft(legacy))
el('resume').onclick = () => {
  if (savedDraft) start(savedDraft)
}
el('discard').onclick = () => {
  if (busy || !canChangeProfile()) return
  const removed = clearDraft()
  el('status').textContent = removed
    ? 'Setup draft discarded. Saved profiles and records are unchanged.'
    : storageWarning
  input('new').focus()
}
el('retry').onclick = () => {
  void load()
}
el('back').onclick = () => {
  if (!busy) showStep(draft.step - 1)
}
for (const [id, step] of [
  ['edit-type', 0],
  ['edit-details', 1],
  ['edit-tax', 2],
  ['edit-activity', 3]
] as const)
  el(id).onclick = () => {
    if (!busy) showStep(step)
  }
el('cancel').onclick = () => {
  if (busy) return
  saveDraft()
  form.hidden = true
  setSetupEditing(false)
  updateDraftControls()
  el('status').textContent =
    storageWarning || 'Setup saved for later. Your existing profiles and records are unchanged.'
  window.dispatchEvent(new Event('kasa:tax-setup-closed'))
  if (pendingAppState) {
    const next = pendingAppState
    pendingAppState = null
    applyAppState(next)
  }
}
window.addEventListener('kasa:tax-enrichment-dirty', updateDraftControls)
window.addEventListener('kasa:tax-questions-dirty', updateDraftControls)
window.addEventListener('kasa:tax-basis-dirty', updateDraftControls)
window.addEventListener('kasa:tax-history-dirty', updateDraftControls)
window.addEventListener('kasa:tax-activity-editing', updateDraftControls)
window.addEventListener('kasa:app-profile-dirty', updateDraftControls)
window.addEventListener('kasa:app-profile-busy', updateDraftControls)
window.addEventListener('kasa:app-profile-updated', (event) => {
  stateRevision++
  const next = (event as CustomEvent<AppProfileState>).detail
  if (!form.hidden) {
    if (
      appState &&
      (identityKey(next) !== identityKey(appState) || taxpayerSignature(next) !== draftTaxpayer)
    ) {
      pendingAppState = next
      el('status').textContent =
        'The app profile or saved tax details changed. Your draft is preserved. Save and close this draft before continuing with the current app profile.'
      updateDraftControls()
    }
    return
  }
  applyAppState(next)
})
function updateSavedScope(event: Event): void {
  const current = (event as CustomEvent<{ scope?: TaxScope }>).detail?.scope
  // Only the app-profile registry changes selection. Activity notifications may
  // finish after a profile/year switch, or request a refresh without a payload.
  if (
    !scope ||
    !current ||
    current.databaseId !== scope.databaseId ||
    current.appProfileId !== scope.appProfileId ||
    taxScopeKey(current) !== taxScopeKey(scope)
  )
    return
  scope = current
  if (appState) appState = { ...appState, scope: current }
  listProfiles(scope)
  if (!form.hidden && draft.step === 3) showActivity()
}
window.addEventListener('kasa:tax-scope-updated', updateSavedScope)
window.addEventListener('kasa:tax-activity-updated', updateSavedScope)
form.onsubmit = async (event) => {
  event.preventDefault()
  if (busy || form.hidden) return
  draft = readForm()
  const error = setupStepError(draft, draft.step)
  if (error) {
    el('status').textContent = error
    form.reportValidity()
    if (draft.step === 1 && !draft.label.trim()) input('name').focus()
    return
  }
  if (!form.reportValidity()) return
  if (draft.step < setupSteps.length - 1) {
    el('status').textContent = 'Your answers are saved as a draft. You can go back to change them.'
    showStep(draft.step + 1)
    return
  }
  if (!canChangeProfile()) return
  busy = fields.disabled = true
  updateDraftControls()
  try {
    const profile = setupProfile(draft)
    const current = await window.appProfiles.get()
    if (
      identityKey(current) !== draftIdentity ||
      taxpayerSignature(current) !== draftTaxpayer ||
      pendingAppState
    )
      throw new Error(
        'The current app profile or saved tax details changed. Close this draft and reload before saving.'
      )
    const created = !activeTaxpayer()
    const next = await window.appProfiles.change({
      kind: 'save-tax',
      profileId: activeApp()!.id,
      profile
    })
    form.hidden = true
    setSetupEditing(false)
    clearDraft()
    applyAppState(next)
    el('status').textContent =
      `Saved tax details for ${draft.label.trim()}. The same app identity and existing records remain linked.${storageWarning ? ` ${storageWarning}` : ''}`
    el('notes').replaceChildren()
    for (const note of taxProfileNotes(profile)) {
      const item = document.createElement('li')
      item.textContent = note
      el('notes').append(item)
    }
    announceSaved(next)
    if (created) window.dispatchEvent(new Event('kasa:tax-profile-created'))
    window.dispatchEvent(new Event('kasa:tax-profile-saved'))
    window.dispatchEvent(new Event('kasa:tax-setup-closed'))
  } catch (error) {
    el('status').textContent =
      `Tax details not saved: ${errorText(error)}. Your answers are retained.`
  } finally {
    busy = fields.disabled = false
    updateDraftControls()
  }
}
void load()
