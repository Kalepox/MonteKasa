import { currentTaxYear, taxProfileNotes, type TaxProfile } from '../../shared/tax-profile'
import type { TaxScope } from '../../shared/tax-scope'
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
let draft = newSetupDraft()
let savedDraft: TaxSetupDraft | null = null
let busy = true
let storageWarning = ''
const type = (): string =>
  form.querySelector<HTMLInputElement>('input[name="tax-profile-type"]:checked')?.value ?? ''
const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
const recordEditsPending = (): boolean =>
  document.getElementById('view-tax')?.dataset.enrichmentDirty === 'true' ||
  document.getElementById('view-tax')?.dataset.activityEditing === 'true'

function canChangeProfile(): boolean {
  if (!recordEditsPending()) return true
  el('status').textContent = 'Save or cancel your open activity edits before changing profiles.'
  return false
}

for (let year = currentTaxYear(); year >= 2023; year--) {
  const option = document.createElement('option')
  option.value = option.textContent = String(year)
  select('year').append(option)
}

function updateDraftControls(): void {
  const locked = busy || recordEditsPending()
  input('new').disabled = locked || !form.hidden
  input('new').textContent = savedDraft ? 'Continue setup' : 'Add profile'
  input('legacy').disabled = locked || !form.hidden || Boolean(savedDraft)
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
  input('name').placeholder = business ? 'My business' : 'My personal taxes'
}

function readForm(): TaxSetupDraft {
  return {
    ...draft,
    label: input('name').value,
    country: select('country').value as TaxSetupDraft['country'],
    taxYear: Number(select('year').value),
    userType: type() as TaxSetupDraft['userType'],
    personalRegime: select('personal').value as TaxSetupDraft['personalRegime'],
    businessType: select('business').value as TaxSetupDraft['businessType'],
    businessRegime: select('regime').value as TaxSetupDraft['businessRegime']
  }
}

