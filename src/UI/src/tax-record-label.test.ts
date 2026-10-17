import { describe, expect, it } from 'vitest'
import { taxRecordLabel } from './tax-record-label'
import type { KasaSnapshot } from '../../preload/index.d'
const snapshot: KasaSnapshot = {
  invoices: [
    {
      id: 'invoice',
      client: '<script>customer</script>',
      amount: 1,
      received: 0,
      rgbInvoice: '',
      recipientId: '',
      expiresAt: 1,
      createdAt: Date.parse('2025-12-31T23:30:00Z') / 1000,
      state: 'Expired'
    }
  ],
  payments: [
    {
      nodeIdx: 1,
      direction: 'out',
      invoiceId: null,
      received: 1,
      status: 'pending',
      txid: 'tx-reference',
      blockTime: null
    }
  ],
  proposals: []
}
describe('record identification', () => {
  it('distinguishes invoice requests with Rome dates, customer and status without assuming a token', () => {
    const label = taxRecordLabel(snapshot, 'invoice:invoice')
    expect(label).toContain('Invoice request')
    expect(label).toContain('1 Jan 2026')
    expect(label).toContain('<script>customer</script>')
    expect(label).toContain('Expired')
    expect(label).not.toContain('USDT')
  })
  it('shows payment direction, missing date, status and reference', () => {
    expect(taxRecordLabel(snapshot, 'payment:1')).toBe(
      'Outgoing payment observation · Date unavailable · pending · tx-reference · #1'
    )
  })
  it('handles invalid dates and missing references without treating them as settlement', () => {
    const copy = structuredClone(snapshot)
    copy.payments[0] = { ...copy.payments[0], direction: 'in', blockTime: Infinity, txid: null }
    expect(taxRecordLabel(copy, 'payment:1')).toContain(
      'Incoming payment observation · Date unavailable'
    )
    expect(taxRecordLabel(copy, 'payment:1')).toContain('Transaction reference unavailable')
    expect(taxRecordLabel(copy, 'payment:999')).toBe('Record no longer available')
  })
})
