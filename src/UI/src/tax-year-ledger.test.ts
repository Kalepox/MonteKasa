import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
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
const bitcoin: LedgerSource = {
  id: 'saved-bitcoin',
  label: 'Saved Bitcoin source',
  backend: 'wdk',
  asset: {
    symbol: 'BTC',
    canonicalId: 'bitcoin',
    network: 'bitcoin',
    decimals: 8,
    environment: 'live'
  }
}

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
    expect(rows[0].unit).toBe('recorded app units')
  })
  it('does not present cumulative invoice receipts as year receipts', () => {
    const review = taxYearReview(snapshot, 2025)
    expect(review.payments).toEqual([])
    expect(review.excludedPayments).toBe(1)
    const rows = taxYearRows(snapshot, review)
    expect(rows[0].amount).toBe('100.000000')
    expect(rows[0].unit).toBe('recorded app units')
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
      payments: [null, NaN, Infinity, 1e20].map((blockTime) => ({ ...payment, blockTime }))
    }
    const review = taxYearReview(records, 2026)
    expect(review.payments).toHaveLength(0)
    expect(review.undatedPayments).toHaveLength(4)
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
  it('exports legacy payment amounts with an unverified unit rather than assuming USDT', () => {
    const csv = taxYearCsv(snapshot, 2026)
    expect(csv).toContain('"Amount","Amount_Unit"')
    expect(csv).toContain('"125.000000","recorded app units"')
    expect(csv).not.toContain('USDT')
  })
  it('uses saved source precision and raw amounts rather than the current app conversion', () => {
    const records = {
      ...snapshot,
      payments: [
        {
          ...payment,
          receivedRaw: 123456789,
          source: {
            id: 'saved-source',
            label: 'Saved source',
            backend: 'wdk' as const,
            asset: {
              symbol: 'BTC',
              canonicalId: 'bitcoin',
              network: 'bitcoin',
              decimals: 8,
              environment: 'live' as const
            }
          }
        }
      ]
    }
    const rows = taxYearRows(records, taxYearReview(records, 2026))
    expect(rows[0]).toMatchObject({ amount: '1.23456789', unit: 'BTC' })
    expect(taxYearCsv(records, 2026)).toContain('"1.23456789","BTC"')
    for (const raw of [undefined, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { ...records, payments: [{ ...records.payments[0], receivedRaw: raw }] }
      expect(taxYearRows(invalid, taxYearReview(invalid, 2026))[0]).toMatchObject({
        amount: 'Unavailable',
        unit: 'BTC'
      })
    }
  })
  it('uses the saved invoice asset and raw amount without treating cumulative receipts as year income', () => {
    const records: KasaSnapshot = {
      ...snapshot,
      invoices: [{ ...invoice, source: bitcoin, amountRaw: 123456780, receivedRaw: 900000000 }]
    }
    const before = structuredClone(records)
    const [row] = taxYearRows(records, taxYearReview(records, 2025))
    expect(row).toMatchObject({
      amount: '1.23456780',
      unit: 'BTC',
      amountRaw: '123456780',
      sourceId: bitcoin.id,
      sourceLabel: bitcoin.label,
      backend: 'wdk',
      assetId: 'bitcoin',
      network: 'bitcoin',
      environment: 'live',
      decimals: '8',
      sourceStatus: 'saved'
    })
    expect(row.basis).toContain('receipt totals may span years')
    expect(taxYearCsv(records, 2025)).toContain('"1.23456780","BTC"')
    expect(taxYearCsv(records, 2025)).not.toContain('9.00000000')
    expect(records).toEqual(before)
  })
  it('keeps legacy invoices unverified even if a linked payment identifies an asset', () => {
    const records = {
      ...snapshot,
      payments: [{ ...payment, source: bitcoin, receivedRaw: 125000000 }]
    }
    const [row] = taxYearRows(records, taxYearReview(records, 2025))
    expect(row).toMatchObject({
      amount: '100.000000',
      unit: 'recorded app units',
      sourceStatus: 'unknown',
      sourceId: '',
      assetId: '',
      network: '',
      environment: 'unknown'
    })
    expect(row.basis).toContain('do not identify a currency')
    expect(taxYearCsv(records, 2025)).not.toContain('USDT')
  })
  it('withholds unsafe invoice amounts while retaining raw values and saved provenance for review', () => {
    for (const amountRaw of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const records = {
        ...snapshot,
        invoices: [{ ...invoice, source: bitcoin, amountRaw }]
      }
      const [row] = taxYearRows(records, taxYearReview(records, 2025))
      expect(row).toMatchObject({
        amount: 'Unavailable',
        unit: 'BTC',
        sourceStatus: 'saved',
        amountRaw: amountRaw === undefined ? '' : String(amountRaw)
      })
      expect(row.basis).toContain('missing or unsafe')
    }
    const records = {
      ...snapshot,
      invoices: [{ ...invoice, source: bitcoin, amountRaw: Number.MAX_SAFE_INTEGER }]
    }
    expect(taxYearRows(records, taxYearReview(records, 2025))[0].amount).toBe('90071992.54740991')
  })
  it('withholds invalid legacy amounts instead of showing a negative or non-finite amount', () => {
    for (const amount of [-1, NaN, Infinity]) {
      const records = {
        ...snapshot,
        invoices: [{ ...invoice, amount }],
        payments: [{ ...payment, received: amount }]
      }
      expect(taxYearRows(records, taxYearReview(records, 2025))[0].amount).toBe('Unavailable')
      expect(taxYearRows(records, taxYearReview(records, 2026))[0].amount).toBe('Unavailable')
    }
  })
  it('withholds conflicting source amounts even when the conflicting record is outside the selected year', () => {
    const records = {
      ...snapshot,
      invoices: [{ ...invoice, source: bitcoin, amountRaw: 100000000 }],
      payments: [
        {
          ...payment,
          receivedRaw: 100000000,
          source: { ...bitcoin, asset: { ...bitcoin.asset, network: 'other-network' } }
        }
      ]
    }
    for (const year of [2025, 2026]) {
      const [row] = taxYearRows(records, taxYearReview(records, year))
      expect(row).toMatchObject({
        amount: 'Unavailable',
        sourceStatus: 'conflict',
        amountRaw: '100000000'
      })
      expect(row.basis).toContain('Conflicting saved metadata')
      expect(taxYearCsv(records, year)).toContain('"100000000"')
      expect(taxYearCsv(records, year)).not.toContain('"1.00000000"')
    }
  })
  it('labels test, mock and unknown environments without converting them into verified live records', () => {
    const sources: LedgerSource[] = [
      { ...bitcoin, id: 'test', asset: { ...bitcoin.asset, environment: 'test' } },
      { ...bitcoin, id: 'mock', backend: 'mock' },
      { ...bitcoin, id: 'unknown', asset: { ...bitcoin.asset, environment: 'unknown' } }
    ]
    const records = {
      ...snapshot,
      payments: sources.map((source, nodeIdx) => ({ ...payment, nodeIdx, source, receivedRaw: 1 }))
    }
    const rows = taxYearRows(records, taxYearReview(records, 2026))
    expect(rows.map((row) => row.environment)).toEqual(['test', 'live', 'unknown'])
    expect(rows.every((row) => row.amount === '0.00000001')).toBe(true)
    expect(rows[0].basis).toContain('Test/demo data')
    expect(rows[1].basis).toContain('Test/demo data')
    expect(rows[2].basis).toContain('Environment unknown')
    expect(rows.every((row) => row.basis.includes('not live verification'))).toBe(true)
  })
  it('escapes formulas and quotes in every exported source field', () => {
    const source: LedgerSource = {
      ...bitcoin,
      id: '=SOURCE()',
      label: '+Label,"saved"',
      asset: { ...bitcoin.asset, symbol: '@BTC', canonicalId: '-ASSET()', network: '\tNetwork' }
    }
    const records = { ...snapshot, invoices: [{ ...invoice, source, amountRaw: 1 }] }
    const csv = taxYearCsv(records, 2025)
    expect(csv).toContain('"\'=SOURCE()"')
    expect(csv).toContain('"\'+Label,""saved"""')
    expect(csv).toContain('"\'@BTC"')
    expect(csv).toContain('"\'-ASSET()"')
    expect(csv).toContain('"\'\tNetwork"')
    expect(csv).toContain(
      '"Source_ID","Source_Label","Backend","Asset_ID","Network","Environment","Decimals","Source_Metadata_Status"'
    )
  })
  it('does not trust invalid source metadata or infer a payment currency from its linked invoice', () => {
    const records = {
      ...snapshot,
      payments: [
        {
          ...payment,
          receivedRaw: 125000000,
          source: {
            id: 'invalid-source',
            label: 'Unverified source',
            backend: 'wdk' as const,
            asset: {
              symbol: 'BTC',
              canonicalId: 'bitcoin',
              network: '',
              decimals: 8,
              environment: 'live' as const
            }
          }
        }
      ]
    }
    expect(taxYearRows(records, taxYearReview(records, 2026))[0]).toMatchObject({
      amount: '125.000000',
      unit: 'recorded app units'
    })
    expect(taxYearCsv(records, 2026)).not.toContain('BTC')
  })
  it('handles empty records and rejects invalid years', () => {
    expect(taxYearReview({ invoices: [], payments: [], proposals: [] }, 2026).payments).toEqual([])
    expect(() => taxYearReview(snapshot, NaN)).toThrow('Invalid review year')
    expect(() => taxYearReview(snapshot, 2025.5)).toThrow('Invalid review year')
  })
})
