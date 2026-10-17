import type { TaxProfile } from '../../shared/tax-profile'
import { taxYearReview, taxYearRows, taxYearCsv } from './tax-year-ledger'

const status = document.getElementById('tax-year-status')!
const body = document.getElementById('tax-year-rows')!
const exportButton = document.getElementById('tax-year-export') as HTMLButtonElement
let request = 0
let exporting = false
let reviewAvailable = false

const errorText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

async function selectedProfile(): Promise<TaxProfile | null> {
  const scope = await window.taxScope.get()
  return (
    scope.taxpayers.find((t) => t.id === scope.activeTaxpayerId)?.profile ??
    (await window.taxProfile.get())
  )
}

async function refresh(): Promise<void> {
  const current = ++request
  reviewAvailable = false
  exportButton.disabled = true
  body.replaceChildren()
  status.textContent = 'Loading tax-year records…'
  try {
    const [profile, snapshot] = await Promise.all([selectedProfile(), window.kasa.snapshot()])
    if (current !== request) return
    if (!profile || profile.country !== 'IT') {
      status.textContent = profile
        ? 'Tax-year review currently supports Italy only. All-dates summaries and export remain available.'
        : 'Save an Italian tax profile to review its selected year. All-dates summaries and export remain available.'
      return
    }
    const review = taxYearReview(snapshot, profile.taxYear)
    const rows = taxYearRows(snapshot, review)
    status.textContent = `${profile.taxYear} · Europe/Rome: ${review.invoices.length} invoices issued, ${review.payments.length} dated payment observations. ${review.undatedInvoices.length + review.undatedPayments.length} undated records need review and have no assigned year. ${review.excludedInvoices} invoices and ${review.excludedPayments} payments from other years excluded.${rows.length === 0 ? ' No records in this review; this does not mean zero tax is due.' : ''}${rows.length > 100 ? ' Showing the first 100 rows; export includes all rows.' : ''}`
    for (const row of rows.slice(0, 100)) {
      const tr = document.createElement('tr')
      for (const text of [
        row.type,
        row.id,
        row.invoiceId || 'Unlinked',
        row.client || '—',
        row.direction || '—',
        `${row.amount} USDT`,
        row.status,
        row.date || 'Date unavailable'
      ]) {
        const td = document.createElement('td')
        td.textContent = text
        tr.append(td)
      }
      tr.title = row.basis
      body.append(tr)
    }
    reviewAvailable = true
    exportButton.disabled = exporting
  } catch (error) {
    if (current === request) status.textContent = `Year review unavailable: ${errorText(error)}`
  }
}
exportButton.onclick = async () => {
  if (exporting) return
  exporting = true
  exportButton.disabled = true
  try {
    // Re-read saved settings and records so an export never uses unsaved form edits.
    const [profile, snapshot] = await Promise.all([selectedProfile(), window.kasa.snapshot()])
    if (!profile || profile.country !== 'IT') throw new Error('Save an Italian tax profile first.')
    const url = URL.createObjectURL(
      new Blob([taxYearCsv(snapshot, profile.taxYear)], { type: 'text/csv;charset=utf-8;' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `tax-records-${profile.taxYear}-with-undated.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    status.textContent = `Export failed: ${errorText(error)}`
  } finally {
    exporting = false
    exportButton.disabled = !reviewAvailable
  }
}
document.getElementById('tax-year-refresh')!.onclick = () => {
  void refresh()
}
window.addEventListener('kasa:tax-profile-saved', () => {
  void refresh()
})
const unsubscribe = window.kasa?.onChanged(() => {
  void refresh()
})
window.addEventListener('beforeunload', () => unsubscribe?.())
void refresh()
