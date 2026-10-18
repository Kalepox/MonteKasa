import type { TaxYearRow } from './tax-year-ledger'

export function renderTaxYearRows(rows: TaxYearRow[]): void {
  const body = document.getElementById('tax-year-rows')!
  const renderedRows = rows.slice(0, 100).map((row) => {
    const tr = document.createElement('tr')
    for (const [index, text] of [
      row.type,
      row.id,
      row.invoiceId || 'Unlinked',
      row.client || '—',
      row.direction || '—',
      `${row.amount} ${row.unit}`,
      row.status,
      row.date || 'Date unavailable'
    ].entries()) {
      const td = document.createElement('td')
      td.textContent = text
      if (index === 5) {
        const context = document.createElement('small')
        context.style.display = 'block'
        context.textContent =
          row.sourceStatus === 'unknown'
            ? 'Source and asset unverified'
            : `${row.sourceLabel} · ${row.network} · ${row.backend === 'mock' || row.environment === 'test' ? 'Test/demo' : row.environment === 'live' ? 'Live (saved metadata)' : 'Environment unknown'} · ${row.assetId}${row.sourceStatus === 'conflict' ? ' · Conflicting source metadata' : ''}`
        context.title = row.sourceId
          ? `Saved source ID: ${row.sourceId} · Backend: ${row.backend}`
          : row.basis
        td.append(context)
      }
      tr.append(td)
    }
    tr.title = row.basis
    return tr
  })
  if (renderedRows.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 8
    td.textContent = 'No assigned records in this year or awaiting a date.'
    tr.append(td)
    renderedRows.push(tr)
  }
  body.replaceChildren(...renderedRows)
}
