import type { KasaSnapshot } from '../../preload/index.d'
import type { TaxScope } from '../../shared/tax-scope'
import { taxScopeKey } from '../../shared/tax-selection'
import type { TaxDisposalBasis } from '../../shared/tax-disposal-basis'
import { personalBtcRules } from '../../shared/personal-btc-rules'
import { buildPersonalDisposalEstimate, createDisposalFacts } from './personal-disposal'
import { buildTaxReport, type TaxReport } from './tax-report'

const el = (id: string): HTMLElement => document.getElementById(id)!
const field = (name: string): HTMLInputElement => el(`tax-basis-${name}`) as HTMLInputElement
const root = el('view-tax')
type Context = { scope: TaxScope; snapshot: KasaSnapshot; report: TaxReport }
let context: Context | null = null
let selected = ''
let draftKey = ''
let draftFacts = ''
let original = ''
let currentFacts = ''
let currentSaved = ''
let dirty = false
let saving = false
let disposed = false
let editable = false
const signature = (value: unknown): string => JSON.stringify(value ?? null)
const money = (value: string): string => {
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}
const editingElsewhere = (): boolean =>
  [
    'scopeBusy',
    'enrichmentDirty',
    'activityEditing',
    'taxQuestionsDirty',
    'appProfileBusy',
    'appProfileDirty',
    'taxSetupDirty'
  ].some((key) => root.dataset[key] === 'true')
