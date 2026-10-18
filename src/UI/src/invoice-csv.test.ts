import { describe, expect, it } from 'vitest'
import { invoicesCsv } from './invoice-csv'
import type { KasaInvoice } from '../../preload/index.d'

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
