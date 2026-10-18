import { taxRecordsCsv, type LedgerTotal } from './ledger'
import { buildTaxReport, taxReportCsv, type TaxReport } from './tax-report'
import { renderTaxYearRows } from './tax-year'
import { buildTaxDashboard, type TaxDashboard } from './tax-dashboard'
import {
  clearTaxDashboard,
  renderTaxDashboard,
  setTaxDashboardStatus
} from './commercialista-dashboard'
import type { TaxScope } from '../../shared/tax-scope'
import type { KasaSnapshot } from '../../preload/index.d'
import { updateTaxQuestions, clearTaxQuestions } from './tax-questions-ui'
import { updatePersonalDisposal, clearPersonalDisposal } from './personal-disposal-ui'
import { buildPersonalDisposalEstimate } from './personal-disposal'

const element = (id: string): HTMLElement => document.getElementById(id)!
const root = element('view-tax')
const status = element('commercialista-status')
const summaryTable = element('tax-reports-summary')
const updated = element('tax-reports-updated') as HTMLTimeElement
const exportButton = element('tax-reports-export') as HTMLButtonElement
const allExportButton = element('tax-reports-all-export') as HTMLButtonElement
const exportStatus = element('tax-reports-export-status')
let request = 0
let scopeRevision = 0
let displayed: TaxReport | null = null
let lastSuccess: {
  report: TaxReport
  dashboard: TaxDashboard
  scope: TaxScope
  snapshot: KasaSnapshot
  scopeSignature: string
  readAt: Date
} | null = null
let loading = false
let scopeBusy = root.dataset.scopeBusy === 'true'
let exporting = false
let exportingAll = false
let disposed = false

function totalCell(total: LedgerTotal, unit: string): HTMLTableCellElement {
  const cell = document.createElement('td')
  cell.textContent = !total.records
    ? '—'
    : total.amount === null
      ? 'Not totalled'
      : `${total.amount} ${unit}`
  if (total.records) {
    const detail = document.createElement('small')
    detail.textContent = `${total.records} ${total.records === 1 ? 'record' : 'records'}${total.unavailable ? ` · ${total.unavailable} unavailable` : ''}`
    cell.append(detail)
  }
  return cell
}

function groupRow(group: TaxReport['summary']['groups'][number]): HTMLTableRowElement {
  const row = document.createElement('tr')
  const heading = document.createElement('th')
  heading.scope = 'row'
  const source = group.source
  heading.textContent = source
    ? `${source.asset.symbol} · ${source.asset.network}`
    : 'Asset not identified'
  const info = document.createElement('small')
  const environment = !source
    ? 'Unknown source'
    : source.backend === 'mock' || source.asset.environment === 'test'
      ? 'Test / demo'
      : source.asset.environment === 'live'
        ? 'Live environment (saved)'
        : 'Unknown environment'
  info.textContent = `${environment}${source ? ` · ${source.label}` : ''}. Invoices: ${group.invoiceCount} · Payment observations: ${group.paymentCount} · Not settled: ${group.unsettled}.`
  heading.append(info)
  if (source) {
    const details = document.createElement('details')
    const label = document.createElement('summary')
    label.textContent = 'Saved source details'
    const identity = document.createElement('small')
    identity.textContent = `Source: ${source.id} · Asset: ${source.asset.canonicalId} · Backend: ${source.backend} · Decimal places: ${source.asset.decimals}`
    details.append(label, identity)
    heading.append(details)
  }
  if (!source || group.conflict) {
    const warning = document.createElement('small')
    warning.textContent = group.conflict
      ? 'Conflicting saved source details. Totals are withheld until reviewed.'
      : 'Saved asset details are missing or invalid. Original values remain in the CSV; no currency is assumed.'
    heading.append(warning)
  }
  row.append(heading)
  for (const total of [group.requested, group.incoming, group.outgoing])
    row.append(totalCell(total, source?.asset.symbol ?? 'recorded app units'))
  return row
}

const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function scopeKey(scope: TaxScope): string | null {
  const taxpayer = scope.taxpayers.find((item) => item.id === scope.activeTaxpayerId)
  return taxpayer ? JSON.stringify([scope.databaseId, taxpayer.id, taxpayer.profile.taxYear]) : null
}

function controls(): void {
  exportButton.disabled = loading || scopeBusy || exporting || !displayed
  allExportButton.disabled = exportingAll
  ;(element('tax-dashboard-refresh') as HTMLButtonElement).disabled = scopeBusy
  setTaxDashboardStatus(status.textContent ?? '', loading || scopeBusy)
}

function clearReport(): void {
  displayed = null
  clearTaxDashboard()
  clearTaxQuestions()
  clearPersonalDisposal()
  summaryTable.hidden = true
  element('tax-year-review').hidden = true
  element('tax-reports-freshness').hidden = true
  element('tax-reports-context').textContent =
    'Select a saved profile and tax year above to see its report.'
  element('tax-reports-attention').textContent = ''
  element('tax-reports-ownership').textContent = ''
  element('tax-report-groups').replaceChildren()
  element('tax-year-rows').replaceChildren()
  element('tax-year-status').textContent = ''
  for (const key of ['invoice-count', 'underpaid', 'overpaid', 'unsettled', 'unlinked'])
    element(`tax-${key}`).textContent = '—'
  controls()
}

