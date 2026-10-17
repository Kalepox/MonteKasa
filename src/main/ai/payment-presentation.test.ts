import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { securityContext, securityFacts } from './security-context'
import { paymentExplanation } from './payment-presentation'
import type { SecuritySnapshot, SecurityOperation } from '../../shared/security'
const operation: SecurityOperation = {
  id: '09bebb2f-4d26-4829-8b6d-feabe0dba111',
  invoice: 'rgb:test',
  intentKey: 'internal',
  recipientId: 'recipient',
  assetId: 'asset',
  network: 'SignetCustom',
  amountRaw: 10000000,
  feeRate: 2,
  state: 'completed',
  createdAt: 10,
  updatedAt: 20,
  checkedAt: Math.floor(Date.now() / 1000),
  approvalExpiresAt: 30,
  confirmations: 4,
  rgbStatus: 'Settled',
  history: []
}
function snapshot(): SecuritySnapshot {
  return {
    operations: [structuredClone(operation)],
    findings: [],
    monitoring: {},
    requiredConfirmations: 3
  }
}
describe('payment explanations', () => {
  it('answers the reported ten USDT case without equating settlement with safety', () => {
    const context = securityContext(
      snapshot(),
      undefined,
      'were there any threats on my last payment of 10 usdt?'
    )
    const answer = paymentExplanation(context)!
    expect(answer).toBe(
      'Your payment is complete.\n\nNo active security warnings were found in the latest checks.\n\nFor further information, go to the Security panel.'
    )
    expect(answer).not.toContain('there is no threat')
    expect(securityFacts(context)).not.toContain(operation.id)
    expect(securityFacts(context)).toContain('Mutinynet · test funds')
  })
  it('selects the latest matching amount and rejects ambiguity or no match', () => {
    const data = snapshot()
    data.operations.push({ ...operation, id: 'second', createdAt: 50 })
    expect(() => securityContext(data, undefined, 'my payment of 10 USDT')).toThrow('More than one')
    expect(() => securityContext(data, undefined, 'last payment of 20 USDT')).toThrow('No matching')
    expect(
      JSON.parse(securityContext(data, undefined, 'latest payment of 10 USDT')).operations[0]
        .createdAt
    ).toBe(50)
  })
  it('links pre-submission findings by invoice hash without leaking the invoice', () => {
    const data = snapshot()
    data.findings.push({
      id: 'finding',
      rule: 'review-failed',
      subject: createHash('sha256').update(operation.invoice).digest('hex'),
      version: 1,
      severity: 'unavailable',
      message: 'private',
      evidence: { check: 'chain-config' },
      firstSeen: 1,
      lastSeen: 2,
      resolvedAt: 5
    })
    const context = securityContext(data, { kind: 'operation', id: operation.id })
    expect(JSON.parse(context).findings).toHaveLength(1)
    expect(context).not.toContain('rgb:test')
    expect(context).not.toContain('private')
    expect(paymentExplanation(context)).not.toContain('Resolved notices')
    expect(securityFacts(context)).not.toContain('Resolved notice')
    expect(paymentExplanation(securityContext(data, undefined, 'show resolved history'))).toContain(
      'Resolved notices'
    )
    expect(paymentExplanation(context)).toContain('No active security warnings')
  })
  it('labels stale completed evidence without inventing a failure', () => {
    const data = snapshot()
    data.operations[0].checkedAt = 1
    const answer = paymentExplanation(securityContext(data))!
    expect(answer).toContain('Last known:')
    expect(answer).toContain('Current verification unavailable')
  })
  it.each(['uncertain', 'submitting'] as const)('forbids resending %s', (state) => {
    const data = snapshot()
    data.operations[0].state = state
    expect(paymentExplanation(securityContext(data))).toContain('Do not resend or retry')
  })
  it('does not claim completion if required confirmation policy is missing', () => {
    const data = snapshot()
    delete data.requiredConfirmations
    expect(paymentExplanation(securityContext(data))).toContain(
      'Confirmation requirement unavailable'
    )
  })
})

it('does not infer a safe or stable wallet from empty evidence', () => {
  const data = snapshot()
  data.operations = []
  expect(paymentExplanation(securityContext(data))).toContain('does not establish')
  expect(paymentExplanation(securityContext(data))).not.toContain('stable state')
})

it('distinguishes RGB settlement from the remaining Bitcoin confirmation', () => {
  const data = snapshot()
  data.operations[0].state = 'confirming'
  data.operations[0].confirmations = 2
  const context = securityContext(data)
  expect(securityFacts(context)).toContain('RGB settled · Awaiting one more Bitcoin confirmation')
  expect(paymentExplanation(context)).toContain(
    'RGB settled · Awaiting one more Bitcoin confirmation'
  )
  expect(paymentExplanation(context)).not.toContain('payment is complete')
})