function saved(c: Context): TaxDisposalBasis | undefined {
  return c.scope.disposalBases?.find(
    (basis) =>
      basis.recordKey === selected &&
      basis.taxpayerId === c.report.taxpayer.id &&
      basis.taxYear === c.report.year
  )
}
function stale(): boolean {
  return (
    !context ||
    context.report.scopeKey !== draftKey ||
    taxScopeKey(context.scope) !== draftKey ||
    currentSaved !== original ||
    currentFacts !== draftFacts
  )
}
function showCalculation(visible: boolean): void {
  for (const suffix of ['summary', 'reasons', 'rows', 'excluded'])
    el(`tax-personal-${suffix}`).hidden = !visible
}
function controls(): void {
  const blocked = saving || editingElsewhere()
  field('record').disabled = blocked || dirty || !context
  ;(el('tax-basis-fields') as HTMLFieldSetElement).disabled = blocked || !context || !editable
  field('save').disabled = blocked || !editable || stale()
  field('details').disabled = blocked || dirty || !context || !selected
  field('discard').disabled = saving || !dirty
}
function markDirty(value: boolean): void {
  dirty = value
  const locked = String(dirty || saving)
  if (root.dataset.taxBasisDirty !== locked) {
    root.dataset.taxBasisDirty = locked
    window.dispatchEvent(
      new CustomEvent('kasa:tax-basis-dirty', { detail: { dirty: dirty || saving } })
    )
  }
  controls()
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  return result
}
function render(): void {
  if (!context || dirty || saving) return
  const { scope, snapshot, report } = context
  const estimate = buildPersonalDisposalEstimate(scope, snapshot, report)
  el('tax-personal-content').hidden = false
  showCalculation(true)
  el('tax-personal-context').textContent =
    `${report.taxpayer.label} · ${report.year} · Saved BTC disposals only. This is not your total tax payable.`
  el('tax-personal-status').textContent =
    estimate.status === 'estimate'
      ? 'Provisional calculation from saved records and your documented cost allocations. Recheck allocations whenever your acquisition or disposal history changes. Other taxes, income, previous losses and withholding remain outside this subtotal.'
      : estimate.status === 'unsupported'
        ? 'This profile or tax year is outside the supported personal BTC calculation.'
        : 'Not yet estimable. Resolve the missing information below; unknown amounts are never treated as zero.'
  el('tax-personal-summary').replaceChildren(
    ...[
      [
        'Net gain / loss on included disposals',
        estimate.netGainEur === null ? 'Not yet estimable' : `${money(estimate.netGainEur)} EUR`
      ],
      [
        'Applicable BTC rate',
        estimate.ratePercent === null ? 'Unsupported' : `${estimate.ratePercent}%`
      ],
      [
        'Provisional tax before other adjustments',
        estimate.taxEur === null ? 'Not yet estimable' : `${estimate.taxEur} EUR`
      ]
    ].map(([label, value]) => {
      const card = node('article', '')
      card.className = 'tax-dashboard-card'
      card.append(node('h4', label), node('strong', value))
      return card
    })
  )
  el('tax-personal-reasons').replaceChildren(
    ...estimate.reasons.map((reason) => node('li', reason))
  )
  el('tax-personal-excluded').textContent =
    `${estimate.excluded.count} excluded records. ${estimate.excluded.details.join(' ')}`
  el('tax-personal-rows').replaceChildren(
    node(
      'p',
      `${estimate.rows.length} disposal records considered.${estimate.rows.length > 100 ? ' Showing the first 100 below; use the saved disposal selector to review any record. The subtotal includes every eligible row.' : ''}`
    ),
    ...estimate.rows.slice(0, 100).map((row) => {
      const item = node('article', '')
      item.append(node('h4', row.label))
      item.append(
        node(
          'p',
          `Proceeds: ${row.proceedsEur ?? 'unknown'} EUR · allocated cost: ${row.costBasisEur ?? 'unknown'} EUR · gain/loss: ${row.gainEur ?? 'not calculated'} EUR`
        )
      )
      if (row.reasons.length) item.append(node('p', row.reasons.join(' ')))
      return item
    })
  )
  el('tax-personal-method').textContent =
    `${personalBtcRules.id} · Rules reviewed ${personalBtcRules.reviewedAt}. ${personalBtcRules.method}`
  el('tax-personal-limits').replaceChildren(
    ...estimate.limitations.map((limit) => node('li', limit))
  )
  el('tax-personal-sources').replaceChildren(
    ...personalBtcRules.sources.map((source) => {
      const li = node('li', '')
      const link = node('a', source.title)
      link.href = source.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      li.append(link, node('span', ` — ${source.detail}`))
      return li
    })
  )
  const choices = estimate.status === 'unsupported' ? [] : estimate.rows
  if (!choices.some((row) => row.recordKey === selected)) selected = choices[0]?.recordKey ?? ''
  const selector = field('record') as unknown as HTMLSelectElement
  selector.replaceChildren(
    ...choices.map((row) => {
      const option = node('option', row.label)
      option.value = row.recordKey
      return option
    })
  )
  selector.value = selected
  const basis = saved(context)
  const payment = snapshot.payments.find((item) => `payment:${item.nodeIdx}` === selected)
  const enrichment = scope.enrichments?.find((item) => item.recordKey === selected)
  editable = Boolean(
    selected && enrichment && ['sale', 'goods-services'].includes(enrichment.classification)
  )
  el('tax-basis-form').hidden = !editable
  const date =
    payment?.blockTime == null
      ? 'unknown date'
      : new Date(payment.blockTime * 1000).toLocaleDateString('en-GB', { timeZone: 'Europe/Rome' })
  el('tax-basis-record-summary').textContent = payment
    ? `${selected} · ${date} (Europe/Rome) · saved status ${payment.status}. Saved EUR consideration: ${enrichment?.valuation.eur || 'unknown'}. Edit existing record details if these are incomplete.`
    : 'No supported saved disposal is available to review.'
  field('kind').value = basis?.transactionKind ?? ''
  field('cost').value = basis?.costBasisEur ?? ''
  field('reference').value = basis?.reference ?? ''
  currentFacts = createDisposalFacts(scope, snapshot, selected)
  currentSaved = signature(basis)
  field('reviewed').checked = Boolean(basis?.reviewed && basis.facts === currentFacts)
  draftKey = report.scopeKey
  draftFacts = currentFacts
  original = currentSaved
  el('tax-basis-status').textContent =
    basis && basis.facts !== draftFacts
      ? 'The saved record or profile changed since this review. Check the evidence again before saving.'
      : 'Cost reviews are saved separately from the original ledger. Supporting references alone do not verify them.'
  controls()
}
export function updatePersonalDisposal(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  report: TaxReport
): void {
  if (disposed) return
  context = { scope, snapshot, report }
  currentFacts = createDisposalFacts(scope, snapshot, selected)
  currentSaved = signature(saved(context))
  if (dirty || saving) {
    showCalculation(false)
    el('tax-personal-status').textContent =
      'Saved records refreshed. Save or discard your draft to refresh the calculation.'
    if (stale()) {
      el('tax-basis-status').textContent =
        'The saved profile, year, record or cost review changed. Your draft is retained; discard it to reload before saving.'
    }
    controls()
  } else render()
}
export function clearPersonalDisposal(): void {
  context = null
  currentFacts = currentSaved = ''
  showCalculation(false)
  el('tax-personal-content').hidden = !dirty && !saving
  el('tax-personal-status').textContent = 'Waiting for the selected profile and saved records.'
  if (dirty || saving)
    el('tax-basis-status').textContent =
      'Your draft is retained. Saving is disabled until its saved context is confirmed.'
  controls()
}
el('tax-basis-form').addEventListener('input', () => {
  if (!context || !editable || saving || editingElsewhere()) return
  markDirty(true)
  el('tax-basis-status').textContent =
    'Unsaved cost review. Save or discard before changing records or profiles.'
})
field('record').onchange = () => {
  if (dirty || saving || editingElsewhere()) {
    field('record').value = selected
    return
  }
  selected = field('record').value
  render()
}
field('discard').onclick = () => {
  if (saving) return
  markDirty(false)
  if (context) render()
  else clearPersonalDisposal()
}
field('details').onclick = () => {
  if (!context || !selected || dirty || saving || editingElsewhere()) return
  window.dispatchEvent(
    new CustomEvent('kasa:tax-review-record', {
      detail: { taxpayerId: context.report.taxpayer.id, recordKey: selected }
    })
  )
}
;(el('tax-basis-form') as HTMLFormElement).onsubmit = async (event) => {
  event.preventDefault()
  if (!context || !editable || saving || editingElsewhere() || stale()) return
  const { report } = context
  const expectedFacts = draftFacts
  const expectedOriginal = original
  const expectedKey = draftKey
  const basis: TaxDisposalBasis = {
    taxpayerId: report.taxpayer.id,
    taxYear: report.year,
    recordKey: selected,
    facts: expectedFacts,
    transactionKind: field('kind').value as TaxDisposalBasis['transactionKind'],
    costBasisEur: field('cost').value.trim(),
    reference: field('reference').value.trim(),
    reviewed: field('reviewed').checked
  }
  saving = true
  markDirty(dirty)
  el('tax-basis-status').textContent = 'Saving the documented cost review…'
  try {
    const [scope, snapshot] = await Promise.all([window.taxScope.get(), window.kasa.snapshot()])
    if (disposed) return
    const report = buildTaxReport(scope, snapshot)
    if (
      !report ||
      report.scopeKey !== expectedKey ||
      taxScopeKey(scope) !== expectedKey ||
      signature(saved({ scope, snapshot, report })) !== expectedOriginal ||
      createDisposalFacts(scope, snapshot, selected) !== expectedFacts ||
      stale()
    )
      throw new Error(
        'The saved profile, year, record or cost review changed. Discard this draft and reload.'
      )
    const next = await window.taxScope.change({ kind: 'disposal-basis', basis })
    if (disposed) return
    saving = false
    markDirty(false)
    const sameSelection =
      context && taxScopeKey(context.scope) === expectedKey && taxScopeKey(next) === expectedKey
    const nextReport = sameSelection ? buildTaxReport(next, snapshot) : null
    if (nextReport?.scopeKey === expectedKey) updatePersonalDisposal(next, snapshot, nextReport)
    else if (context && taxScopeKey(context.scope) !== expectedKey) render()
    else clearPersonalDisposal()
    el('tax-basis-status').textContent =
      'Cost review saved locally. Payment records are unchanged; the calculation remains provisional.'
    window.dispatchEvent(
      new CustomEvent('kasa:tax-scope-updated', {
        detail: sameSelection ? { scope: next } : {}
      })
    )
  } catch (error) {
    if (!disposed)
      el('tax-basis-status').textContent =
        `Could not save: ${error instanceof Error ? error.message : String(error)}. Your edits are retained.`
  } finally {
    saving = false
    if (!disposed) markDirty(dirty)
  }
}
for (const event of [
  'kasa:app-profile-busy',
  'kasa:app-profile-dirty',
  'kasa:tax-setup-dirty',
  'kasa:tax-scope-busy',
  'kasa:tax-scope-idle',
  'kasa:tax-enrichment-dirty',
  'kasa:tax-activity-editing',
  'kasa:tax-questions-dirty'
])
  window.addEventListener(event, controls)
window.addEventListener('beforeunload', () => {
  disposed = true
})
clearPersonalDisposal()
