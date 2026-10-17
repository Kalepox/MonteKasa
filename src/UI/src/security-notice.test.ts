import { describe, expect, it } from 'vitest'
import { securityNotice } from './security-notice'
import type { SecurityFinding } from '../../shared/security'

const finding: SecurityFinding = {
  id: 'id',
  rule: 'review-failed',
  subject: 'hash',
  version: 1,
  severity: 'block',
  message: 'Original reason',
  evidence: { check: 'expiry' },
  firstSeen: 1,
  lastSeen: 2
}
describe('readable security notices', () => {
  it('explains legacy check-only notices without redundant evidence', () => {
    const result = securityNotice(finding)
    expect(result.title).toBe('Payment blocked')
    expect(result.reason).toContain('Ask for a new invoice')
    expect(result.evidence).toEqual([])
  })
  it('shows recorded values with readable units and omits unsupported data', () => {
    const result = securityNotice({
      ...finding,
      evidence: {
        check: 'balance',
        requestedRaw: 20000000,
        availableRaw: 10000000,
        note: 'secret',
        availableSats: NaN
      }
    })
    expect(result.reason).toContain('spendable USDT')
    expect(result.evidence).toEqual([
      'Entered payment amount: 20 USDT',
      'Verified spendable balance: 10 USDT'
    ])
  })
  it('distinguishes unavailable checks from detected threats', () => {
    expect(
      securityNotice({
        ...finding,
        severity: 'unavailable',
        evidence: { check: 'node-unavailable' }
      }).title
    ).toBe('Payment verification unavailable')
    expect(securityNotice({ ...finding, rule: 'chain-unavailable' }).reason).toContain(
      'could not be verified'
    )
  })
  it('keeps specific invoice character errors and labels resolved findings', () => {
    const result = securityNotice({
      ...finding,
      evidence: { check: 'invoice-format' },
      message: 'Unexpected character at the end: “ù” (U+00F9).',
      resolvedAt: 3
    })
    expect(result.title).toBe('Resolved · Payment blocked')
    expect(result.reason).toContain('“ù”')
    expect(result.evidence).toEqual([])
  })
  it('explains overpayment and retains uncertainty instructions', () => {
    const result = securityNotice({
      ...finding,
      rule: 'invoice-discrepancy',
      evidence: { expectedRaw: 10000000, receivedRaw: 12000000 }
    })
    expect(result.reason).toContain('More USDT')
    expect(result.evidence).toEqual(['Invoice amount: 10 USDT', 'Received amount: 12 USDT'])
    expect(securityNotice({ ...finding, rule: 'uncertain-submission' }).reason).toContain(
      'Do not resend'
    )
  })
  it('does not fabricate details for an unknown or older failure', () => {
    expect(securityNotice({ ...finding, evidence: { check: 'unknown' } }).reason).toBe(
      'Original reason'
    )
    expect(securityNotice({ ...finding, evidence: {} }).evidence).toEqual([])
  })
})
