import { enrichmentQuestions, relatedRecordCandidates } from './tax-enrichment-flow'
import { taxRecordLabel } from './tax-record-label'
import { recordTaxpayerMap } from '../../shared/tax-record-profile'
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
const questionEditing = (): boolean =>
  element('view-tax').dataset.taxQuestionsDirty === 'true' ||
  element('view-tax').dataset.taxBasisDirty === 'true'

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
  const owners = recordTaxpayerMap(state)
  const assigned = [...known].filter((key) => owners.has(key)).length
  const orphaned = new Set(
    [...state.assignments, ...(state.recordProfiles ?? [])]
      .filter((entry) => !known.has(entry.recordKey))
      .map((entry) => entry.recordKey)
  ).size
  element('scope-record-counts').textContent =
    `Selection: ${selected.invoices.length} invoices, ${selected.payments.length} payment observations (all dates). Database-wide: ${known.size - assigned} unassigned records. ${orphaned} links or assignments refer to records no longer present. No amounts are aggregated across assets.`
  enrichmentOptions()
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
  const owners = recordTaxpayerMap(state!)
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
      `${taxRecordLabel(snapshot, key)} · ${state!.assignments.some((a) => a.recordKey === key) ? 'Assigned' : owners.has(key) ? 'Profile linked; account and asset needed' : 'Unassigned'}`
    ]),
    snapshot.invoices.length + snapshot.payments.length
      ? 'Choose a record from the local database'
      : 'No local records available'
  )
  if (state!.activeTaxpayerId) select('scope-taxpayer').value = state!.activeTaxpayerId
  renderHistoryAnswer()
  accounts()
}
async function load(command?: ScopeCommand): Promise<void> {
  if (
    busy ||
    enrichmentDirty ||
    questionEditing() ||
    element('view-tax').dataset.activityEditing === 'true'
  )
    return
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
                ? 'Record link or assignment removed. The original record is still in the database.'
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
    if (id === 'scope-assignment-form') {
      assignmentPreview()
      if ((element('scope-assign-save') as HTMLButtonElement).disabled) return
    }
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
  assignmentPreview()
  if ((element('scope-unassign') as HTMLButtonElement).disabled) return
  void load({ kind: 'unassign', recordKey: value('scope-record') })
}
element('tax-scope-refresh').onclick = () => {
  void load()
}
select('scope-taxpayer').onchange = async () => {
  if (busy || enrichmentDirty || questionEditing()) {
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
  if (busy || enrichmentDirty || questionEditing()) return
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
window.addEventListener('kasa:tax-questions-dirty', () => {
  if (state) lockRecordNavigation()
})
window.addEventListener('kasa:tax-basis-dirty', () => {
  if (state) lockRecordNavigation()
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
    [...recordKeys(selected)]
      .filter((key) => state!.assignments.some((entry) => entry.recordKey === key))
      .map((key) => [key, taxRecordLabel(snapshot, key)]),
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
  const locked = busy || enrichmentDirty || activityEditing || questionEditing()
  fields.disabled = locked
  select('scope-taxpayer').disabled = locked
  select('enrichment-record').disabled = locked
  ;(element('enrichment-fields') as HTMLFieldSetElement).disabled =
    busy || activityEditing || questionEditing() || !value('enrichment-record')
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
  if (busy || !state || questionEditing()) return
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
    window.dispatchEvent(new CustomEvent('kasa:tax-scope-updated', { detail: { scope: state } }))
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
  const previousTaxpayerId = recordTaxpayerMap(state).get(key)
  const previousTaxpayer = state.taxpayers.find((t) => t.id === previousTaxpayerId)
  element('scope-assignment-owner').textContent = old
    ? `Currently assigned to ${previousTaxpayer?.label} / ${previousAccount?.label} / ${state.assets.find((a) => a.id === old.assetId)?.symbol}.`
    : previousTaxpayer
      ? `Currently linked to ${previousTaxpayer.label}. Account, asset and ownership details still need review.`
      : key
        ? 'This record is unassigned.'
        : ''
  element('scope-assignment-preview').textContent =
    account && asset && taxpayer
      ? `Save under ${taxpayer.label} → ${account.label} → ${assetLabel(asset)}. This does not change the recorded amount.`
      : 'Choose a profile, an account and an identified asset before saving. You can leave the record unassigned.'
  const existingRelationship = Boolean(old || previousTaxpayer)
  element('scope-replace-field').hidden = !existingRelationship
  const confirmation = element('scope-replace-confirm') as HTMLInputElement
  const changing = old
    ? old.accountId !== account?.id || old.assetId !== asset?.id
    : previousTaxpayerId !== undefined && previousTaxpayerId !== account?.taxpayerId
  confirmation.required = Boolean(changing)
  ;(element('scope-assign-save') as HTMLButtonElement).disabled =
    !key || !account || !asset || Boolean(changing && !confirmation.checked)
  ;(element('scope-unassign') as HTMLButtonElement).disabled =
    !existingRelationship || !confirmation.checked
  element('scope-unassign').textContent = old ? 'Remove assignment' : 'Remove profile link'
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

function renderHistoryAnswer(): void {
  const taxpayer = state?.taxpayers.find((t) => t.id === value('scope-taxpayer'))
  ;(element('scope-history-save') as HTMLButtonElement).disabled = !taxpayer
  select('scope-history').disabled = !taxpayer
  select('scope-history').value = taxpayer?.profile.recordsCoverage ?? 'unknown'
  element('scope-history-saved').textContent = taxpayer
    ? `Saved answer: ${taxpayer.profile.recordsCoverage === 'complete' ? 'All relevant records included (declared, not verified)' : taxpayer.profile.recordsCoverage === 'incomplete' ? 'Some records are missing' : 'Not sure yet'}.`
    : ''
}

// Overview links open the existing editor; they never assign or change a record.
window.addEventListener('kasa:tax-review-record', (event) => {
  const { taxpayerId, recordKey, section } = (
    event as CustomEvent<{
      taxpayerId: string
      recordKey: string
      section?: 'purpose' | 'value' | 'fees' | 'related'
    }>
  ).detail
  if (
    busy ||
    enrichmentDirty ||
    questionEditing() ||
    element('view-tax').dataset.activityEditing === 'true'
  )
    return
  if (!state || state.activeTaxpayerId !== taxpayerId || value('scope-taxpayer') !== taxpayerId)
    return
  const selected = scopedRecords(state, snapshot, taxpayerId)
  if (!recordKeys(selected).has(recordKey)) return
  if (!state.assignments.some((entry) => entry.recordKey === recordKey)) return
  select('scope-account').value = ''
  select('scope-asset').value = ''
  report()
  select('enrichment-record').value = recordKey
  restoreEnrichment()
  const target =
    section === 'value'
      ? 'enrichment-value-section'
      : section === 'fees'
        ? 'enrichment-fee-section'
        : section === 'related'
          ? 'enrichment-related-section'
          : 'enrichment-title'
  if (section === 'value') {
    ;(element('enrichment-value-section') as HTMLDetailsElement).open = true
    ;(element('enrichment-evidence-section') as HTMLDetailsElement).open = true
  }
  if (section === 'fees') (element('enrichment-fee-section') as HTMLDetailsElement).open = true
  window.dispatchEvent(new CustomEvent('kasa:tax-navigate', { detail: { target } }))
  const destination = element(target)
  destination.tabIndex = -1
  destination.scrollIntoView({ block: 'start' })
  destination.focus({ preventScroll: true })
})
