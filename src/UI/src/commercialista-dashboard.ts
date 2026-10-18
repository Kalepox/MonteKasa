import type { TaxDashboard } from './tax-dashboard'
import type { TaxReport } from './tax-report'
import type { LedgerTotal } from './ledger'
import { calculationQuestions } from '../../shared/tax-questions'

const element = (id: string): HTMLElement => document.getElementById(id)!

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
  element('tax-dashboard-content').hidden = true
  element('tax-dashboard-freshness').hidden = true
  element('tax-profile-missing').hidden = false
  for (const id of ['context', 'coverage', 'exclusions', 'ownership'])
    element(`tax-dashboard-${id}`).textContent = ''
  for (const id of ['cards', 'assets', 'months', 'estimates', 'next'])
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

export function renderTaxDashboard(model: TaxDashboard, report: TaxReport, readAt: Date): void {
  const { counts, coverage } = model
  const cards = [
    ['Settled incoming', counts.settledIncoming, 'Saved payment records received'],
    ['Settled outgoing', counts.settledOutgoing, 'Saved payment records sent'],
    ['Not settled', counts.notSettled, 'Pending, failed or other saved statuses']
  ].map(([label, count, hint]) => {
    const card = node('article', '', 'tax-dashboard-card')
    card.append(
      node('h4', String(label)),
      node('strong', String(count), 'tax-dashboard-value'),
      node('p', String(hint))
    )
    return card
  })

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

  const largest = Math.max(
    1,
    ...model.months.flatMap((month) => [month.incoming, month.outgoing, month.notSettled])
  )
  const months = model.months.map((month) => {
    const row = node('tr')
    const label = node('th', month.label)
    label.scope = 'row'
    row.append(label)
    for (const [index, count] of [month.incoming, month.outgoing, month.notSettled].entries()) {
      const cell = node('td')
      cell.append(node('span', String(count)))
      const track = node('span', '', 'tax-month-track')
      track.setAttribute('aria-hidden', 'true')
      const bar = node('span', '', `tax-month-bar tax-month-bar-${index}`)
      bar.style.width = `${(count / largest) * 100}%`
      track.append(bar)
      cell.append(track)
      row.append(cell)
    }
    return row
  })

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
  element('tax-dashboard-months').replaceChildren(...months)
  element('tax-dashboard-estimates').replaceChildren(...estimates)
  element('tax-dashboard-next').replaceChildren(...next)
  const updated = element('tax-dashboard-updated') as HTMLTimeElement
  updated.dateTime = readAt.toISOString()
  updated.textContent = readAt.toLocaleString()
  element('tax-dashboard-freshness').hidden = false
  element('tax-dashboard-content').hidden = false
  element('tax-profile-missing').hidden = true
}