function saveDraft(): void {
  if (!scope || form.hidden) return
  draft = readForm()
  savedDraft = { ...draft }
  try {
    localStorage.setItem(setupDraftKey(scope.databaseId), JSON.stringify(draft))
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
    if (scope) localStorage.removeItem(setupDraftKey(scope.databaseId))
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
  el('activity-summary').textContent = scope.accounts.length
    ? `${scope.accounts.length} saved account declaration${scope.accounts.length === 1 ? '' : 's'} and ${scope.assignments.length} record assignment${scope.assignments.length === 1 ? '' : 's'} already exist. These remain with their current profiles. You do not need to re-enter payments during setup.`
    : 'Payments made or received are recorded by the app. No accounts have been linked to a tax profile yet; this setup will not ask you to re-enter payments.'
  for (const account of scope.accounts) {
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
  el('next').textContent = draft.step === setupSteps.length - 1 ? 'Create profile' : 'Continue'
  updateFields()
  saveDraft()
  if (draft.step === 3) showActivity()
  if (draft.step === 4) summary()
  if (focus) el('step-title').focus()
}

function start(next = savedDraft ?? newSetupDraft()): void {
  if (busy || !canChangeProfile()) return
  draft = { ...next }
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
  el('notes').replaceChildren()
  el('status').textContent = draft.reusedLegacy
    ? 'Previous setup copied into a draft. The original setup and all existing profiles are preserved.'
    : 'Create your profile in a few short steps. You can save and close at any time.'
  window.dispatchEvent(new Event('kasa:tax-setup-opened'))
  showStep(draft.step)
}

function listProfiles(next: TaxScope): void {
  el('existing').replaceChildren()
  for (const taxpayer of next.taxpayers) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `${taxpayer.label} · ${taxpayer.profile.userType === 'personal' ? 'Personal' : 'Business'} · ${taxpayer.profile.country === 'IT' ? 'Italy' : 'Other country'} · ${taxpayer.profile.taxYear}`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-s'
    button.textContent = 'Open profile'
    button.setAttribute('aria-label', `Open ${taxpayer.label}, ${taxpayer.profile.taxYear}`)
    button.onclick = () => {
      if (canChangeProfile())
        window.dispatchEvent(
          new CustomEvent('kasa:tax-profile-select', {
            detail: { taxpayerId: taxpayer.id }
          })
        )
    }
    item.append(label, button)
    el('existing').append(item)
  }
  el('missing').textContent = next.taxpayers.length
    ? 'Choose a saved profile to review its records. Tax estimates are not available yet.'
    : 'Create a personal or business profile to organise your tax records.'
  updateDraftControls()
}

async function load(): Promise<void> {
  busy = fields.disabled = true
  updateDraftControls()
  el('retry').hidden = true
  try {
    const [old, current] = await Promise.all([window.taxProfile.get(), window.taxScope.get()])
    legacy = old
    scope = current
    try {
      const raw = localStorage.getItem(setupDraftKey(scope.databaseId))
      savedDraft = readSetupDraft(raw)
      storageWarning =
        raw && !savedDraft
          ? 'An older or unreadable setup draft could not be restored. Saved profiles and records are unchanged.'
          : ''
    } catch {
      storageWarning =
        'Saved setup progress is unavailable on this device. Your saved profiles are unaffected.'
    }
    el('legacy').hidden = !legacy
    el('status').textContent = legacy
      ? 'Your previous standalone setup is preserved. You can reuse it when starting a profile.'
      : 'Open a saved profile or add a personal or business profile.'
    busy = fields.disabled = false
    listProfiles(scope)
    window.dispatchEvent(
      new CustomEvent('kasa:tax-profiles-loaded', {
        detail: { hasProfiles: Boolean(scope.taxpayers.length), hasDraft: Boolean(savedDraft) }
      })
    )
    if (!legacy && !scope.taxpayers.length && !savedDraft) start()
  } catch (error) {
    el('status').textContent =
      `Could not load profiles: ${errorText(error)}. Saved information has not been changed.`
    el('retry').hidden = false
    window.dispatchEvent(new Event('kasa:tax-profiles-load-failed'))
  }
}

form.oninput = () => {
  if (busy) return
  updateFields()
  saveDraft()
}
form.onchange = form.oninput
el('new').onclick = () => start()
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
  updateDraftControls()
  el('status').textContent =
    storageWarning || 'Setup saved for later. Your existing profiles and records are unchanged.'
  window.dispatchEvent(new Event('kasa:tax-setup-closed'))
}
window.addEventListener('kasa:tax-enrichment-dirty', updateDraftControls)
window.addEventListener('kasa:tax-activity-editing', updateDraftControls)
function updateSavedScope(event: Event): void {
  const current = (event as CustomEvent<{ scope: TaxScope }>).detail.scope
  if (!scope || current.databaseId !== scope.databaseId) return
  scope = current
  listProfiles(scope)
  if (!form.hidden && draft.step === 3) showActivity()
}
window.addEventListener('kasa:tax-scope-updated', updateSavedScope)
window.addEventListener('kasa:tax-activity-updated', updateSavedScope)
form.onsubmit = async (event) => {
  event.preventDefault()
  if (busy) return
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
    scope = await window.taxScope.change({
      kind: 'create-profile',
      label: draft.label.trim(),
      profile
    })
    form.hidden = true
    clearDraft()
    listProfiles(scope)
    el('status').textContent =
      `Created profile: ${draft.label.trim()}. Your dashboard is ready to review. Existing profiles and records are unchanged.${storageWarning ? ` ${storageWarning}` : ''}`
    el('notes').replaceChildren()
    for (const note of taxProfileNotes(profile)) {
      const item = document.createElement('li')
      item.textContent = note
      el('notes').append(item)
    }
    window.dispatchEvent(new Event('kasa:tax-profile-created'))
    window.dispatchEvent(new Event('kasa:tax-profile-saved'))
    window.dispatchEvent(new Event('kasa:tax-setup-closed'))
  } catch (error) {
    el('status').textContent =
      `Profile not created: ${errorText(error)}. Your answers are retained; try again.`
  } finally {
    busy = fields.disabled = false
    updateDraftControls()
  }
}
void load()
