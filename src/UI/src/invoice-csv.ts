import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'

export const csvCell = (value: string): string => {
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
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const isoOrBlank = (t: number | null | undefined): string =>
  typeof t === 'number' && t > 0 ? new Date(t * 1000).toISOString() : ''

// One ledger entry per payment: debit/credit columns and the linked invoice or refund, for bookkeeping.
export function transactionsCsv(payments: KasaPayment[], snap: KasaSnapshot): string {
  const rows = [
    [
      'Entry_Date_UTC',
      'Transaction_ID',
      'Entry_Type',
      'Direction',
      'Asset',
      'Network',
      'Credit_USDT',
      'Debit_USDT',
      'Net_Amount_USDT',
      'Status',
      'Invoice_ID',
      'Client_Name',
      'Invoice_Amount_USDT',
      'Invoice_Received_USDT',
      'Invoice_Status',
      'Refund_Proposal_ID',
      'Recipient_ID'
    ],
    ...payments.map((p) => {
      const out = p.direction === 'out'
      const invoice = snap.invoices.find((i) => i.id === p.invoiceId)
      const refund = out ? snap.proposals.find((x) => x.txid && x.txid === p.txid) : undefined
      const amount = p.received.toFixed(6)
      return [
        isoOrBlank(p.blockTime),
        p.txid ?? '',
        out ? (refund ? 'Refund' : 'Payment') : 'Receipt',
        out ? 'Outgoing' : 'Incoming',
        'USDT (RGB20)',
        'Mutinynet',
        out ? '' : amount,
        out ? amount : '',
        (out ? -p.received : p.received).toFixed(6),
        p.status,
        invoice?.id ?? '',
        invoice?.client ?? '',
        invoice ? invoice.amount.toFixed(6) : '',
        invoice ? invoice.received.toFixed(6) : '',
        invoice?.state ?? '',
        refund?.id ?? '',
        p.recipientId ?? ''
      ]
    })
  ]
  // plain decimal numbers stay numbers (a leading "-" would otherwise be escaped as text)
  const cell = (v: string): string => (/^-?\d+\.\d+$/.test(v) ? `"${v}"` : csvCell(v))
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

// One row per invoice with its payment evidence (transaction IDs and times) for bookkeeping.
export function invoiceDetailsCsv(snap: KasaSnapshot): string {
  const rows = [
    [
      'Invoice_ID',
      'Client_Name',
      'Amount_USDT',
      'Received_USDT',
      'Balance_USDT',
      'Issue_Date_UTC',
      'Due_Date_UTC',
      'Status',
      'Recipient_ID',
      'RGB_Invoice',
      'Payment_Count',
      'Payment_Transaction_IDs',
      'First_Payment_UTC',
      'Last_Payment_UTC'
    ],
    ...snap.invoices.map((i) => {
      const paid = snap.payments
        .filter((p) => p.invoiceId === i.id && p.received > 0 && p.status !== 'failed')
        .sort((a, b) => (a.blockTime ?? Infinity) - (b.blockTime ?? Infinity))
      const times = paid.map((p) => p.blockTime).filter((t): t is number => !!t)
      return [
        i.id,
        i.client,
        i.amount.toFixed(6),
        i.received.toFixed(6),
        (i.amount - i.received).toFixed(6),
        isoOrBlank(i.createdAt),
        isoOrBlank(i.expiresAt),
        i.state,
        i.recipientId,
        i.rgbInvoice,
        String(paid.length),
        paid.map((p) => p.txid ?? '').filter(Boolean).join(' '),
        isoOrBlank(times[0]),
        isoOrBlank(times[times.length - 1])
      ]
    })
  ]
  const cell = (v: string): string => (/^-?\d+\.\d+$/.test(v) ? `"${v}"` : csvCell(v))
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
