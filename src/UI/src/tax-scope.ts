import { taxOverview } from './tax-overview'
import { enrichmentQuestions, relatedRecordCandidates } from './tax-enrichment-flow'
import { taxRecordLabel } from './tax-record-label'
import { emptyValuation, type TaxEnrichment, type Valuation } from '../../shared/tax-enrichment'
import {
  calculationCompleteness,
  recordKeys,
  scopedRecords,
  type TaxScope,
  type TaxActivitySnapshot,
  type ScopeCommand
} from '../../shared/tax-scope'
import type { TaxAccount, TaxAsset } from '../../shared/tax-scope'
import type { KasaSnapshot } from '../../preload/index.d'

const element = (id: string): HTMLElement => document.getElementById(id)!
const select = (id: string): HTMLSelectElement => element(id) as HTMLSelectElement
const value = (id: string): string => (element(id) as HTMLInputElement).value
const fields = element('tax-scope-fields') as HTMLFieldSetElement
let state: TaxScope | undefined
let snapshot: KasaSnapshot = { invoices: [], payments: [], proposals: [] }
let busy = false
let enrichmentDirty = false
let draftRelated = ''

function options(id: string, rows: [string, string][], placeholder: string): void {
  const input = select(id)
  const selected = input.value
  input.replaceChildren()
  for (const [key, label] of [['', placeholder], ...rows]) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = label
    input.append(option)
  }
  if (rows.some(([key]) => key === selected)) input.value = selected
}
function report(): void {
  if (!state) return
  const taxpayerId = value('scope-taxpayer')
  const taxpayer = state.taxpayers.find((t) => t.id === taxpayerId)
  element('scope-profile').textContent = taxpayer
    ? `${taxpayer.profile.userType === 'personal' ? 'Personal' : 'Business / professional'} · ${taxpayer.profile.country === 'IT' ? 'Italy' : 'Other country'} · ${taxpayer.profile.taxYear}`
    : 'Choose a saved profile, or add one in Profile.'
  const selected = scopedRecords(
    state,
    snapshot,
    taxpayerId,
    value('scope-account'),
    value('scope-asset')
  )
  const known = recordKeys(snapshot)
  const assigned = state.assignments.filter((a) => known.has(a.recordKey)).length
  element('scope-record-counts').textContent =
    `Selection: ${selected.invoices.length} invoices, ${selected.payments.length} payment observations (all dates). Database-wide: ${known.size - assigned} unassigned records. ${state.assignments.length - assigned} assignments refer to records no longer present. No amounts are aggregated across assets.`
  enrichmentOptions()
  renderOverview()
  const container = element('scope-completeness')
  container.replaceChildren()
  if (!taxpayer) {
    container.textContent = 'Select a profile above to see the requirements that apply to it.'
    return
  }
  if (taxpayer.profile.country !== 'IT') {
    container.textContent =
      'Italian calculations are not supported for this profile’s country. You can organise records, but local tax requirements need professional review.'
    return
  }
  const requirements = calculationCompleteness(
    state,
    snapshot,
    taxpayerId,
    value('scope-account'),
    value('scope-asset')
  )
  const applicable = requirements.filter((r) => r.status === 'missing-data')
  const common = applicable.length
    ? applicable[0].missing.filter((reason) => applicable.every((r) => r.missing.includes(reason)))
    : []
  const addDetails = (title: string, reasons: string[]): void => {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = title
    const list = document.createElement('ul')
    for (const reason of reasons) {
      const li = document.createElement('li')
      li.textContent = reason
      list.append(li)
    }
    details.append(summary, list)
    container.append(details)
  }
  if (common.length) addDetails('Shared requirements · review these once', common)
  for (const item of requirements.filter((r) => r.status !== 'not-applicable')) {
    addDetails(
      `${item.calculation} · ${item.status === 'unsupported' ? 'Not supported for this profile' : 'More information and review needed'}`,
      item.missing.filter((reason) => !common.includes(reason))
    )
  }
  const inactive = requirements.filter((r) => r.status === 'not-applicable')
  if (inactive.length)
    addDetails(
      'Not enabled for this declared profile',
      inactive.map((r) => `${r.calculation}: recheck if your circumstances change.`)
    )
}
function accounts(): void {
  options(
    'scope-account',
    state!.accounts
      .filter((a) => a.taxpayerId === value('scope-taxpayer'))
      .map((a) => [a.id, accountLabel(a)]),
    'All accounts'
  )
  options(
    'scope-assign-account',
    state!.accounts
      .filter((a) => a.taxpayerId === value('scope-taxpayer'))
      .map((a) => [a.id, accountLabel(a)]),
    'Choose an account'
  )
  ;(element('scope-account-fields') as HTMLFieldSetElement).disabled = !value('scope-taxpayer')
  list(
    'scope-account-list',
    state!.accounts.filter((a) => a.taxpayerId === value('scope-taxpayer')).map(accountLabel),
    value('scope-taxpayer')
      ? 'No accounts yet. Add one below, or return later.'
      : 'Select a profile above before adding accounts.'
  )
  assignmentPreview()
  report()
}
function render(): void {
  options(
    'scope-taxpayer',
    state!.taxpayers.map((t) => [
      t.id,
      `${t.label} · ${t.profile.taxYear} · ${t.profile.userType}`
    ]),
    'Select taxpayer'
  )
  options(
    'scope-asset',
    state!.assets.map((a) => [
      a.id,
      `${a.symbol} · ${a.network} · ${a.canonicalId} · ${a.environment} · ${a.decimals} decimals`
    ]),
    'All assets'
  )
  options(
    'scope-assign-asset',
    state!.assets.map((a) => [a.id, assetLabel(a)]),
    'Choose an asset — leave unassigned if unsure'
  )
  list(
    'scope-asset-list',
    state!.assets.map(assetLabel),
    'No assets identified yet. Add one only when you can confirm its identity.'
  )
  options(
    'scope-record',
    [...recordKeys(snapshot)].map((key) => [
      key,
      `${taxRecordLabel(snapshot, key)} · ${state!.assignments.some((a) => a.recordKey === key) ? 'Assigned' : 'Unassigned'}`
    ]),
    snapshot.invoices.length + snapshot.payments.length
      ? 'Choose a record from the local database'
      : 'No local records available'
  )
  if (state!.activeTaxpayerId) select('scope-taxpayer').value = state!.activeTaxpayerId
  accounts()
}
async function load(command?: ScopeCommand): Promise<void> {
  if (busy || enrichmentDirty || element('view-tax').dataset.activityEditing === 'true') return
  busy = fields.disabled = true
  element('view-tax').dataset.scopeBusy = 'true'
  window.dispatchEvent(new Event('kasa:tax-scope-busy'))
  select('scope-taxpayer').disabled = true
  ;(element('enrichment-fields') as HTMLFieldSetElement).disabled = true
  select('enrichment-record').disabled = true
  element('tax-scope-status').textContent = command
    ? 'Saving local declaration…'
    : 'Reading local database and declarations…'
  try {
    snapshot = await window.kasa.snapshot()
    state = command ? await window.taxScope.change(command) : await window.taxScope.get() // Database only; never call a wallet adapter here.
    render()
    if (command?.kind === 'account') {
      const account = state.accounts.at(-1)!
      select('scope-assign-account').value = account.id
      ;(element('scope-account-panel') as HTMLDetailsElement).open = false
      ;(element('scope-account-form') as HTMLFormElement).reset()
      ownershipFields()
    }
    if (command?.kind === 'asset') {
      select('scope-assign-asset').value = state.assets.at(-1)!.id
      ;(element('scope-asset-panel') as HTMLDetailsElement).open = false
      ;(element('scope-asset-form') as HTMLFormElement).reset()
    }
    ;(element('scope-replace-confirm') as HTMLInputElement).checked = false
    assignmentPreview()
    element('tax-scope-status').textContent =
      command?.kind === 'account'
        ? 'Account saved for this profile. Next, identify the asset and assign a record.'
        : command?.kind === 'asset'
          ? 'Asset saved. You can now choose it when assigning a record.'
          : command?.kind === 'history-coverage'
            ? 'History answer saved for this profile. This is a declaration, not verification.'
            : command?.kind === 'assign'
              ? 'Record assignment saved. Original ledger data is unchanged.'
              : command?.kind === 'unassign'
                ? 'Assignment removed. The original record is still in the database.'
                : 'Saved information loaded from this device. No wallet connection was made.'
    fields.disabled = false
    select('enrichment-record').disabled = false
    window.dispatchEvent(new CustomEvent('kasa:tax-scope-updated', { detail: { scope: state } }))
  } catch (error) {
    element('tax-scope-status').textContent =
      `Could not complete this action: ${String(error instanceof Error ? error.message : error)}. Your form entries are retained; correct them or reload to retry.`
    if (state) {
      fields.disabled = false
      select('enrichment-record').disabled = false
      restoreEnrichment()
    }
  } finally {
    busy = false
    element('view-tax').dataset.scopeBusy = 'false'
    if (state) lockRecordNavigation()
    window.dispatchEvent(new Event('kasa:tax-scope-idle'))
  }
}
function submit(id: string, command: () => ScopeCommand): void {
  ;(element(id) as HTMLFormElement).onsubmit = (event) => {
    event.preventDefault()
    if (
      id === 'scope-assignment-form' &&
      (element('scope-assign-save') as HTMLButtonElement).disabled
    )
      return
    void load(command())
  }
}
submit('scope-history-form', () => ({
  kind: 'history-coverage',
  taxpayerId: value('scope-taxpayer'),
  coverage: value('scope-history') as 'unknown' | 'incomplete' | 'complete'
}))
select('scope-history').onchange = () => {
  element('scope-history-saved').textContent =
    'Unsaved answer. Choose Save history answer to apply it.'
}
submit('scope-account-form', () => ({
  kind: 'account',
  taxpayerId: value('scope-taxpayer'),
  label: value('scope-account-label'),
  ownershipBps:
    value('scope-account-ownership') === 'unknown'
      ? null
      : value('scope-account-ownership') === 'full'
        ? 10000
        : Math.round(Number(value('scope-account-share')) * 100),
  accountKind: value('scope-account-kind') as 'unknown' | 'provider' | 'self-custody'
}))
submit('scope-asset-form', () => ({
  kind: 'asset',
  symbol: value('scope-asset-symbol'),
  canonicalId: value('scope-asset-canonical'),
  network: value('scope-asset-network'),
  decimals: Number(value('scope-asset-decimals')),
  environment: value('scope-asset-environment') as 'unknown' | 'test' | 'live'
}))
submit('scope-assignment-form', () => ({
  kind: 'assign',
  recordKey: value('scope-record'),
  accountId: value('scope-assign-account'),
  assetId: value('scope-assign-asset')
}))
element('scope-unassign').onclick = () => {
  if (!(element('scope-replace-confirm') as HTMLInputElement).checked) return
  void load({ kind: 'unassign', recordKey: value('scope-record') })
}
element('tax-scope-refresh').onclick = () => {
  void load()
}
select('scope-taxpayer').onchange = async () => {
  if (busy || enrichmentDirty) {
    select('scope-taxpayer').value = state?.activeTaxpayerId ?? ''
    return
  }
  if (!value('scope-taxpayer')) {
    select('scope-taxpayer').value = state?.activeTaxpayerId ?? ''
    return
  }
  await load({ kind: 'select-taxpayer', taxpayerId: value('scope-taxpayer') })
  // A failed selection must not leave the screen on a different profile from the saved one.
  select('scope-taxpayer').value = state?.activeTaxpayerId ?? ''
  accounts()
  window.dispatchEvent(new Event('kasa:tax-profile-saved'))
}
window.addEventListener('kasa:tax-profile-created', () => {
  void load()
})
window.addEventListener('kasa:tax-activity-updated', (event) => {
  if (busy || enrichmentDirty) return
  const next = (event as CustomEvent<TaxActivitySnapshot>).detail
  if (state && next.scope.databaseId !== state.databaseId) return
  const previousProfile = state?.taxpayers.find((t) => t.id === state?.activeTaxpayerId)
  const historyAnswer = select('scope-history').value
  const unsavedHistory =
    previousProfile && historyAnswer !== previousProfile.profile.recordsCoverage
  state = next.scope
  snapshot = next.snapshot
  render()
  if (unsavedHistory && previousProfile.id === state.activeTaxpayerId) {
    select('scope-history').value = historyAnswer
    element('scope-history-saved').textContent =
      'Unsaved answer. Choose Save history answer to apply it.'
  }
  lockRecordNavigation()
})
window.addEventListener('kasa:tax-activity-editing', () => {
  if (state) lockRecordNavigation()
})
select('scope-account').onchange = report
select('scope-asset').onchange = report
void load()

