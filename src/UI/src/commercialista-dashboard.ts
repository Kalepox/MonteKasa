import type { TaxDashboard } from './tax-dashboard'
import type { TaxReport } from './tax-report'
import type { LedgerTotal } from './ledger'
import { calculationQuestions } from '../../shared/tax-questions'

const element = (id: string): HTMLElement => document.getElementById(id)!
let chartModel: TaxDashboard | null = null

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = ''
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

export function setTaxDashboardStatus(message: string, busy: boolean): void {
  element('tax-dashboard-status').textContent = message
  element('tax-dashboard-content').setAttribute('aria-busy', String(busy))
}

export function clearTaxDashboard(): void {
  chartModel = null
  element('tax-dashboard-title').textContent = 'A clearer view of your taxes'
  element('tax-dashboard-subtitle').textContent =
    'Your saved payments, useful estimates and the details still needed.'
  ;(element('tax-dashboard-chart-mode') as HTMLSelectElement).disabled = true
  element('tax-dashboard-chart-empty').hidden = true
  for (const id of ['chart-summary', 'months-help', 'source'])
    element(`tax-dashboard-${id}`).textContent = ''
  element('tax-dashboard-content').hidden = true
  element('tax-dashboard-freshness').hidden = true
  element('tax-profile-missing').hidden = false
  for (const id of ['context', 'coverage', 'exclusions', 'ownership'])
    element(`tax-dashboard-${id}`).textContent = ''
  for (const id of ['cards', 'assets', 'months', 'chart', 'estimates', 'next'])
    element(`tax-dashboard-${id}`).replaceChildren()
}

function amount(total: LedgerTotal, unit: string): string {
  return !total.records
    ? 'No settled records'
    : total.amount === null
      ? 'Not totalled · review needed'
      : `${total.amount} ${unit}`
}

function navigationBlocked(): boolean {
  const root = element('view-tax')
  if (root.dataset.scopeBusy === 'true') {
    element('tax-dashboard-status').textContent = 'Wait for the saved profile to finish loading.'
    return true
  }
  if (
    root.dataset.enrichmentDirty === 'true' ||
    root.dataset.appProfileBusy === 'true' ||
    root.dataset.appProfileDirty === 'true' ||
    root.dataset.taxSetupDirty === 'true' ||
    root.dataset.taxHistoryDirty === 'true' ||
    root.dataset.activityEditing === 'true' ||
    root.dataset.taxQuestionsDirty === 'true' ||
    root.dataset.taxBasisDirty === 'true'
  ) {
    element('tax-dashboard-status').textContent =
      'Save or discard your open record or preparation edits before opening another record or section.'
    return true
  }
  return false
}

function navigate(step: TaxDashboard['nextSteps'][number], taxpayerId: string): void {
  if (navigationBlocked()) return
  if (step.recordKey) {
    window.dispatchEvent(
      new CustomEvent('kasa:tax-review-record', {
        detail: { taxpayerId, recordKey: step.recordKey }
      })
    )
    return
  }
  window.dispatchEvent(new CustomEvent('kasa:tax-navigate', { detail: { target: step.target } }))
  const destination = element(step.target)
  if (destination.tagName === 'DETAILS') (destination as HTMLDetailsElement).open = true
  destination.tabIndex = -1
  destination.scrollIntoView({ block: 'start' })
  destination.focus({ preventScroll: true })
}

