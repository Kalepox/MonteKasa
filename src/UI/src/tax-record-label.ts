import type { KasaSnapshot } from '../../preload/index.d'

function dateLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Date unavailable'
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Rome' }).format(
    date
  )
}
// These are database observations, not verified assets or fiscal recognition dates.
export function taxRecordLabel(snapshot: KasaSnapshot, key: string): string {
  const invoice = snapshot.invoices.find((i) => key === `invoice:${i.id}`)
  if (invoice)
    return `Invoice request · ${dateLabel(invoice.createdAt)} · ${invoice.client || 'Unnamed customer'} · ${invoice.state} · ${invoice.id}`
  const payment = snapshot.payments.find((p) => key === `payment:${p.nodeIdx}`)
  if (payment)
    return `${payment.direction === 'in' ? 'Incoming' : 'Outgoing'} payment observation · ${dateLabel(payment.blockTime)} · ${payment.status} · ${payment.txid || 'Transaction reference unavailable'} · #${payment.nodeIdx}`
  return 'Record no longer available'
}
