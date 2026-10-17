import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import { taxYearReview, taxYearRows, taxYearCsv } from './tax-year-ledger'

const seconds = (date: string): number => Date.parse(date) / 1000
const invoice: KasaInvoice = {
  id: 'prior-year',
  client: 'Client',
  amount: 100,
  received: 125,
  state: 'Overpaid',
  createdAt: seconds('2025-12-01T12:00:00Z'),
  expiresAt: seconds('2026-01-01T12:00:00Z'),
  rgbInvoice: 'rgb:test',
  recipientId: 'recipient'
}
const payment: KasaPayment = {
  nodeIdx: 1,
  direction: 'in',
  invoiceId: invoice.id,
  received: 125,
  status: 'settled',
  txid: 'tx-test',
  blockTime: seconds('2026-01-02T12:00:00Z')
}
const snapshot: KasaSnapshot = { invoices: [invoice], payments: [payment], proposals: [] }

describe('tax-year record review', () => {
  it('selects invoice and payment dates independently and retains cross-year invoice references', () => {
    const review = taxYearReview(snapshot, 2026)
    expect(review.invoices).toEqual([])
    expect(review.payments).toEqual([payment])
    expect(review.excludedInvoices).toBe(1)
    const rows = taxYearRows(snapshot, review)
    expect(rows[0].client).toBe('Client')
    expect(rows[0].invoiceId).toBe('prior-year')
    expect(rows[0].amount).toBe('125.000000')
  })
  it('does not present cumulative invoice receipts as year receipts', () => {
    const review = taxYearReview(snapshot, 2025)
    expect(review.payments).toEqual([])
    expect(review.excludedPayments).toBe(1)
    const rows = taxYearRows(snapshot, review)
    expect(rows[0].amount).toBe('100.000000')
    expect(rows[0].basis).toContain('receipt totals may span years')
  })
  it('uses Europe/Rome boundaries rather than UTC or the host timezone', () => {
    const records = {
      ...snapshot,
      payments: ['2025-12-31T22:59:59Z', '2025-12-31T23:00:00Z', '2026-12-31T23:00:00Z'].map(
        (date, nodeIdx) => ({ ...payment, nodeIdx, blockTime: seconds(date) })
      )
    }
    expect(taxYearReview(records, 2026).payments.map((p) => p.nodeIdx)).toEqual([1])
    expect(taxYearReview(records, 2025).payments.map((p) => p.nodeIdx)).toEqual([0])
    expect(taxYearReview(records, 2027).payments.map((p) => p.nodeIdx)).toEqual([2])
  })
  it('keeps undated and invalid-date records unassigned and visible', () => {
    const records = {
      ...snapshot,
      invoices: [{ ...invoice, createdAt: NaN }],
      payments: [null, NaN, Infinity].map((blockTime) => ({ ...payment, blockTime }))
    }
    const review = taxYearReview(records, 2026)
    expect(review.payments).toHaveLength(0)
    expect(review.undatedPayments).toHaveLength(3)
    expect(review.undatedInvoices).toHaveLength(1)
    expect(review.excludedPayments).toBe(0)
    expect(
      taxYearRows(records, review).every((r) => r.type.includes('year unassigned') && r.date === '')
    ).toBe(true)
  })
  it('preserves failed/pending statuses, outbound direction and unlinked payments', () => {
    const records = {
      ...snapshot,
      payments: [
        { ...payment, status: 'pending', direction: 'out' as const, invoiceId: null },
        { ...payment, nodeIdx: 2, status: 'failed', invoiceId: 'unknown-invoice' }
      ]
    }
    const rows = taxYearRows(records, taxYearReview(records, 2026))
    expect(rows.map((r) => r.status)).toEqual(['pending', 'failed'])
    expect(rows[0].direction).toBe('out')
    expect(rows[0].invoiceId).toBe('')
    expect(rows[1].client).toBe('')
  })
  it('exports the full selected year plus unassigned records, without totals or tax claims', () => {
    const records = {
      ...snapshot,
      payments: [payment, { ...payment, nodeIdx: 2, blockTime: null }]
    }
    const csv = taxYearCsv(records, 2026)
    expect(csv).toContain('2026 record review, Europe/Rome')
    expect(csv).toContain('Undated payment — year unassigned')
    expect(csv).toContain('1 invoices, 0 payments')
    expect(csv).toContain('No EUR conversion or tax liability calculated')
    expect(csv).not.toContain('Invoice issued in year')
    expect(csv).not.toContain('Invoice totals')
  })
  it('escapes spreadsheet formulas and retains six decimal places', () => {
    const records = {
      ...snapshot,
      invoices: [{ ...invoice, client: '=SUM(1),"x"', amount: 0.000001 }]
    }
    const csv = taxYearCsv(records, 2025)
    expect(csv).toContain('"\'=SUM(1),""x"""')
    expect(csv).toContain('"0.000001"')
  })
  it('exports every record even when the UI shows only the first 100', () => {
    const records = {
      ...snapshot,
      payments: Array.from({ length: 101 }, (_, nodeIdx) => ({ ...payment, nodeIdx }))
    }
    expect(taxYearRows(records, taxYearReview(records, 2026))).toHaveLength(101)
    expect(taxYearCsv(records, 2026)).toContain('"Payment observation in year","100"')
  })
  it('handles empty records and rejects invalid years', () => {
    expect(taxYearReview({ invoices: [], payments: [], proposals: [] }, 2026).payments).toEqual([])
    expect(() => taxYearReview(snapshot, NaN)).toThrow('Invalid review year')
    expect(() => taxYearReview(snapshot, 2025.5)).toThrow('Invalid review year')
  })
})