// Values are formatted from decimal strings; chart geometry never feeds tax arithmetic.
function euro(value: string | null): string {
  if (value === null) return '—'
  const [whole, fraction = ''] = value.split('.')
  return `€${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}

function summaryCards(model: TaxDashboard, report: TaxReport): HTMLElement[] {
  const business = report.taxpayer.profile.userType === 'business'
  const supported = report.taxpayer.profile.country === 'IT'
  const disposal = model.personalDisposal
  const hasDisposal =
    !business && disposal?.status === 'estimate' && disposal.scopeKey === model.scopeKey
  const unsupportedDisposal =
    !business && disposal?.status === 'unsupported' && disposal.scopeKey === model.scopeKey
  const definitions = [
    {
      label: business ? 'VAT estimate' : 'Bitcoin disposal estimate',
      value: hasDisposal ? euro(disposal.taxEur) : '€—',
      status: !supported
        ? 'Country not supported'
        : hasDisposal
          ? 'Provisional subtotal'
          : unsupportedDisposal
            ? 'Outside supported calculation'
            : 'Not yet estimable',
      hint: !supported
        ? 'Saved activity is available. Tax estimates for this country are not supported.'
        : business
          ? 'Invoice tax treatment is still needed. VAT is not calculated from payment amounts.'
          : hasDisposal
            ? 'Included BTC disposals only, before earlier losses and other adjustments. This is not your whole tax bill.'
            : unsupportedDisposal
              ? (disposal.reasons[0] ??
                'This profile or tax year is outside the supported Bitcoin disposal calculation.')
              : 'Review disposal values, acquisition costs and supporting history.',
      ready: hasDisposal
    },
    {
      label: business ? 'Income tax estimate' : 'Annual holding tax',
      value: '€—',
      status: supported ? 'Not yet estimable' : 'Country not supported',
      hint: business
        ? 'Needs whole-business records and tax treatment, including activity outside this app.'
        : 'Needs historical holdings, EUR values and amounts already paid.',
      ready: false
    }
  ]
  const cards = definitions.map((definition) => {
    const card = node('article', '', 'tax-dashboard-card')
    card.append(
      node('h4', definition.label),
      node('strong', definition.value, 'tax-dashboard-value'),
      node(
        'span',
        definition.status,
        `tax-estimate-badge${definition.ready ? ' tax-estimate-partial' : ''}`
      ),
      node('p', definition.hint)
    )
    return card
  })
  const { documented, total, needsDetails } = model.visuals.reviewed
  const progress = node('article', '', 'tax-dashboard-card')
  const track = node('div', '', 'tax-documentation-track')
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', 'Payment details documented; not independently verified')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', String(Math.max(1, total)))
  track.setAttribute('aria-valuenow', String(documented))
  track.setAttribute(
    'aria-valuetext',
    total ? `${documented} of ${total} settled payments` : 'No settled payments to review'
  )
  const fill = node('span')
  fill.style.width = `${total ? Math.min(100, (documented / total) * 100) : 0}%`
  track.append(fill)
  progress.append(
    node('h4', 'Payment details documented'),
    node('strong', total ? `${documented} of ${total}` : '—', 'tax-dashboard-value'),
    track,
    node(
      'p',
      total
        ? `${needsDetails} need supporting details. Saved fields are not independent verification or tax approval.`
        : 'No settled, dated payments in this year. An empty ledger does not establish zero tax.'
    )
  )
  cards.push(progress)
  return cards
}

function chartTick(value: number, mode: 'eur' | 'count'): string {
  const prefix = mode === 'eur' ? '€' : ''
  // Tiny saved values must not look like zero; exact amounts remain in the table.
  if (value > 0 && value < 0.0001) return `${prefix}${value.toExponential(1)}`
  const precision =
    value > 0 && value < 1 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(value)) + 1)) : 1
  return `${prefix}${value.toLocaleString('en-GB', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: precision
  })}`
}

function renderPaymentChart(model: TaxDashboard, requested: 'eur' | 'count'): void {
  const { activity, coverage } = model.visuals
  const mode = requested === 'eur' && activity.eligiblePayments ? 'eur' : 'count'
  const selector = element('tax-dashboard-chart-mode') as HTMLSelectElement
  selector.replaceChildren()
  for (const [value, label] of [
    ['eur', 'EUR with evidence'],
    ['count', 'Payment count']
  ]) {
    const option = node('option', label)
    option.value = value
    option.disabled = value === 'eur' && !activity.eligiblePayments
    selector.append(option)
  }
  selector.value = mode
  selector.disabled = false
  element('tax-dashboard-months-title').textContent =
    `Payment activity · ${mode === 'eur' ? 'EUR' : 'payments'}`
  element('tax-dashboard-chart-summary').textContent =
    mode === 'eur'
      ? `Received ${euro(activity.incoming)} · Sent ${euro(activity.outgoing)} · ${activity.eligiblePayments} of ${activity.totalPayments} settled payments have eligible EUR evidence`
      : `${model.counts.settledIncoming} received · ${model.counts.settledOutgoing} sent · saved settled payment observations`
  element('tax-dashboard-months-help').textContent =
    mode === 'eur'
      ? `${activity.eligiblePayments < activity.totalPayments ? 'Partial evidence view' : 'Saved evidence view'}: ${activity.eligiblePayments} of ${activity.totalPayments} settled payments included. Uses saved EUR values, with no exchange-rate lookup. Test/demo, unknown or conflicting sources, duplicate observations and missing evidence are excluded. Values show full payments before ownership shares. Money received is not the same as taxable profit.`
      : `Counts of saved settled payment observations, not money or tax amounts. Includes ${coverage.testOrDemo} test/demo and ${coverage.unknownSource} unidentified records where settled and dated; repeated observations may be counted separately. Unsettled and undated records are outside the bars. Money received is not the same as taxable profit.`
  const countMaximum = Math.max(
    1,
    ...activity.months.flatMap((month) => [month.incomingCount, month.outgoingCount])
  )
  const maximum = mode === 'eur' ? Number(activity.scaleMaximum ?? 0) : countMaximum
  const axis = node('div', '', 'tax-chart-axis')
  for (const value of new Set([maximum, maximum / 2, 0])) {
    if (mode === 'count' && !Number.isInteger(value)) continue
    axis.append(node('span', chartTick(value, mode)))
  }
  const plot = node('div', '', 'tax-chart-plot')
  const rows: HTMLElement[] = []
  for (const month of activity.months) {
    const group = node('div', '', 'tax-chart-month')
    const pair = node('div', '', 'tax-chart-pair')
    const values =
      mode === 'eur'
        ? [euro(month.incoming), euro(month.outgoing)]
        : [String(month.incomingCount), String(month.outgoingCount)]
    const ratios =
      mode === 'eur'
        ? [month.incomingRatio, month.outgoingRatio]
        : [month.incomingCount / countMaximum, month.outgoingCount / countMaximum]
    for (const [index, direction] of ['Received', 'Sent'].entries()) {
      const bar = node('span', '', `tax-chart-bar ${index ? 'tax-chart-out' : 'tax-chart-in'}`)
      bar.style.height = `${Math.max(0, Math.min(1, ratios[index])) * 100}%`
      bar.title = `${month.label} · ${direction} · ${values[index]}${mode === 'count' ? ' payments' : ''}`
      pair.append(bar)
    }
    group.append(pair, node('span', month.label, 'tax-chart-month-label'))
    plot.append(group)
    const row = node('tr')
    const label = node('th', month.label)
    label.scope = 'row'
    row.append(label, ...values.map((value) => node('td', value)))
    rows.push(row)
  }
  element('tax-dashboard-chart').replaceChildren(axis, plot)
  element('tax-dashboard-months').replaceChildren(...rows)
  const empty = element('tax-dashboard-chart-empty')
  empty.hidden = activity.totalPayments > 0
  empty.textContent =
    'No settled, dated payments for this profile and year. Pending or undated activity can still be reviewed in Activity.'
}

;(element('tax-dashboard-chart-mode') as HTMLSelectElement).onchange = () => {
  if (!chartModel) return
  const mode = (element('tax-dashboard-chart-mode') as HTMLSelectElement).value
  renderPaymentChart(chartModel, mode === 'eur' ? 'eur' : 'count')
}

export function renderTaxDashboard(model: TaxDashboard, report: TaxReport, readAt: Date): void {
  const { counts, coverage } = model
  const cards = summaryCards(model, report)

  const assets: HTMLElement[] = model.groups.map((group) => {
    const source = group.source
    const card = node('article', '', 'tax-dashboard-asset')
    const environment =
      source?.backend === 'mock' || source?.asset.environment === 'test'
        ? 'Test / demo'
        : source?.asset.environment === 'live'
          ? 'Live environment (saved)'
          : 'Unknown environment'
    card.append(
      node(
        'h4',
        source ? `${source.asset.symbol} · ${source.asset.network}` : 'Asset unidentified'
      ),
      node('p', `${environment}${source ? ` · ${source.label}` : ''}`, 'tax-help')
    )
    const totals = node('dl', '', 'tax-dashboard-amounts')
    for (const [label, value] of [
      ['Received', group.incoming],
      ['Sent', group.outgoing]
    ] as const) {
      totals.append(node('dt', label), node('dd', amount(value, source?.asset.symbol ?? '')))
    }
    card.append(totals, node('p', `${group.notSettled} records not settled.`, 'tax-help'))
    if (!source || group.conflict || group.incoming.unavailable || group.outgoing.unavailable)
      card.append(
        node(
          'p',
          group.conflict
            ? 'Saved source details conflict. Amount totals are withheld.'
            : 'Some saved amounts or asset details cannot be interpreted safely. Review the original records.',
          'tax-notice'
        )
      )
    if (source) {
      const details = node('details')
      details.append(
        node('summary', 'Saved asset identity'),
        node(
          'p',
          `${source.asset.canonicalId} · ${source.id} · ${source.backend} · ${source.asset.decimals} decimal places`,
          'tax-help'
        )
      )
      card.append(details)
    }
    return card
  })
  if (!assets.length)
    assets.push(node('p', 'No dated payment records assigned to this profile in this year.'))

  const estimates = model.estimates
    .filter((estimate) => estimate.status !== 'not-applicable')
    .map((estimate) => {
      const card = node('article', '', 'tax-dashboard-estimate')
      const disposal =
        estimate.calculation === 'Personal gains and losses' ? model.personalDisposal : undefined
      card.append(
        node('h4', estimate.calculation),
        node(
          'strong',
          disposal?.status === 'estimate'
            ? `BTC disposal subtotal: ${disposal.taxEur} EUR`
            : estimate.label,
          'tax-dashboard-estimate-status'
        ),
        node(
          'p',
          disposal?.status === 'estimate'
            ? 'Provisional tax on included BTC disposals before earlier losses, withholding and other adjustments. This is not your whole tax bill.'
            : estimate.explanation
        )
      )
      const details = node('details')
      const requirements = node('ul')
      for (const missing of estimate.missing) requirements.append(node('li', missing))
      details.append(node('summary', 'What is needed'), requirements)
      card.append(details)
      const calculation = calculationQuestions(report.taxpayer.profile).find(
        (item) => item.label === estimate.calculation
      )
      if (calculation) {
        const button = node('button', 'Answer focused questions', 'btn btn-s')
        button.type = 'button'
        button.onclick = () => {
          if (navigationBlocked()) return
          window.dispatchEvent(
            new CustomEvent('kasa:tax-open-questions', {
              detail: { calculationId: calculation.id }
            })
          )
        }
        card.append(button)
      }
      if (estimate.calculation === 'Personal gains and losses') {
        const button = node('button', 'Review Bitcoin disposal estimate', 'btn btn-s')
        button.type = 'button'
        button.onclick = () => {
          if (navigationBlocked()) return
          window.dispatchEvent(
            new CustomEvent('kasa:tax-navigate', { detail: { target: 'tax-personal-title' } })
          )
          element('tax-personal-title').scrollIntoView({ block: 'start' })
          element('tax-personal-title').focus({ preventScroll: true })
        }
        card.append(button)
      }
      return card
    })

  const next = model.nextSteps.map((step) => {
    const item = node('li')
    const button = node(
      'button',
      step.recordKey ? 'Review first record' : 'Review details',
      'btn btn-s'
    )
    button.type = 'button'
    button.onclick = () => navigate(step, report.taxpayer.id)
    item.append(node('h4', step.title), node('p', step.description), button)
    return item
  })

  // Build nodes first. Untrusted saved labels and evidence are always plain text.
  const business = report.taxpayer.profile.userType === 'business'
  element('tax-dashboard-title').textContent = business
    ? 'A clearer view of business taxes'
    : 'A clearer view of your crypto taxes'
  element('tax-dashboard-subtitle').textContent =
    'Payments appear automatically. Review the missing details to understand what can be estimated.'
  element('tax-dashboard-next-title').textContent =
    `${next.length} ${next.length === 1 ? 'thing' : 'things'} to review`
  const visualCoverage = model.visuals.coverage
  element('tax-dashboard-source').textContent =
    `Source: saved app ledger · ${counts.settledIncoming + counts.settledOutgoing} settled payment records · ${counts.notSettled} not settled · ${visualCoverage.undated} undated · ${visualCoverage.testOrDemo} test/demo · ${visualCoverage.unknownSource} unidentified. No live wallet or network lookup.`
  element('tax-dashboard-context').textContent =
    `${model.taxpayerLabel} · ${report.taxpayer.profile.userType === 'personal' ? 'Personal' : 'Business'} · ${model.year} · Europe/Rome calendar year`
  element('tax-dashboard-coverage').textContent =
    `${counts.payments} dated payment records and ${counts.invoices} invoice requests assigned to this profile in ${model.year}. ${coverage.undatedInvoices + coverage.undatedPayments} undated records are excluded from the cards and chart. ${coverage.historyNote}`
  element('tax-dashboard-exclusions').textContent =
    `${coverage.undatedInvoices + coverage.undatedPayments} undated records await review and are excluded from cards and chart. ${coverage.otherYearInvoices + coverage.otherYearPayments} records from other years excluded. Database-wide: ${coverage.unassigned} unassigned or invalidly assigned records excluded. ${coverage.orphaned} assignments for this profile refer to missing records.`
  element('tax-dashboard-ownership').textContent =
    `Full saved amounts are shown, not an ownership-adjusted or taxable share. ${coverage.partialOwnership} accounts have partial ownership; ${coverage.unknownOwnership} have unknown ownership. ${coverage.profileOnly ?? 0} records are linked to this profile without a reviewed account and asset assignment.`
  element('tax-dashboard-cards').replaceChildren(...cards)
  element('tax-dashboard-assets').replaceChildren(...assets)
  chartModel = model
  renderPaymentChart(model, model.visuals.activity.mode)
  element('tax-dashboard-estimates').replaceChildren(...estimates)
  element('tax-dashboard-next').replaceChildren(...next)
  const updated = element('tax-dashboard-updated') as HTMLTimeElement
  updated.dateTime = readAt.toISOString()
  updated.textContent = readAt.toLocaleString()
  element('tax-dashboard-freshness').hidden = false
  element('tax-dashboard-content').hidden = false
  element('tax-profile-missing').hidden = true
}
