import type { InvoiceRow, PaymentRow } from '../db'
import type { InvoiceState } from './types'

export function reconcile(
  inv: Pick<InvoiceRow, 'amountRaw' | 'expiresAt'>,
  payments: Pick<PaymentRow, 'status' | 'receivedRaw'>[],
  now: number
): { state: InvoiceState; receivedRaw: number } {
  const settled = payments.filter((p) => p.status === 'settled')
  const receivedRaw = settled.reduce((s, p) => {
    if (
      !Number.isSafeInteger(p.receivedRaw) ||
      p.receivedRaw < 0 ||
      !Number.isSafeInteger(s + p.receivedRaw)
    )
      throw new Error('Payment total exceeds the supported integer range.')
    return s + p.receivedRaw
  }, 0)

  if (settled.length > 1) return { state: 'Flagged', receivedRaw }
  if (settled.length === 1) {
    if (receivedRaw === inv.amountRaw) return { state: 'Paid', receivedRaw }
    return { state: receivedRaw < inv.amountRaw ? 'Underpaid' : 'Overpaid', receivedRaw }
  }
  // 'waiting' is just the open invoice itself (the node creates it with the invoice);
  // 'confirming' means a real payment is on its way
  if (payments.some((p) => p.status === 'confirming')) return { state: 'Pending', receivedRaw }
  if (now > inv.expiresAt) return { state: 'Expired', receivedRaw }
  return { state: 'Issued', receivedRaw }
}