function render(report: TaxReport, dashboard: TaxDashboard, readAt: Date): void {
  const { summary, review, taxpayer, year } = report
  const rows = summary.groups.map(groupRow)
  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 4
    cell.textContent = 'No assigned, dated records in this year. No asset totals are available.'
    row.append(cell)
    rows.push(row)
  }
  renderTaxDashboard(dashboard, report, readAt)
  renderTaxYearRows(report.rows)
  element('tax-report-groups').replaceChildren(...rows)
  element('tax-invoice-count').textContent = String(summary.invoiceCount)
  for (const key of ['underpaid', 'overpaid', 'unsettled', 'unlinked'] as const)
    element(`tax-${key}`).textContent = String(summary[key])
  element('tax-reports-context').textContent =
    `${taxpayer.label} · ${taxpayer.profile.userType === 'personal' ? 'Personal' : 'Business'} · ${year} · Europe/Rome calendar year · All linked records and assigned accounts/assets`
  const undated = review.undatedInvoices.length + review.undatedPayments.length
  element('tax-reports-attention').textContent =
    `${undated} assigned records have no usable date: shown in the review and CSV, excluded from year totals. ${review.excludedInvoices} invoices and ${review.excludedPayments} payments from other years excluded. Database-wide: ${report.unassigned} records are unassigned or have invalid assignments and are not included in this profile. ${report.orphaned} assignments for this profile refer to missing records. Review assignments in Activity.`
  element('tax-reports-ownership').textContent =
    `Amounts are the full recorded amounts, not an ownership-adjusted or taxable share. This profile has ${report.partialOwnership} accounts with partial ownership and ${report.unknownOwnership} with an unknown share; these need review before tax calculations. ${report.profileOnly ?? 0} records are linked to the profile without a reviewed account and asset assignment; missing identity and ownership details remain unresolved.`
  element('tax-year-status').textContent =
    `${taxpayer.label} · ${year}: ${review.invoices.length} invoices issued, ${review.payments.length} dated payment observations, ${undated} undated records awaiting review.${report.rows.length > 100 ? ' Showing the first 100 rows; export includes all rows.' : ''}`
  summaryTable.hidden = false
  element('tax-year-review').hidden = false
  updated.dateTime = readAt.toISOString()
  updated.textContent = readAt.toLocaleString()
  element('tax-reports-freshness').hidden = false
  displayed = report
  status.textContent =
    summary.invoiceCount || review.payments.length
      ? 'Showing records linked or assigned to the selected profile and dated within its saved tax year. Invoice requests and payment observations are separate.'
      : 'No linked or assigned, dated records for this profile and year. Empty records do not mean zero tax is due.'
}

async function refresh(): Promise<void> {
  if (disposed || scopeBusy) return
  const current = ++request
  loading = true
  controls()
  status.textContent = displayed
    ? 'Refreshing saved records for the displayed profile and year. The previous summary remains visible until this finishes.'
    : 'Loading the selected profile and saved records…'
  summaryTable.setAttribute('aria-busy', 'true')
  setTaxDashboardStatus(status.textContent ?? '', true)
  let sameScope = false
  try {
    // Saved ownership declarations are tied to this database. Never use a legacy
    // standalone profile or infer ownership from the current wallet/source.
    const scope = await window.taxScope.get()
    if (disposed || current !== request) return
    const key = scopeKey(scope)
    if (!key) {
      clearReport()
      status.textContent =
        'Choose or create a saved profile before reviewing its tax year. No database records have been included automatically.'
      return
    }
    const scopeSignature = JSON.stringify(scope)
    sameScope = lastSuccess?.scopeSignature === scopeSignature
    if (sameScope && lastSuccess && !displayed) {
      // A read-only scope refresh also emits busy/idle. Restore cached results only
      // after confirming every saved declaration is unchanged, including assignments.
      render(lastSuccess.report, lastSuccess.dashboard, lastSuccess.readAt)
      updateTaxQuestions(lastSuccess.scope, lastSuccess.snapshot, lastSuccess.report)
      updatePersonalDisposal(lastSuccess.scope, lastSuccess.snapshot, lastSuccess.report)
      status.textContent =
        'Refreshing saved records for the displayed profile and year. The previous summary remains visible until this finishes.'
      setTaxDashboardStatus(status.textContent, true)
    } else if (displayed && !sameScope) {
      scopeRevision++
      clearReport()
    }
    const snapshot = await window.kasa.snapshot()
    if (disposed || current !== request) return
    const report = buildTaxReport(scope, snapshot)
    if (!report) throw new Error('The selected saved profile is no longer available.')
    const dashboard = buildTaxDashboard(scope, report)
    dashboard.personalDisposal = buildPersonalDisposalEstimate(scope, snapshot, report)
    const readAt = new Date()
    render(report, dashboard, readAt)
    updateTaxQuestions(scope, snapshot, report)
    updatePersonalDisposal(scope, snapshot, report)
    lastSuccess = { report, dashboard, scope, snapshot, scopeSignature, readAt }
  } catch (error) {
    if (disposed || current !== request) return
    // A failed scope read cannot establish that old results still belong to the selection.
    if (!sameScope) clearReport()
    status.textContent = `${
      displayed
        ? 'Could not refresh saved records. The displayed profile/year summary may be out of date.'
        : 'Saved profile records could not be loaded.'
    } Select Refresh records to try again. ${errorText(error)}`
  } finally {
    if (!disposed && current === request) {
      loading = false
      summaryTable.setAttribute('aria-busy', 'false')
      controls()
    }
  }
}

