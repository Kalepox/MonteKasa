import { describe, expect, it } from 'vitest'
import { invoiceDocumentHtml } from '../../shared/invoice-document'
import type { KasaInvoice } from '../../preload/index.d'
const invoice: KasaInvoice = {
  id: 'record-id',
  client: '<img src=x onerror=alert(1)>',
  amount: 12.345678,
  received: 0,
  state: 'Issued',
  createdAt: 0,
  expiresAt: 86400,
  rgbInvoice: 'rgb:test',
  recipientId: 'test'
}
describe('invoice record document', () => {
  it('uses actual amounts and safely escapes client data', () => {
    const html = invoiceDocumentHtml(invoice)
    expect(html).toContain('12.345678 USDT')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('VERIFIED')
    expect(html).not.toContain('834112')
  })
  it.each(['Issued', 'Pending', 'Paid', 'Overpaid', 'Underpaid', 'Expired', 'Flagged'])(
    'reports the recorded %s state without inventing proof',
    (state) => {
      expect(invoiceDocumentHtml({ ...invoice, state })).toContain(`<td>${state}</td>`)
    }
  )
})
