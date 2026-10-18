import type { KasaSnapshot, KasaInvoice, KasaPayment } from '../../preload/index.d'
import { readLedgerSource } from '../../shared/ledger-source'
import { observedSources } from '../../shared/tax-activity'
import { csvCell } from './invoice-csv'
import { ledgerDate, savedLedgerAmount } from './ledger-amount'

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

type TaxYearAmount = {
  amount: string
  unit: string
  amountRaw: string
  sourceId: string
  sourceLabel: string
  backend: string
  assetId: string
  network: string
  environment: string
  decimals: string
  sourceStatus: 'saved' | 'unknown' | 'conflict'
}

export type TaxYearRow = TaxYearAmount & {
  type: string
  id: string
  invoiceId: string
  client: string
  direction: string
  status: string
  date: string
  basis: string
}

export function taxYearRows(
  snapshot: KasaSnapshot,
  review: TaxYearReview,
  conflictingSourceIds: ReadonlySet<string> = new Set()
): TaxYearRow[] {
  const invoices = new Map(snapshot.invoices.map((i) => [i.id, i]))
  const conflicts = new Set([
    ...conflictingSourceIds,
    ...observedSources(snapshot)
      .filter((entry) => entry.conflict)
      .map((entry) => entry.source.id)
  ])
  const savedAmount = (sourceValue: unknown, raw: unknown, legacy: unknown): TaxYearAmount => {
    const source = readLedgerSource(sourceValue)
    const conflict = source !== undefined && conflicts.has(source.id)
    const amount = savedLedgerAmount(sourceValue, raw, legacy)
    return {
      ...amount,
      amount: conflict ? 'Unavailable' : amount.amount,
      // Keep the originally saved value for review, even when it cannot safely be interpreted.
      amountRaw: typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '',
      sourceId: source?.id ?? '',
      sourceLabel: source?.label ?? '',
      backend: source?.backend ?? '',
      assetId: source?.asset.canonicalId ?? '',
      network: source?.asset.network ?? '',
      environment: source?.asset.environment ?? 'unknown',
      decimals: source ? String(source.asset.decimals) : '',
      sourceStatus: conflict ? 'conflict' : source ? 'saved' : 'unknown'
    }
  }
  const sourceNote = (row: TaxYearRow): string => {
    if (row.sourceStatus === 'conflict')
      return ' Conflicting saved metadata for this source; interpreted amount withheld. Raw value retained for review.'
    if (row.sourceStatus === 'unknown')
      return ' Asset and source are unverified. Recorded app units do not identify a currency.'
    const amountNote =
      row.amount === 'Unavailable'
        ? ' Saved raw amount is missing or unsafe; interpreted amount withheld.'
        : ''
    const environmentNote =
      row.backend === 'mock' || row.environment === 'test'
        ? ' Test/demo data; not evidence of real funds.'
        : row.environment === 'unknown'
          ? ' Environment unknown; review before financial use.'
          : ''
    return `${amountNote} Source metadata is saved app context, not live verification.${environmentNote}`
  }
  const invoiceRow = (i: KasaInvoice, undated: boolean): TaxYearRow => ({
    type: undated ? 'Undated invoice — year unassigned' : 'Invoice issued in year',
    id: i.id,
    invoiceId: i.id,
    client: i.client,
    direction: '',
    ...savedAmount(i.source, i.amountRaw, i.amount),
    status: i.state,
    date: undated ? '' : ledgerDate(i.createdAt),
    basis:
      'Issue date only. Requested amount is not taxable revenue; receipt totals may span years.'
  })
  const paymentRow = (p: KasaPayment, undated: boolean): TaxYearRow => ({
    type: undated ? 'Undated payment — year unassigned' : 'Payment observation in year',
    id: String(p.nodeIdx),
    invoiceId: p.invoiceId ?? '',
    client: invoices.get(p.invoiceId ?? '')?.client ?? '',
    direction: p.direction,
    ...savedAmount(p.source, p.receivedRaw, p.received),
    status: p.status,
    date: undated ? '' : ledgerDate(p.blockTime),
    basis:
      'Recorded block date only; not a fiscal or settlement determination. Do not add to invoice amounts.'
  })
  return [
    ...review.invoices.map((i) => invoiceRow(i, false)),
    ...review.payments.map((p) => paymentRow(p, false)),
    ...review.undatedInvoices.map((i) => invoiceRow(i, true)),
    ...review.undatedPayments.map((p) => paymentRow(p, true))
  ].map((row) => ({ ...row, basis: row.basis + sourceNote(row) }))
}

export function taxYearRowsCsv(
  records: TaxYearRow[],
  notes: { type: string; text: string }[]
): string {
  const headers = [
    'Record_Type',
    'Record_ID',
    'Invoice_ID',
    'Client',
    'Direction',
    'Amount',
    'Amount_Unit',
    'Status',
    'Date_UTC',
    'Saved_Raw_Amount',
    'Source_ID',
    'Source_Label',
    'Backend',
    'Asset_ID',
    'Network',
    'Environment',
    'Decimals',
    'Source_Metadata_Status',
    'Notes'
  ]
  const note = (type: string, text: string): string[] =>
    headers.map((_, index) => (index === 0 ? type : index === headers.length - 1 ? text : ''))
  const rows = [
    headers,
    ...notes.map(({ type, text }) => note(type, text)),
    ...records.map((r) => [
      r.type,
      r.id,
      r.invoiceId,
      r.client,
      r.direction,
      r.amount,
      r.unit,
      r.status,
      r.date,
      r.amountRaw,
      r.sourceId,
      r.sourceLabel,
      r.backend,
      r.assetId,
      r.network,
      r.environment,
      r.decimals,
      r.sourceStatus,
      r.basis
    ])
  ]
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function taxYearCsv(snapshot: KasaSnapshot, year: number): string {
  const review = taxYearReview(snapshot, year)
  return taxYearRowsCsv(taxYearRows(snapshot, review), [
    {
      type: 'Scope',
      text: `${year} record review, Europe/Rome year boundaries. Invoice issue dates and payment block dates are filtered separately. Undated rows remain unassigned. Not a tax calculation.`
    },
    {
      type: 'Limitations',
      text: `Other-year records excluded: ${review.excludedInvoices} invoices, ${review.excludedPayments} payments. No EUR conversion or tax liability calculated. Invoice and payment rows can describe the same funds; do not sum them. Saved source metadata is not live verification. Test and unknown environments require separate review.`
    }
  ])
}
