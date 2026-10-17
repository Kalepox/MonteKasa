import { describe, expect, it } from 'vitest'
import { searchLedger, taxRecordsCsv } from './ledger'
import type { KasaSnapshot } from '../../preload/index.d'

const snapshot: KasaSnapshot = {
  proposals: [],
  invoices: [
    {
      id: 'abc123-full',
      client: 'Acme Studio',
      amount: 12.345678,
      received: 2.000001,
      state: 'Underpaid',
      createdAt: 0,
      expiresAt: 86400,
      rgbInvoice: 'rgb:test',
      recipientId: 'recipient'
    }
  ],
  payments: [
    {
      nodeIdx: 7,
      invoiceId: 'abc123-full',
      received: 2.000001,
      status: 'settled',
      txid: 'tx-real',
      blockTime: 100
    }
  ]
}
describe('recorded ledger search', () => {
  it.each(['acme studio', 'INV-ABC123', '12.345678', '1970-01-01', 'Underpaid'])(
    'finds invoice by %s',
    (query) => {
      expect(searchLedger(snapshot, query)).toContain('Invoice abc123-full')
    }
  )
  it('finds payments by transaction ID and includes their status', () => {
    expect(searchLedger(snapshot, 'tx-real settled')).toContain('Payment 7')
    expect(searchLedger(snapshot, 'tx-real')).toContain('2.000001 USDT')
  })
  it('requires every search term and handles blank and no-match queries', () => {
    expect(searchLedger(snapshot, 'acme missing')).toContain('No matching')
    expect(searchLedger(snapshot, '')).toContain('Enter a client')
    expect(searchLedger({ invoices: [], payments: [], proposals: [] }, 'acme')).toContain(
      'No matching'
    )
  })
  it('handles unlinked payments and missing dates', () => {
    const result = searchLedger(
      { ...snapshot, payments: [{ ...snapshot.payments[0], invoiceId: null, blockTime: null }] },
      'tx-real'
    )
    expect(result).toContain('Unlinked payment')
    expect(result).toContain('Date unavailable')
  })
})
describe('tax records CSV', () => {
  it('exports actual amounts and discloses missing tax data', () => {
    const csv = taxRecordsCsv(snapshot)
    expect(csv).toContain('12.345678')
    expect(csv).toContain('2.000001')
    expect(csv).toContain('Acme Studio')
    expect(csv).toContain('Tax liability is not calculated')
    expect(csv).not.toContain('63900')
  })
  it('does not double count payment observations in invoice totals', () => {
    const line = taxRecordsCsv(snapshot)
      .split('\r\n')
      .find((line) => line.startsWith('"Invoice totals"'))!
    expect(line).toContain('"12.345678","2.000001"')
  })
  it('totals decimal amounts without floating point drift', () => {
    const s = {
      ...snapshot,
      invoices: [0.1, 0.2].map((amount) => ({ ...snapshot.invoices[0], amount, received: amount }))
    }
    expect(taxRecordsCsv(s)).toContain('"0.300000","0.300000"')
  })
  it('exports zero totals for an empty ledger without claiming zero taxes', () => {
    const csv = taxRecordsCsv({ invoices: [], payments: [], proposals: [] })
    expect(csv).toContain('"0.000000","0.000000"')
    expect(csv).toContain('Tax liability is not calculated')
  })
  it('escapes client names and neutralizes spreadsheet formulas', () => {
    const csv = taxRecordsCsv({
      ...snapshot,
      invoices: [{ ...snapshot.invoices[0], client: '=SUM(1),"x"\nline' }]
    })
    expect(csv).toContain('"\'=SUM(1),""x""\nline"')
  })
})
