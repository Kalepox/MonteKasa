import { describe, expect, it } from 'vitest'
import { transactionDocumentHtml } from '../../shared/transaction-document'
import type { KasaPayment, KasaSnapshot } from '../../preload/index.d'

const payment: KasaPayment = {
  nodeIdx: 1,
  direction: 'in',
  invoiceId: 'inv-1',
  received: 12.5,
  status: 'settled',
  txid: 'abc123',
  blockTime: 86400,
  recipientId: 'recipient'
}
const snap: KasaSnapshot = {
  invoices: [
    {
      id: 'inv-1',
      client: '<b>Client</b>',
      amount: 12.5,
      received: 12.5,
      state: 'Paid',
      createdAt: 0,
      expiresAt: 86400,
      rgbInvoice: 'rgb:x',
      recipientId: 'recipient'
    }
  ],
  proposals: [],
  payments: [payment]
}
describe('transaction receipt document', () => {
  it('shows the recorded txid, time and amount and escapes client data', () => {
    const html = transactionDocumentHtml(payment, snap)
    expect(html).toContain('abc123')
    expect(html).toContain('1970-01-02 00:00:00 UTC')
    expect(html).toContain('12.500000 USDT')
    expect(html).not.toContain('+12.5')
    expect(html).toContain('&lt;b&gt;Client')
    expect(html).toContain('Torino')
  })
  it('marks an unconfirmed outgoing transfer without inventing a time', () => {
    const html = transactionDocumentHtml(
      { ...payment, direction: 'out', blockTime: null, invoiceId: null },
      snap
    )
    expect(html).toContain('Awaiting confirmation')
    expect(html).toContain('12.500000 USDT')
    expect(html).not.toContain('−12.5')
  })
})