function enrichmentOptions(): void {
  if (!state) return
  const selected = scopedRecords(
    state,
    snapshot,
    value('scope-taxpayer'),
    value('scope-account'),
    value('scope-asset')
  )
  options(
    'enrichment-record',
    [...recordKeys(selected)].map((key) => [key, taxRecordLabel(snapshot, key)]),
    'Select assigned record'
  )
  options(
    'enrichment-fee-asset',
    state.assets.map((a) => [
      a.id,
      `${a.symbol} · ${a.network} · ${a.canonicalId} · ${a.environment}`
    ]),
    'Select fee asset'
  )
  restoreEnrichment()
}
function setValue(id: string, text: string): void {
  ;(element(id) as HTMLInputElement).value = text
}
function restoreEnrichment(): void {
  const key = value('enrichment-record')
  const saved = state?.enrichments?.find((e) => e.recordKey === key)
  enrichmentDirty = false
  draftRelated = saved?.relatedRecordKey ?? ''
  element('enrichment-fields').hidden = !key
  element('enrichment-record-context').textContent = key
    ? `${taxRecordLabel(snapshot, key)}. This is a database observation, not proof of settlement.`
    : 'No record selected. Assign a record above, or change the review filters to find an assigned record.'
  for (const id of [
    'enrichment-value-section',
    'enrichment-evidence-section',
    'enrichment-fee-section',
    'enrichment-fee-value-section',
    'enrichment-remove-section'
  ])
    (element(id) as HTMLDetailsElement).open = false
  ;(element('enrichment-clear-confirm') as HTMLInputElement).checked = false
  ;(element('enrichment-clear') as HTMLButtonElement).disabled = true
  element('enrichment-remove-section').hidden = !saved
  ;(element('enrichment-fields') as HTMLFieldSetElement).disabled = !key
  setValue('enrichment-classification', saved?.classification ?? 'unknown')
  setValue('enrichment-fee-status', saved?.fee.status ?? 'unknown')
  setValue('enrichment-fee-amount', saved?.fee.amount ?? '')
  setValue('enrichment-fee-asset', saved?.fee.assetId ?? '')
  setValue('enrichment-fee-purpose', saved?.fee.purpose ?? '')
  setValue('enrichment-fee-reference', saved?.fee.reference ?? '')
  for (const [prefix, v] of [
    ['enrichment', saved?.valuation ?? emptyValuation()],
    ['enrichment-fee', saved?.fee.valuation ?? emptyValuation()]
  ] as const) {
    for (const field of ['eur', 'date', 'source'] as const) setValue(`${prefix}-${field}`, v[field])
    setValue(`${prefix}-evidence`, v.reference)
  }
  enrichmentQuestionsChanged()
  feeVisibility()
  lockRecordNavigation()
  element('enrichment-status').textContent = saved
    ? 'Saved locally. Values and references are unverified; evidence documents are not stored.'
    : key
      ? 'No saved details. You can save incomplete information; blank values remain unknown.'
      : 'Select an assigned record to begin.'
}
function enrichmentQuestionsChanged(): void {
  const classification = value('enrichment-classification') as TaxEnrichment['classification']
  const question = enrichmentQuestions[classification]
  element('enrichment-explanation').textContent = question.explanation
  element('enrichment-value-question').textContent = question.value
  const linked = ['own-transfer', 'refund'].includes(classification)
  element('enrichment-related-section').hidden = !linked
  select('enrichment-related').disabled = !linked
  element('enrichment-related-label').textContent =
    classification === 'refund'
      ? 'Which original record does this refund relate to?'
      : 'Which payment shows the other side of this transfer?'
  const keys = state
    ? relatedRecordCandidates(
        state,
        recordKeys(snapshot),
        value('enrichment-record'),
        classification
      )
    : []
  options(
    'enrichment-related',
    keys.map((key) => [key, taxRecordLabel(snapshot, key)]),
    'I cannot link it yet'
  )
  if (linked && draftRelated && keys.includes(draftRelated))
    setValue('enrichment-related', draftRelated)
  // Keep an existing orphan visible rather than silently deleting saved information.
  const savedLink = state?.enrichments?.find(
    (e) => e.recordKey === value('enrichment-record')
  )?.relatedRecordKey
  if (linked && draftRelated && draftRelated === savedLink && !keys.includes(draftRelated)) {
    const option = document.createElement('option')
    option.value = draftRelated
    option.textContent = `${draftRelated} · Saved link unavailable for this selection; review before saving`
    select('enrichment-related').append(option)
    select('enrichment-related').value = draftRelated
  }
  element('enrichment-related-help').textContent =
    classification === 'own-transfer'
      ? `${keys.length ? 'Only matching payment observations are listed.' : 'No matching payment observations are available.'} Both sides must be assigned to different accounts of this taxpayer and the same asset. You can save without a link and reconcile later.`
      : `${keys.length ? 'Records assigned to this taxpayer are listed.' : 'No other records are available for this taxpayer.'} Choose the original transaction, or leave this unresolved. The link does not change either record.`
  changeWarning()
}
function feeVisibility(): void {
  const recorded = value('enrichment-fee-status') === 'recorded'
  const details = element('enrichment-fee-details') as HTMLFieldSetElement
  details.hidden = details.disabled = !recorded
  changeWarning()
}
function changeWarning(): void {
  const saved = state?.enrichments?.find((e) => e.recordKey === value('enrichment-record'))
  const messages: string[] = []
  if (
    saved?.relatedRecordKey &&
    !['own-transfer', 'refund'].includes(value('enrichment-classification'))
  )
    messages.push('Saving this classification removes the previous related-record link.')
  if (saved?.fee.status === 'recorded' && value('enrichment-fee-status') !== 'recorded')
    messages.push(
      'Saving this fee choice removes the previously recorded fee details. Discard edits to keep them.'
    )
  element('enrichment-change-warning').textContent = messages.join(' ')
}
function lockRecordNavigation(): void {
  const activityEditing = element('view-tax').dataset.activityEditing === 'true'
  const locked = busy || enrichmentDirty || activityEditing
  fields.disabled = locked
  select('scope-taxpayer').disabled = locked
  select('enrichment-record').disabled = locked
  ;(element('enrichment-fields') as HTMLFieldSetElement).disabled =
    busy || activityEditing || !value('enrichment-record')
  ;(element('tax-scope-refresh') as HTMLButtonElement).disabled = locked
  element('view-tax').dataset.enrichmentDirty = String(enrichmentDirty)
  window.dispatchEvent(
    new CustomEvent('kasa:tax-enrichment-dirty', { detail: { dirty: enrichmentDirty } })
  )
}
function markEnrichmentDirty(): void {
  if (!value('enrichment-record') || busy) return
  enrichmentDirty = true
  lockRecordNavigation()
  element('enrichment-status').textContent =
    'Unsaved changes. Save or discard edits before switching records or filters.'
}
function readValuation(prefix: string): Valuation {
  return {
    eur: value(`${prefix}-eur`),
    date: value(`${prefix}-date`),
    source: value(`${prefix}-source`),
    reference: value(`${prefix}-evidence`)
  }
}
async function saveEnrichment(clear = false): Promise<void> {
  if (busy || !state) return
  if (clear && !(element('enrichment-clear-confirm') as HTMLInputElement).checked) return
  const assignment = state.assignments.find((a) => a.recordKey === value('enrichment-record'))
  if (!assignment) return
  busy = fields.disabled = true
  ;(element('enrichment-fields') as HTMLFieldSetElement).disabled = true
  select('enrichment-record').disabled = true
  element('enrichment-status').textContent = 'Saving…'
  try {
    const enrichment: TaxEnrichment = {
      ...assignment,
      classification: value('enrichment-classification') as TaxEnrichment['classification'],
      valuation: readValuation('enrichment'),
      fee: {
        status: value('enrichment-fee-status') as TaxEnrichment['fee']['status'],
        amount: value('enrichment-fee-amount'),
        assetId: value('enrichment-fee-asset'),
        purpose: value('enrichment-fee-purpose'),
        reference: value('enrichment-fee-reference'),
        valuation: readValuation('enrichment-fee')
      },
      relatedRecordKey: value('enrichment-related')
    }
    state = await window.taxScope.change(
      clear
        ? { kind: 'clear-enrichment', recordKey: assignment.recordKey }
        : { kind: 'enrich', enrichment }
    )
    report()
  } catch (error) {
    element('enrichment-status').textContent =
      `Could not save: ${error instanceof Error ? error.message : String(error)}. Your edits are retained.`
  } finally {
    busy = false
    lockRecordNavigation()
    ;(element('enrichment-fields') as HTMLFieldSetElement).disabled = false
  }
}
select('enrichment-record').onchange = restoreEnrichment
select('enrichment-classification').onchange = () => {
  enrichmentQuestionsChanged()
  markEnrichmentDirty()
}
select('enrichment-fee-status').onchange = () => {
  feeVisibility()
  markEnrichmentDirty()
}
select('enrichment-related').onchange = () => {
  draftRelated = value('enrichment-related')
  markEnrichmentDirty()
}
element('enrichment-form').addEventListener('input', (event) => {
  if ((event.target as HTMLElement).id !== 'enrichment-clear-confirm') markEnrichmentDirty()
})
element('enrichment-clear-confirm').onchange = () => {
  ;(element('enrichment-clear') as HTMLButtonElement).disabled = !(
    element('enrichment-clear-confirm') as HTMLInputElement
  ).checked
}
element('enrichment-form').addEventListener(
  'invalid',
  (event) => {
    let parent = (event.target as HTMLElement).parentElement
    while (parent && parent.id !== 'enrichment-form') {
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
      parent = parent.parentElement
    }
  },
  true
)
element('enrichment-discard').onclick = restoreEnrichment
element('enrichment-clear').onclick = () => {
  void saveEnrichment(true)
}
;(element('enrichment-form') as HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  void saveEnrichment()
}

