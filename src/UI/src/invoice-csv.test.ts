import { describe, expect, it } from 'vitest'
import { invoiceDetailsCsv, invoicesCsv, transactionsCsv } from './invoice-csv'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'

const invoice: KasaInvoice = {
  id: 'actual-id',
  client: 'Client',
  amount: 1.000001,
  received: 0,
  createdAt: 0,
  expiresAt: 86400,
  state: 'Issued',
  rgbInvoice: 'rgb:test',
  recipientId: 'recipient'
}
describe('invoice CSV', () => {
  it('exports a header only for an empty ledger', () => {
    expect(invoicesCsv([]).split('\r\n')).toHaveLength(2)
    expect(invoicesCsv([])).not.toContain('Meridian')
  })
  it('exports actual values at full supported precision and UTC dates', () => {
    expect(invoicesCsv([invoice])).toContain(
      '"actual-id","Client","1.000001","0.000000","1970-01-01T00:00:00.000Z","1970-01-02T00:00:00.000Z","Issued"'
    )
  })
  it('escapes commas, quotes and multiline client names', () => {
    expect(invoicesCsv([{ ...invoice, client: 'Acme, "Design"\nStudio' }])).toContain(
      '"Acme, ""Design""\nStudio"'
    )
  })
  it.each(['=1+1', '+SUM(1)', '-1+2', '@SUM(1)', '  =1', '\t=1', '\r=1', '\n=1'])(
    'neutralizes formula prefix %j',
    (client) => {
      expect(invoicesCsv([{ ...invoice, client }])).toContain(`"'${client}"`)
    }
  )
})

describe('transaction CSV', () => {
  const payment: KasaPayment = {
    nodeIdx: 1,
    direction: 'in',
    invoiceId: 'actual-id',
    received: 12.5,
    status: 'settled',
    txid: 'abc123',
    blockTime: 86400,
    recipientId: 'recipient'
  }
  const snap: KasaSnapshot = { invoices: [invoice], proposals: [], payments: [payment] }
  it('books an incoming payment as a credit linked to its invoice', () => {
    const lines = transactionsCsv([payment], snap).split('\r\n')
    expect(lines[0]).toContain('"Credit_USDT","Debit_USDT"')
    expect(lines[1]).toBe(
      '"1970-01-02T00:00:00.000Z","abc123","Receipt","Incoming","USDT (RGB20)","Mutinynet","12.500000","","12.500000","settled","actual-id","Client","1.000001","0.000000","Issued","","recipient"'
    )
  })
  it('books an outgoing refund as a debit with a negative net amount', () => {
    const out = { ...payment, direction: 'out' as const, invoiceId: null, txid: 'def456' }
    const refundSnap: KasaSnapshot = {
      ...snap,
      proposals: [
        { id: 'p1', invoiceId: 'actual-id', kind: 'refund', amount: 12.5, reason: '', status: 'executed', txid: 'def456', error: null }
      ]
    }
    const row = transactionsCsv([out], refundSnap).split('\r\n')[1]
    expect(row).toContain('"Refund","Outgoing"')
    expect(row).toContain('"","12.500000","-12.500000"')
    expect(row).toContain('"p1"')
  })
  it('leaves the date empty for an unconfirmed payment', () => {
    expect(transactionsCsv([{ ...payment, blockTime: null }], snap).split('\r\n')[1]).toMatch(/^"",/)
  })
})

describe('invoice details CSV', () => {
  const payment: KasaPayment = {
    nodeIdx: 1,
    direction: 'in',
    invoiceId: 'actual-id',
    received: 1,
    status: 'settled',
    txid: 'abc123',
    blockTime: 86400,
    recipientId: 'recipient'
  }
  it('lists each invoice with its balance and payment evidence', () => {
    const csv = invoiceDetailsCsv({
      invoices: [{ ...invoice, received: 1, createdAt: 3600 }],
      proposals: [],
      payments: [payment]
    })
    expect(csv.split('\r\n')[1]).toBe(
      '"actual-id","Client","1.000001","1.000000","0.000001","1970-01-01T01:00:00.000Z","1970-01-02T00:00:00.000Z","Issued","recipient","rgb:test","1","abc123","1970-01-02T00:00:00.000Z","1970-01-02T00:00:00.000Z"'
    )
  })
  it('leaves payment columns empty for an unpaid invoice', () => {
    const row = invoiceDetailsCsv({ invoices: [invoice], proposals: [], payments: [] }).split('\r\n')[1]
    expect(row).toContain('"0","","",""')
  })
})
