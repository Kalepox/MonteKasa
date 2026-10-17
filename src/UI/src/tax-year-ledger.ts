import type { KasaSnapshot, KasaInvoice, KasaPayment } from '../../preload/index.d'
import { readLedgerSource } from '../../shared/ledger-source'
import { csvCell } from './invoice-csv'

const yearFormat = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Europe/Rome' })
function recordYear(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : Number(yearFormat.format(date))
}

export type TaxYearReview = {
  year: number
  invoices: KasaInvoice[]
  payments: KasaPayment[]
  undatedInvoices: KasaInvoice[]
  undatedPayments: KasaPayment[]
  excludedInvoices: number
  excludedPayments: number
}

// These are record dates, not a determination of fiscal recognition or settlement.
export function taxYearReview(snapshot: KasaSnapshot, year: number): TaxYearReview {
  if (!Number.isInteger(year) || year < 2023 || year > 9999) throw new Error('Invalid review year.')
  const invoices = snapshot.invoices.filter((i) => recordYear(i.createdAt) === year)
  const payments = snapshot.payments.filter((p) => recordYear(p.blockTime) === year)
  const undatedInvoices = snapshot.invoices.filter((i) => recordYear(i.createdAt) === null)
  const undatedPayments = snapshot.payments.filter((p) => recordYear(p.blockTime) === null)
  return {
    year,
    invoices,
    payments,
    undatedInvoices,
    undatedPayments,
    excludedInvoices: snapshot.invoices.length - invoices.length - undatedInvoices.length,
    excludedPayments: snapshot.payments.length - payments.length - undatedPayments.length
  }
}

export type TaxYearRow = {
  type: string
  id: string
  invoiceId: string
  client: string
  direction: string
  amount: string
  unit: string
  status: string
  date: string
  basis: string
}

function paymentAmount(payment: KasaPayment): Pick<TaxYearRow, 'amount' | 'unit'> {
  const source = readLedgerSource(payment.source)
  if (!source)
    return {
      amount: Number.isFinite(payment.received) ? payment.received.toFixed(6) : 'Unavailable',
      unit: 'recorded app units'
    }
  const raw = payment.receivedRaw
  const { decimals, symbol: unit } = source.asset
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
    return { amount: 'Unavailable', unit }
  const digits = String(raw).padStart(decimals + 1, '0')
  const amount = decimals
    ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '')
    : digits
  return { amount, unit }
}

export function taxYearRows(snapshot: KasaSnapshot, review: TaxYearReview): TaxYearRow[] {
  const invoices = new Map(snapshot.invoices.map((i) => [i.id, i]))
  const invoiceRow = (i: KasaInvoice, undated: boolean): TaxYearRow => ({
    type: undated ? 'Undated invoice — year unassigned' : 'Invoice issued in year',
    id: i.id,
    invoiceId: i.id,
    client: i.client,
    direction: '',
    amount: i.amount.toFixed(6),
    unit: 'USDT',
    status: i.state,
    date: undated ? '' : new Date(i.createdAt * 1000).toISOString(),
    basis:
      'Issue date only. Requested amount is not taxable revenue; receipt totals may span years.'
  })
  const paymentRow = (p: KasaPayment, undated: boolean): TaxYearRow => ({
    type: undated ? 'Undated payment — year unassigned' : 'Payment observation in year',
    id: String(p.nodeIdx),
    invoiceId: p.invoiceId ?? '',
    client: invoices.get(p.invoiceId ?? '')?.client ?? '',
    direction: p.direction,
    ...paymentAmount(p),
    status: p.status,
    date: undated ? '' : new Date(p.blockTime! * 1000).toISOString(),
    basis:
      'Recorded block date only; not a fiscal or settlement determination. Do not add to invoice amounts.'
  })
  return [
    ...review.invoices.map((i) => invoiceRow(i, false)),
    ...review.payments.map((p) => paymentRow(p, false)),
    ...review.undatedInvoices.map((i) => invoiceRow(i, true)),
    ...review.undatedPayments.map((p) => paymentRow(p, true))
  ]
}

export function taxYearCsv(snapshot: KasaSnapshot, year: number): string {
  const review = taxYearReview(snapshot, year)
  const rows = [
    [
      'Record_Type',
      'Record_ID',
      'Invoice_ID',
      'Client',
      'Direction',
      'Amount',
      'Amount_Unit',
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
      '',
      `${year} record review, Europe/Rome year boundaries. Invoice issue dates and payment block dates are filtered separately. Undated rows remain unassigned. Not a tax calculation.`
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
      '',
      `Other-year records excluded: ${review.excludedInvoices} invoices, ${review.excludedPayments} payments. No EUR conversion or tax liability calculated. Invoice and payment rows can describe the same funds; do not sum them.`
    ],
    ...taxYearRows(snapshot, review).map((r) => [
      r.type,
      r.id,
      r.invoiceId,
      r.client,
      r.direction,
      r.amount,
      r.unit,
      r.status,
      r.date,
      r.basis
    ])
  ]
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
