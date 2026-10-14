import { describe, expect, it } from 'vitest'
import { reconcile } from './reconcile'

const inv = { amountRaw: 10_000_000, expiresAt: 1000 }
const p = (status: string, receivedRaw = 0) => ({ status, receivedRaw })

describe('reconcile', () => {
  it('open invoice is Issued', () => expect(reconcile(inv, [p('waiting')], 500).state).toBe('Issued'))
  it('payment on its way is Pending', () => expect(reconcile(inv, [p('confirming', 10_000_000)], 500).state).toBe('Pending'))
  it('exact amount is Paid', () => expect(reconcile(inv, [p('settled', 10_000_000)], 500).state).toBe('Paid'))
  it('30 on a 10 invoice is Overpaid', () => {
    expect(reconcile(inv, [p('settled', 30_000_000)], 500)).toEqual({ state: 'Overpaid', receivedRaw: 30_000_000 })
  })
  it('less is Underpaid', () => expect(reconcile(inv, [p('settled', 5_000_000)], 500).state).toBe('Underpaid'))
  it('no payment after expiry is Expired', () => expect(reconcile(inv, [p('waiting')], 2000).state).toBe('Expired'))
  it('payment confirming at expiry is still Pending', () => expect(reconcile(inv, [p('confirming', 1)], 2000).state).toBe('Pending'))
  it('failed transfers are ignored', () => expect(reconcile(inv, [p('failed', 10_000_000)], 500).state).toBe('Issued'))
  it('two settled payments are Flagged', () =>
    expect(reconcile(inv, [p('settled', 1), p('settled', 1)], 500).state).toBe('Flagged'))
})