function accountLabel(account: TaxAccount): string {
  return `${account.label} · ${account.ownershipBps === null ? 'Ownership unsure' : `${account.ownershipBps / 100}% owned`} · ${account.kind === 'provider' ? 'Exchange / custodian' : account.kind === 'self-custody' ? 'Self-custody wallet' : 'Account type unsure'}`
}
function assetLabel(asset: TaxAsset): string {
  return `${asset.symbol} · ${asset.network} · ${asset.environment === 'test' ? 'Test activity' : asset.environment === 'live' ? 'Real activity (declared)' : 'Activity unsure'} · ${asset.canonicalId}`
}
function list(id: string, labels: string[], empty: string): void {
  element(id).replaceChildren()
  for (const label of labels.length ? labels : [empty]) {
    const li = document.createElement('li')
    li.textContent = label
    element(id).append(li)
  }
}
function ownershipFields(): void {
  const partial = value('scope-account-ownership') === 'partial'
  element('scope-account-share-field').hidden = !partial
  const share = element('scope-account-share') as HTMLInputElement
  share.disabled = !partial
  share.required = partial
}
function assignmentPreview(): void {
  if (!state) return
  const key = value('scope-record')
  const old = state.assignments.find((a) => a.recordKey === key)
  const account = state.accounts.find(
    (a) => a.id === value('scope-assign-account') && a.taxpayerId === value('scope-taxpayer')
  )
  const asset = state.assets.find((a) => a.id === value('scope-assign-asset'))
  const taxpayer = state.taxpayers.find((t) => t.id === value('scope-taxpayer'))
  element('scope-record-preview').textContent = key
    ? `${taxRecordLabel(snapshot, key)}. Dates are recorded dates, not confirmed fiscal recognition dates.`
    : 'Choose a record to see its date, status and reference. No new wallet data is fetched.'
  const previousAccount = state.accounts.find((a) => a.id === old?.accountId)
  const previousTaxpayer = state.taxpayers.find((t) => t.id === previousAccount?.taxpayerId)
  element('scope-assignment-owner').textContent = old
    ? `Currently assigned to ${previousTaxpayer?.label} / ${previousAccount?.label} / ${state.assets.find((a) => a.id === old.assetId)?.symbol}.`
    : key
      ? 'This record is unassigned.'
      : ''
  element('scope-assignment-preview').textContent =
    account && asset && taxpayer
      ? `Save under ${taxpayer.label} → ${account.label} → ${assetLabel(asset)}. This does not change the recorded amount.`
      : 'Choose a profile, an account and an identified asset before saving. You can leave the record unassigned.'
  element('scope-replace-field').hidden = !old
  const confirmation = element('scope-replace-confirm') as HTMLInputElement
  const changing = old && (old.accountId !== account?.id || old.assetId !== asset?.id)
  confirmation.required = Boolean(changing)
  ;(element('scope-assign-save') as HTMLButtonElement).disabled =
    !key || !account || !asset || Boolean(changing && !confirmation.checked)
  ;(element('scope-unassign') as HTMLButtonElement).disabled = !old || !confirmation.checked
}
select('scope-account-ownership').onchange = ownershipFields
for (const id of ['scope-record', 'scope-assign-account', 'scope-assign-asset'])
  select(id).onchange = () => {
    ;(element('scope-replace-confirm') as HTMLInputElement).checked = false
    assignmentPreview()
  }
