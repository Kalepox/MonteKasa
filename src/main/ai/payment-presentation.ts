// Only consumes the sanitized main-process projection, never raw invoice text.
interface Evidence {
  includeResolved?: boolean
  observedAt?: number
  requiredConfirmations?: number
  omittedFindings?: number
  monitoring?: { unavailable?: boolean }
  operations: {
    id: string
    amount: string
    network: string
    state: string
    rgbStatus: string
    confirmations: number
    checkedAt?: number
  }[]
  findings: {
    id: string
    severity: string
    rule: string
    message: string
    ruleGuidance?: string
    resolvedAt?: number
    evidence: Record<string, unknown>
  }[]
}
const labels: Record<string, string> = {
  completed: 'Completed',
  review: 'Awaiting your confirmation',
  submitting: 'Submitting',
  submitted: 'Submitted — not yet settled',
  confirming: 'Waiting for confirmation',
  uncertain: 'Submission outcome unknown',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const checkNames: Record<string, string> = {
  'chain-config': 'Chain-verification setup was missing',
  'invoice-amount': 'The entered amount did not match the fixed invoice',
  expiry: 'The invoice was expired or had an invalid expiry',
  balance: 'Spendable asset balance was insufficient',
  'btc-reserve': 'BTC fee reserve was insufficient',
  network: 'The invoice network did not match',
  transport: 'The invoice proxy did not meet policy',
  'chain-sync': 'Node and reference heights disagreed'
}
const notice = (f: Evidence['findings'][number]): string =>
  typeof f.evidence.check === 'string' && Object.hasOwn(checkNames, f.evidence.check)
    ? checkNames[f.evidence.check]
    : f.message
const readableAmount = (value: string): string =>
  value.replace(/(\.\d*?[1-9])0+(?= USDT)|\.0+(?= USDT)/, '$1')
const time = (value?: number): string =>
  value === undefined ? 'unavailable' : new Date(value * 1000).toLocaleString()
function stale(data: Evidence, checkedAt?: number): boolean {
  return (
    Boolean(data.monitoring?.unavailable) ||
    checkedAt === undefined ||
    data.observedAt === undefined ||
    data.observedAt - checkedAt > 30 ||
    checkedAt > data.observedAt + 5
  )
}
function paymentStatus(data: Evidence, o: Evidence['operations'][number]): string {
  const unavailable =
    stale(data, o.checkedAt) ||
    data.findings.some((f) => !f.resolvedAt && f.severity === 'unavailable')
  if (unavailable)
    return `Last known: ${o.rgbStatus === 'Settled' ? 'RGB settled' : (labels[o.state] ?? 'Status unavailable')} · Current verification unavailable`
  if (o.state === 'uncertain' || o.state === 'submitting') return labels[o.state]
  if (o.rgbStatus === 'Settled') {
    if (typeof data.requiredConfirmations !== 'number')
      return 'RGB settled · Confirmation requirement unavailable'
    const remaining = data.requiredConfirmations - o.confirmations
    if (remaining > 0)
      return `RGB settled · Awaiting ${remaining === 1 ? 'one more Bitcoin confirmation' : `${remaining} more Bitcoin confirmations`}`
    if (o.state === 'completed') return 'Completed'
    return 'RGB settled · Completion verification pending'
  }
  return labels[o.state] ?? 'Status unavailable'
}
export function paymentFacts(context: string): string {
  const data = JSON.parse(context) as Evidence
  const lines: string[] = []
  for (const o of data.operations) {
    lines.push(`${readableAmount(o.amount)} outgoing payment · ${paymentStatus(data, o)}`)
    lines.push(`Network: ${o.network === 'SignetCustom' ? 'Mutinynet · test funds' : o.network}`)
    lines.push(
      `RGB transfer: ${o.rgbStatus === 'Settled' ? 'Settled' : (labels[o.state] ?? 'Unavailable')}. Bitcoin confirmations: ${o.confirmations}${data.requiredConfirmations ? ` (${data.requiredConfirmations} required)` : ''}.`
    )
    lines.push(
      `Last checked: ${time(o.checkedAt)}${stale(data, o.checkedAt) ? ' — current verification unavailable or out of date' : ''}.`
    )
  }
  if (!data.operations.length)
    lines.push('No transaction settlement status is included in these records.')
  const active = data.findings.filter((f) => !f.resolvedAt)
  lines.push(
    active.length
      ? `${active.length} current notice(s) in these records.`
      : 'No current warnings included for this selection. This is not a complete fraud assessment.'
  )
  for (const f of data.findings.filter((f) => !f.resolvedAt || data.includeResolved)) {
    lines.push(
      `${f.resolvedAt ? 'Resolved notice' : f.severity === 'unavailable' ? 'Verification unavailable' : 'Needs attention'}: ${notice(f)}`
    )
    if (f.ruleGuidance && !f.resolvedAt) lines.push(f.ruleGuidance)
    for (const [key, value] of Object.entries(f.evidence)) {
      if (key === 'expectedAmount') lines.push(`Expected: ${value}`)
      if (key === 'receivedAmount') lines.push(`Received: ${value}`)
    }
  }
  return lines.join('\n')
}
export function paymentExplanation(context: string): string | undefined {
  const data = JSON.parse(context) as Evidence
  if (data.operations?.length === 0 && data.findings?.length === 0)
    return 'No payment or warning is included in this snapshot. That does not establish that the wallet or a recipient is safe. Select a recorded payment in the Security panel, or ask about your latest payment, to inspect its status and relevant warnings.'
  if (data.operations?.length !== 1 || !Array.isArray(data.findings)) return undefined
  const o = data.operations[0]
  const active = data.findings.filter((f) => !f.resolvedAt)
  const status = paymentStatus(data, o)
  const unavailable = status.startsWith('Last known:')
  const paragraphs = [status === 'Completed' ? 'Your payment is complete.' : `${status}.`]
  paragraphs.push(
    active.length
      ? active
          .map(
            (f) =>
              `${f.severity === 'unavailable' ? 'Verification gap' : 'Current warning'}: ${notice(f)}`
          )
          .join(' ')
      : unavailable
        ? 'I could not verify current security warnings; this is the last known result.'
        : 'No active security warnings were found in the latest checks.'
  )
  if (data.includeResolved) {
    const historical = data.findings.filter((f) => f.resolvedAt)
    if (historical.length) paragraphs.push(`Resolved notices: ${historical.map(notice).join(' ')}`)
  }
  if (o.state === 'uncertain' || o.state === 'submitting')
    paragraphs.push('Do not resend or retry: the original submission must be verified first.')
  paragraphs.push('For further information, go to the Security panel.')
  return paragraphs.join('\n\n')
}

export function findingExplanation(context: string): string | undefined {
  const data = JSON.parse(context) as Evidence
  if (data.operations?.length || data.findings?.length !== 1) return undefined
  const f = data.findings[0]
  if (f.rule !== 'invoice-discrepancy') return undefined
  const expected = f.evidence.expectedAmount
  const received = f.evidence.receivedAmount
  if (typeof expected !== 'string' || typeof received !== 'string') return undefined
  const raw = (value: string): bigint => BigInt(value.replace(' USDT', '').replace('.', ''))
  const comparison =
    raw(received) > raw(expected)
      ? 'overpayment'
      : raw(received) < raw(expected)
        ? 'underpayment'
        : 'reconciliation issue'
  return [
    `The invoice has a recorded ${comparison}${f.resolvedAt ? ' that has been marked resolved' : ' requiring review'}.`,
    `Expected: ${readableAmount(expected)}. Received: ${readableAmount(received)}. These are recorded invoice totals; this finding alone does not establish transaction settlement or fraud.`,
    'Compare the original invoice with the recorded payment. If a refund is appropriate, verify the destination with the customer and use the normal refund review. Do not change the invoice amount simply to clear a warning.',
    'I cannot send a refund, approve payments, or acknowledge notices. Acknowledging a notice only marks it seen.'
  ].join('\n\n')
}
