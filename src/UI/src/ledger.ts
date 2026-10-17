import type { KasaSnapshot } from '../../preload/index.d'
import { csvCell } from './invoice-csv'

const date = (seconds: number): string => new Date(seconds * 1000).toISOString()
const amount = (value: number): string => value.toFixed(6)
const raw = (value: number): bigint => BigInt(amount(value).replace('.', ''))
const total = (values: number[]): string => {
  const sum = values.reduce((sum, value) => sum + raw(value), 0n)
  return `${sum / 1000000n}.${(sum % 1000000n).toString().padStart(6, '0')}`
}

export function searchLedger(snapshot: KasaSnapshot, query: string): string {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length)
    return 'Enter a client, invoice ID, transaction ID, amount, date (YYYY-MM-DD), or status.'
  const matches = (fields: string[]): boolean => {
    const text = fields.join(' ').toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  }
  const results: string[] = []
  for (const i of snapshot.invoices) {
    if (
      matches([
        i.client,
        i.id,
        `INV-${i.id.slice(0, 6)}`,
        i.state,
        amount(i.amount),
        amount(i.received),
        date(i.createdAt),
        date(i.expiresAt)
      ])
    )
      results.push(
        `Invoice ${i.id} | ${i.client} | ${i.state} | Amount ${amount(i.amount)} USDT | Recorded received ${amount(i.received)} USDT | Issued ${date(i.createdAt)} | Expires ${date(i.expiresAt)}`
      )
  }
  for (const p of snapshot.payments) {
    const invoice = snapshot.invoices.find((i) => i.id === p.invoiceId)
    const when = p.blockTime === null ? 'Date unavailable' : date(p.blockTime)
    if (
      matches([
        String(p.nodeIdx),
        p.invoiceId ?? '',
        invoice ? `INV-${invoice.id.slice(0, 6)}` : '',
        invoice?.client ?? '',
        p.txid ?? '',
        p.status,
        amount(p.received),
        when
      ])
    )
      results.push(
        `Payment ${p.nodeIdx} | ${invoice?.client ?? 'Unlinked payment'} | Invoice ${p.invoiceId ?? 'unlinked'} | ${p.status} | Observed ${amount(p.received)} USDT | Transaction ${p.txid ?? 'unavailable'} | ${when}`
      )
  }
  if (!results.length) return 'No matching recorded invoices or payments.'
  return `${results.length} matching records${results.length > 100 ? ' (showing first 100)' : ''}. Invoice and payment rows may describe the same funds; do not add them together.\n\n${results.slice(0, 100).join('\n\n')}`
}

export function taxRecordsCsv(snapshot: KasaSnapshot): string {
  const rows: string[][] = [
    [
      'Record_Type',
      'Record_ID',
      'Invoice_ID',
      'Client',
      'Invoice_Amount_USDT',
      'Recorded_Received_USDT',
      'Status',
      'Date_UTC',
      'Notes'
    ],
    [
      'Scope',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'All recorded dates. Invoice-ledger summary in USDT; not a tax calculation or audited report.'
    ],
    [
      'Limitations',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'EUR conversion, expenses, VAT treatment and tax jurisdiction are unavailable. Tax liability is not calculated.'
    ],
    [
      'Invoice totals',
      '',
      '',
      '',
      total(snapshot.invoices.map((i) => i.amount)),
      total(snapshot.invoices.map((i) => i.received)),
      '',
      '',
      'Totals use invoice rows once. Received means the current recorded invoice amount, not taxable revenue. Unlinked payments are excluded from these totals.'
    ],
    ...snapshot.invoices.map((i) => [
      'Invoice',
      i.id,
      i.id,
      i.client,
      amount(i.amount),
      amount(i.received),
      i.state,
      date(i.createdAt),
      `Expires ${date(i.expiresAt)}`
    ]),
    ...snapshot.payments.map((p) => [
      'Payment observation',
      String(p.nodeIdx),
      p.invoiceId ?? '',
      snapshot.invoices.find((i) => i.id === p.invoiceId)?.client ?? '',
      '',
      amount(p.received),
      p.status,
      p.blockTime === null ? '' : date(p.blockTime),
      `Transaction: ${p.txid ?? 'unavailable'}. Observation only; may be pending or failed. Do not add to invoice totals.`
    ])
  ]
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
