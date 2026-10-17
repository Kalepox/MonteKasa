import {
  currentTaxYear,
  validateTaxProfile,
  taxProfileNotes,
  type TaxProfile
} from '../../shared/tax-profile'
import type { TaxScope } from '../../shared/tax-scope'

const el = (id: string): HTMLElement => document.getElementById(`tax-profile-${id}`)!
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement
const select = (id: string): HTMLSelectElement => el(id) as HTMLSelectElement
const form = el('form') as HTMLFormElement
const fields = el('fields') as HTMLFieldSetElement
let legacy: TaxProfile | null = null
let coverage: TaxProfile['recordsCoverage'] = 'unknown'
let step = 0
let busy = true
const type = (): string =>
  form.querySelector<HTMLInputElement>('input[name="tax-profile-type"]:checked')?.value ?? ''
const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

for (let year = currentTaxYear(); year >= 2023; year--) {
  const option = document.createElement('option')
  option.value = option.textContent = String(year)
  select('year').append(option)
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
  const allowed = ['sole-trader', 'professional'].includes(select('business').value)
  const forfait = select('regime').querySelector<HTMLOptionElement>('[value="forfettario"]')!
  forfait.hidden = forfait.disabled = !allowed
  if (!allowed && select('regime').value === 'forfettario') select('regime').value = 'unknown'
  el('country-label').textContent = business
    ? 'Country of tax residence or establishment'
    : 'Country of tax residence'
  el('country-warning').hidden = select('country').value !== 'other'
  input('name').placeholder = business ? 'My business taxes' : 'My personal taxes'
}
function draft(): TaxProfile {
  return validateTaxProfile({
    version: 1,
    country: select('country').value,
    taxYear: Number(select('year').value),
    userType: type(),
    personalRegime: select('personal').value,
    businessType: select('business').value,
    businessRegime: select('regime').value,
    recordsCoverage: coverage
  })
}
function summary(): void {
  const p = draft()
  const rows: [string, string][] = [
    ['Profile name', input('name').value.trim()],
    ['Activity', p.userType === 'personal' ? 'Personal' : 'Business or professional activity'],
    [
      'Country',
      p.country === 'IT' ? 'Italy' : 'Another country — Italian calculations do not apply'
    ],
    ['Tax year', String(p.taxYear)]
  ]
  for (const id of p.userType === 'personal' ? ['personal'] : ['business', 'regime']) {
    rows.push([
      id === 'personal' ? 'Tax handling' : id === 'business' ? 'Business type' : 'Tax regime',
      select(id).selectedOptions[0].textContent ?? ''
    ])
  }
  rows.push([
    'History coverage',
    coverage === 'unknown'
      ? 'Not confirmed'
      : `${coverage} — reused from previous setup, unverified`
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
function showNotes(profile: TaxProfile): void {
  el('notes').replaceChildren()
  for (const text of taxProfileNotes(profile)) {
    const li = document.createElement('li')
    li.textContent = text
    el('notes').append(li)
  }
}
function showStep(next: number, focus = true): void {
  step = next
  for (let n = 0; n < 3; n++) {
    const section = el(`step-${n}`) as HTMLFieldSetElement
    section.hidden = section.disabled = n !== step
  }
  el('progress').textContent = `Step ${step + 1} of 3 · Choose activity → Profile details → Review`
  el('step-title').textContent = [
    'Choose your activity',
    'Tell us about this profile',
    'Check your profile'
  ][step]
  el('back').hidden = step === 0
  el('next').textContent = step === 2 ? 'Create tax profile' : 'Continue'
  updateFields()
  if (step === 2) summary()
  if (focus) el('step-title').focus()
}
function start(previous: TaxProfile | null = null): void {
  if (busy) return
  form.reset()
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="tax-profile-type"]'))
    radio.checked = radio.value === previous?.userType
  input('name').value = ''
  for (const [id, value] of Object.entries({
    country: previous?.country ?? '',
    year: String(previous?.taxYear ?? currentTaxYear()),
    personal: previous?.personalRegime ?? 'unknown',
    business: previous?.businessType ?? 'unknown',
    regime: previous?.businessRegime ?? 'unknown'
  }))
    select(id).value = value
  coverage = previous?.recordsCoverage ?? 'unknown'
  form.hidden = false
  input('new').disabled = true
  input('legacy').disabled = true
  el('notes').replaceChildren()
  el('status').textContent = previous
    ? 'Previous setup copied into this draft. It remains unchanged until you create a separate profile.'
    : 'Nothing is saved until you choose Create tax profile.'
  showStep(previous ? 1 : 0)
}
function listProfiles(scope: TaxScope): void {
  el('existing').replaceChildren()
  for (const t of scope.taxpayers) {
    const li = document.createElement('li')
    li.textContent = `${t.label} · ${t.profile.userType === 'personal' ? 'Personal' : 'Business'} · ${t.profile.country === 'IT' ? 'Italy' : 'Other country'} · ${t.profile.taxYear}`
    el('existing').append(li)
  }
  el('missing').textContent = scope.taxpayers.length
    ? 'Saved profiles available. Select one below to organise its records; tax estimates are not available yet.'
    : 'Create a tax profile to organise records for a taxpayer.'
}
async function load(): Promise<void> {
  busy = fields.disabled = true
  input('new').disabled = true
  input('legacy').disabled = true
  el('retry').hidden = true
  try {
    const [old, scope] = await Promise.all([window.taxProfile.get(), window.taxScope.get()])
    legacy = old
    listProfiles(scope)
    el('legacy').hidden = !legacy
    el('status').textContent = legacy
      ? 'Your previous standalone setup is preserved. Reuse it above or create a new profile. Existing profiles are listed here.'
      : 'Choose a saved profile below, or create a new one here.'
    fields.disabled = input('new').disabled = input('legacy').disabled = false
    busy = false
    if (!legacy && !scope.taxpayers.length) start()
  } catch (error) {
    el('status').textContent =
      `Could not load profiles: ${errorText(error)}. Saved information has not been changed.`
    el('retry').hidden = false
  } finally {
    busy = false
  }
}
form.onchange = updateFields
el('new').onclick = () => start()
el('legacy').onclick = () => start(legacy)
el('retry').onclick = () => {
  void load()
}
el('back').onclick = () => {
  if (!busy) showStep(step - 1)
}
el('edit-type').onclick = () => showStep(0)
el('edit-details').onclick = () => showStep(1)
el('cancel').onclick = () => {
  if (busy) return
  form.hidden = true
  input('new').disabled = input('legacy').disabled = false
  el('notes').replaceChildren()
  el('status').textContent = 'Setup cancelled. Saved profiles and records are unchanged.'
}
form.onsubmit = async (event) => {
  event.preventDefault()
  if (busy) return
  if (!form.reportValidity()) return
  if (step === 1 && !input('name').value.trim()) {
    el('status').textContent = 'Enter a profile name so you can recognise it later.'
    input('name').focus()
    return
  }
  if (step < 2) {
    showStep(step + 1)
    return
  }
  busy = fields.disabled = true
  try {
    const profile = draft()
    const scope = await window.taxScope.change({
      kind: 'create-profile',
      label: input('name').value.trim(),
      profile
    })
    listProfiles(scope)
    form.hidden = true
    el('status').textContent =
      `Created profile: ${input('name').value.trim()}. Next, add accounts or assign records below. No records were assigned automatically.`
    showNotes(profile)
    input('new').disabled = input('legacy').disabled = false
    window.dispatchEvent(new Event('kasa:tax-profile-created'))
    window.dispatchEvent(new Event('kasa:tax-profile-saved'))
    el('status').tabIndex = -1
    el('status').focus()
  } catch (error) {
    el('status').textContent =
      `Profile not created: ${errorText(error)}. Your answers are retained; try again.`
  } finally {
    busy = fields.disabled = false
  }
}
void load()
