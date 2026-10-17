import type { KasaInvoice } from '../../preload/index.d'

const cell = (value: string): string => {
  // Quoting alone does not stop spreadsheet applications from evaluating formulas.
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function invoicesCsv(invoices: KasaInvoice[]): string {
  const rows = [
    [
      'Invoice_ID',
      'Client_Name',
      'Amount_USDT',
      'Received_USDT',
      'Issue_Date_UTC',
      'Due_Date_UTC',
      'Status'
    ],
    ...invoices.map((invoice) => [
      invoice.id,
      invoice.client,
      invoice.amount.toFixed(6),
      invoice.received.toFixed(6),
      new Date(invoice.createdAt * 1000).toISOString(),
      new Date(invoice.expiresAt * 1000).toISOString(),
      invoice.state
    ])
  ]
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