element('scope-replace-confirm').onchange = assignmentPreview
for (const name of ['account', 'asset'])
  element(`scope-${name}-later`).onclick = () => {
    ;(element(`scope-${name}-panel`) as HTMLDetailsElement).open = false
    element('tax-scope-status').textContent =
      'Nothing was saved. You can return to this section later; records can stay unassigned.'
  }
// Reveal collapsed required fields before the browser focuses an invalid input.
element('scope-asset-form').addEventListener(
  'invalid',
  () => {
    ;(element('scope-asset-technical') as HTMLDetailsElement).open = true
  },
  true
)
ownershipFields()

function renderOverview(): void {
  if (!state) return
  const taxpayer = state.taxpayers.find((t) => t.id === value('scope-taxpayer'))
  const totals = element('scope-overview-totals')
  const next = element('scope-next-steps')
  totals.replaceChildren()
  next.replaceChildren()
  ;(element('scope-history-save') as HTMLButtonElement).disabled = !taxpayer
  select('scope-history').disabled = !taxpayer
  element('scope-overview-status').textContent = !taxpayer
    ? 'Select or create a profile to begin.'
    : taxpayer.profile.country !== 'IT'
      ? 'Italian calculations do not apply to this country. You can still organise records.'
      : 'Profile saved. Tax estimates are not available yet; start with the next steps below.'
  element('scope-overview-unassigned').textContent = ''
  element('scope-history-saved').textContent = ''
  if (!taxpayer) {
    select('scope-history').value = 'unknown'
    return
  }
  const overview = taxOverview(state, snapshot, taxpayer.id)
  for (const [label, count] of [
    ['Accounts', overview.accounts],
    ['Identified assets in assigned records', overview.assets],
    ['Invoice requests', overview.invoices],
    ['Payment observations', overview.payments]
  ] as const) {
    const item = document.createElement('p')
    const strong = document.createElement('strong')
    strong.textContent = String(count)
    item.append(strong, ` ${label.toLowerCase()}`)
    totals.append(item)
  }
  element('scope-overview-unassigned').textContent =
    `${overview.unassigned} local database record(s) are unassigned to any profile. Review ownership before assigning them; they are not assumed to belong to this taxpayer. ${overview.orphaned} assignment(s) for this profile refer to records no longer present.`
  select('scope-history').value = taxpayer.profile.recordsCoverage
  element('scope-history-saved').textContent =
    `Saved answer: ${taxpayer.profile.recordsCoverage === 'complete' ? 'All relevant records included (declared, not verified)' : taxpayer.profile.recordsCoverage === 'incomplete' ? 'Some records are missing' : 'Not sure yet'}.`
  const add = (text: string, target?: string, record?: string): void => {
    const li = document.createElement('li')
    li.append(text)
    if (target) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn btn-s sm'
      button.textContent = record ? 'Review first record' : 'Go to section'
      button.style.marginLeft = '8px'
      button.onclick = () => {
        if (busy || enrichmentDirty) return
        if (record) {
          select('scope-account').value = ''
          select('scope-asset').value = ''
          report()
          select('enrichment-record').value = record
          restoreEnrichment()
        }
        const destination = element(target)
        window.dispatchEvent(new CustomEvent('kasa:tax-navigate', { detail: { target } }))
        if (destination.tagName === 'DETAILS') (destination as HTMLDetailsElement).open = true
        destination.tabIndex = -1
        destination.scrollIntoView({ block: 'start' })
        destination.focus({ preventScroll: true })
      }
      li.append(button)
    }
    next.append(li)
  }
  if (!overview.accounts)
    add(
      'Review saved app activity and confirm any recognised source belonging to this profile.',
      'tax-activity-title'
    )
  if (!overview.invoices && !overview.payments)
    add(
      'No records are assigned to this profile. An empty review does not mean zero tax is due.',
      'tax-activity-title'
    )
  if (overview.unassigned)
    add(
      `Review ${overview.unassigned} unassigned database record(s); assign only those belonging to this profile.`,
      'tax-activity-title'
    )
  if (overview.unknownOwnership)
    add(
      `${overview.unknownOwnership} account(s) have unknown ownership shares. Confirm them against supporting records; ownership editing is not available yet.`,
      'scope-accounts-title'
    )
  if (overview.testAssets)
    add(
      `${overview.testAssets} assigned asset(s) represent test activity and are excluded from monetary tax estimates.`
    )
  if (overview.unknownAssets)
    add(
      `${overview.unknownAssets} assigned asset(s) have unknown real/test activity. Review their identity before calculation.`,
      'scope-assets-title'
    )
  const labels = {
    classification: 'Explain what happened',
    valuation: 'Add EUR value, valuation date, source and reference',
    fees: 'Confirm fee status or complete fee details',
    links: 'Link transfer/refund records for reconciliation'
  }
  for (const kind of ['classification', 'valuation', 'fees', 'links'] as const) {
    const keys = overview.missing[kind]
    if (keys.length) add(`${labels[kind]} · ${keys.length} record(s).`, 'enrichment-title', keys[0])
  }
  if (taxpayer.profile.recordsCoverage !== 'complete')
    add(
      'Confirm whether you have included all relevant history, including earlier acquisitions.',
      'scope-history-form'
    )
  if (
    taxpayer.profile.businessType === 'unknown' ||
    taxpayer.profile.personalRegime === 'unknown' ||
    taxpayer.profile.businessRegime === 'unknown'
  )
    add(
      'Confirm the business type or tax arrangement with your adviser. This profile still contains an unsure answer.'
    )
  if (overview.orphaned)
    add(
      'Reconcile assignments whose source records are missing. Saved details have been retained for review.'
    )
  add(
    'Before calculating: reconcile invoices and payments, verify ownership and evidence, and review the calculation-specific requirements below. Filled fields are not proof of compliance.',
    'scope-checklist-title'
  )
}