function download(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

element('tax-reports-refresh').onclick = () => void refresh()
element('tax-dashboard-refresh').onclick = () => void refresh()
exportButton.onclick = async () => {
  if (disposed || exporting || loading || scopeBusy || !displayed) return
  const expectedKey = displayed.scopeKey
  const revision = scopeRevision
  exporting = true
  controls()
  exportStatus.textContent = 'Preparing the selected profile/year CSV from saved records…'
  try {
    const scope = await window.taxScope.get()
    if (scopeKey(scope) !== expectedKey)
      throw new Error('Selected profile or year changed. Refresh Reports before exporting.')
    const snapshot = await window.kasa.snapshot()
    // Confirm saved declarations again so changed assignments cannot produce a mislabeled export.
    const confirmed = await window.taxScope.get()
    if (disposed || revision !== scopeRevision) return
    if (JSON.stringify(scope) !== JSON.stringify(confirmed))
      throw new Error('Profile or record assignments changed. Refresh Reports before exporting.')
    const report = buildTaxReport(scope, snapshot)
    if (!report) throw new Error('Select a saved profile before exporting.')
    const id = report.taxpayer.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    download(taxReportCsv(report), `tax-records-${id}-${report.year}-with-undated.csv`)
    exportStatus.textContent = `CSV exported for ${report.taxpayer.label} · ${report.year}, including its undated records for review. Other profiles and unassigned records are excluded. Tax liability is not calculated.`
  } catch (error) {
    if (!disposed && revision === scopeRevision)
      exportStatus.textContent = `Export failed: ${errorText(error)}`
  } finally {
    exporting = false
    if (!disposed) controls()
  }
}

allExportButton.onclick = async () => {
  if (disposed || exportingAll) return
  exportingAll = true
  controls()
  const output = element('tax-reports-all-export-status')
  output.textContent = 'Preparing the entire database export…'
  try {
    const snapshot = await window.kasa.snapshot()
    if (disposed) return
    download(taxRecordsCsv(snapshot), 'tax-records-entire-database-all-dates.csv')
    output.textContent =
      'Entire database CSV exported: all profiles, unassigned records and all dates. This is not the selected profile’s report or a tax calculation.'
  } catch (error) {
    if (!disposed) output.textContent = `Export failed: ${errorText(error)}`
  } finally {
    exportingAll = false
    if (!disposed) controls()
  }
}

function invalidateScope(): void {
  ++request
  ++scopeRevision
  loading = false
  clearReport()
  exportStatus.textContent = exporting
    ? 'Export cancelled because the profile or saved assignments changed. Retry after the report refreshes.'
    : ''
  status.textContent = scopeBusy
    ? 'Waiting for the saved profile or assignments to finish updating…'
    : 'Loading the selected profile and saved records…'
  setTaxDashboardStatus(status.textContent, scopeBusy)
}
window.addEventListener('kasa:tax-scope-busy', () => {
  scopeBusy = true
  invalidateScope()
})
window.addEventListener('kasa:tax-scope-idle', () => {
  scopeBusy = false
  void refresh()
})
for (const event of [
  'kasa:tax-scope-updated',
  'kasa:tax-activity-updated',
  'kasa:tax-profile-saved'
])
  window.addEventListener(event, (event) => {
    const savedScope = (event as CustomEvent<{ scope?: TaxScope }>).detail?.scope
    if (!savedScope || lastSuccess?.scopeSignature !== JSON.stringify(savedScope)) invalidateScope()
    void refresh()
  })

// Overview and Reports share a snapshot, scope and last-read time.
const visiblePage = (): string =>
  root.classList.contains('on') && ['overview', 'reports'].includes(root.dataset.taxPage ?? '')
    ? root.dataset.taxPage!
    : ''
let previousPage = visiblePage()
const navigation = new MutationObserver(() => {
  const page = visiblePage()
  if (page && page !== previousPage) void refresh()
  previousPage = page
})
navigation.observe(root, { attributes: true, attributeFilter: ['class', 'data-tax-page'] })
const unsubscribe = window.kasa?.onChanged(() => void refresh())
window.addEventListener('beforeunload', () => {
  disposed = true
  navigation.disconnect()
  unsubscribe?.()
})
clearReport()
void refresh()
