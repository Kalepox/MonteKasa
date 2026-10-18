import { createHash } from 'node:crypto'
import type { SecuritySnapshot } from '../../shared/security'
import type { SecurityTarget } from '../../shared/agent'

const amount = (raw: number): string => {
  if (!Number.isSafeInteger(raw) || raw < 0) return 'unavailable'
  const n = BigInt(raw)
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDT`
}
// No arbitrary source text crosses the model boundary, including error messages.
const DESCRIPTIONS: Record<string, string> = {
  'invoice-discrepancy':
    'Invoice reconciliation requires review. Compare the recorded expected and received amounts; settlement is a separate check.',
  'late-payment-change': 'Recorded invoice payment evidence changed after a final state.',
  'incoming-refresh': 'Incoming payment refresh is unavailable.',
  'incoming-confirmations':
    'Incoming payment confirmation evidence is insufficient or unavailable.',
  'review-failed':
    'Payment review failed. The validated check code identifies the reason, when available.',
  'execution-blocked': 'Payment execution was blocked by a mandatory check.',
  'refund-destination': 'Independently verify the refund destination before approval.',
  'uncertain-submission':
    'The node may have accepted the payment. Outcome is unknown; do not resend.',
  'monitor-configuration':
    'The operation uses a different network or asset configuration from the current monitor.',
  'transfer-evidence': 'A unique matching outgoing RGB transfer is unavailable.',
  'rgb-failed': 'The RGB node reports failure. Review manually; do not automatically resend.',
  'settlement-regression': 'Previously recorded settlement no longer meets policy.',
  'chain-unavailable': 'Current chain confirmation evidence is unavailable.',
  'monitor-unavailable': 'Outgoing transfer refresh is unavailable; recorded status may be stale.'
}
const CHECKS = [
  'amount',
  'network',
  'asset',
  'recipient',
  'expiry',
  'invoice-amount',
  'invoice-format',
  'transport',
  'node-unavailable',
  'chain-identity',
  'stale-network',
  'chain-sync',
  'balance',
  'btc-reserve',
  'fee-cap',
  'input',
  'duplicate',
  'approval',
  'approval-expiry',
  'refund-destination',
  'fee-change',
  'approval-change',
  'submission-result',
  'stale-chain',
  'backend',
  'chain-config',
  'chain-url',
  'chain-api',
  'chain-checkpoint',
  'chain-height',
  'chain-response',
  'txid',
  'assignment',
  'busy',
  'client',
  'incoming-txid',
  'payment-amount'
]
const INVOICE_STATES = ['Issued', 'Pending', 'Paid', 'Underpaid', 'Overpaid', 'Expired', 'Flagged']
const member = (value: unknown, allowed: readonly string[], fallback = 'unknown'): string =>
  typeof value === 'string' && allowed.includes(value) ? value : fallback
const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const timestamp = (value: unknown): number | undefined => {
  const n = numeric(value)
  return n !== undefined && n <= 253402300799 ? n : undefined
}
// Keep real app record IDs recognizable. Malformed/free-text IDs become opaque aliases.
const recordId = (value: string): string =>
  /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)
    ? value
    : `record-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
const evidenceFields = (e: Record<string, unknown>): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const key of ['expectedRaw', 'receivedRaw']) {
    const n = numeric(e[key])
    if (n !== undefined) result[key.replace('Raw', 'Amount')] = amount(n)
  }
  for (const key of ['previousState', 'state']) {
    if (key in e) result[key] = member(e[key], INVOICE_STATES)
  }
  if ('check' in e) result.check = member(e.check, CHECKS)
  return result
}

// Policy descriptions are application-owned constants, never supplied by an invoice.
export function ruleGuidance(rule: string, check?: unknown): string | undefined {
  const validationFailure = rule === 'review-failed' || rule === 'execution-blocked'
  const recovery: Record<string, string> = {
    'chain-config':
      'Chain verification is not configured. Select the correct network profile and provide its node indexer and trusted checkpoint, then review again.',
    'chain-url': 'The chain service address is invalid. Use HTTPS or a local loopback service.',
    'chain-api':
      'The chain service is unavailable. Check its connection and refresh before reviewing again.',
    'chain-checkpoint':
      'The chain checkpoint does not match. Verify the configured network and trusted checkpoint; do not bypass this check.',
    'chain-height':
      'The chain service returned inconsistent height information. Refresh and check node synchronization.',
    'chain-response':
      'The chain service returned invalid verification data. Check the service before reviewing again.',
    'chain-sync':
      'The node and reference heights disagree. Allow synchronization and obtain fresh evidence before reviewing again.',
    'chain-identity':
      'The node and reference chain could not be matched. Verify the network and indexer configuration.',
    'node-unavailable':
      'The node is not ready. Check whether it is locked, syncing, or unreachable before reviewing again.',
    'invoice-amount':
      'The amount differs from the fixed invoice amount. Pay the requested amount or ask for a new invoice. Open-amount invoices accept any positive amount.',
    asset:
      'The invoice requests a different asset. Ask for an invoice for the configured asset on the same network.',
    transport:
      'The invoice uses an unsupported or unapproved delivery proxy. Verify the proxy with the recipient before changing configuration.',
    'approval-expiry':
      'Your approval expired. Start a fresh review and confirm the displayed details again.',
    amount: 'Enter a positive amount with no more than six decimal places.',
    approval: 'The approval does not match the reviewed details. Start a fresh review.',
    'fee-cap': 'The configured fee rate exceeds the limit. Inspect the fee configuration.',
    'fee-change': 'The fee policy changed. Start a fresh review.',
    'approval-change': 'Payment details changed. Start a fresh review.',
    busy: 'Another review or submission is running. Inspect its status before starting another.',
    backend:
      'A wallet service check failed. Inspect the technical details and obtain fresh evidence. This alone does not establish fraud.'
  }
  if (validationFailure && typeof check === 'string' && Object.hasOwn(recovery, check))
    return `Payment is BLOCKED: ${recovery[check]} No new payment is authorized by this explanation.`
  if (validationFailure && check === 'expiry')
    return 'Payment is BLOCKED: the invoice has expired or its expiry timestamp is invalid. Ask the payee for a new valid invoice and start a fresh review. Do not edit the expiry, change the device clock, or reuse an old approval to bypass the check. This does not establish fraud or a failed on-chain transaction.'
  if (validationFailure && check === 'balance')
    return 'Payment is BLOCKED: the verified spendable asset balance is insufficient for the requested amount. This is the asset balance, not the BTC fee reserve, and does not establish the total wallet balance. Refresh the node and verify available funds, then start a fresh review when sufficient funds are available. Do not bypass the check or change a fixed invoice amount. Adding funds does not automatically authorize sending.'
  if (validationFailure && check === 'btc-reserve')
    return 'Payment is BLOCKED: the verified BTC fee reserve is below the required minimum. An adequate asset balance does not cover this BTC requirement. Verify and replenish the BTC reserve as appropriate, refresh the node, and start a fresh review. The reserve is a policy minimum, not an exact transaction fee quote. Do not bypass the check.'
  if (validationFailure && check === 'stale-network')
    return 'Payment is BLOCKED until fresh network evidence is available: the observation is too old or its timestamp is not acceptable. Stale data does not prove that the network is offline, that funds are missing, or that a transaction failed. Refresh the node/reference evidence and start a fresh review. Waiting alone makes old evidence older; do not extend the freshness limit, change the device clock, or reuse an old approval to bypass the check.'
  if (rule === 'review-failed' && check === 'network')
    return 'Payment is BLOCKED: the invoice network differs from the configured network. Do not send this invoice or change networks to bypass the check. Ask the payee for a new invoice on the configured network and review it again. This mismatch is not proof of fraud. No submission or settlement is established by this finding.'
  if (rule === 'review-failed' && check === 'duplicate')
    return 'Another payment attempt is BLOCKED: this app already recorded a submission for the same recipient or refund. This does not mean two payments were sent, and does not prove the prior payment succeeded. Do not resend. Inspect the original operation and reconcile its status. Acknowledgment does not unlock sending. The recipient is not the submitter in this finding.'
  if (rule === 'uncertain-submission')
    return 'The submission outcome is UNKNOWN: the node may have accepted the payment despite a timeout or lost response. This is neither confirmed failure nor confirmed success. Do not resend or retry, including after waiting or restarting. Inspect the original operation and reconcile node/chain evidence; automatic retries remain disabled. Acknowledgment cannot clear this restriction.'
  return undefined
}

// Explicit projection: never pass invoices, approval tokens, wallet keys, or arbitrary
// object fields to the model. Even projected strings are untrusted evidence.
export function securityContext(
  snapshot: SecuritySnapshot,
  target?: SecurityTarget,
  query?: string
): string {
  if (
    target &&
    (!['finding', 'operation'].includes(target.kind) ||
      typeof target.id !== 'string' ||
      target.id.length > 100)
  )
    throw new Error('Invalid security explanation target.')
  if (!target && query && /\b(last|latest|payment|transaction)\b/i.test(query)) {
    const amountMatch = query.match(/\b(\d+(?:\.\d{1,6})?)\s*(?:test\s+)?usdt\b/i)
    const candidates = snapshot.operations
      .filter(
        (o) =>
          !/\b(last|latest)\b/i.test(query) || /\battempt\b/i.test(query) || o.state !== 'review'
      )
      .filter(
        (o) =>
          !amountMatch ||
          BigInt(o.amountRaw) ===
            BigInt(amountMatch[1].split('.')[0]) * 1000000n +
              BigInt((amountMatch[1].split('.')[1] ?? '').padEnd(6, '0'))
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    if (!candidates.length)
      throw new Error(
        'No matching outgoing payment is recorded. Select a payment from the Security panel to inspect it.'
      )
    if (candidates.length > 1 && !/\b(last|latest)\b/i.test(query))
      throw new Error(
        'More than one payment matches. Select the payment you mean in the Security panel, or ask about the latest payment.'
      )
    target = { kind: 'operation', id: candidates[0].id }
  }
  const selectedFinding =
    target?.kind === 'finding' ? snapshot.findings.find((f) => f.id === target.id) : undefined
  const selectedOperation =
    target?.kind === 'operation' ? snapshot.operations.find((o) => o.id === target.id) : undefined
  if (target && !selectedFinding && !selectedOperation)
    throw new Error('This security record is no longer available. Refresh the Security panel.')
  const includeResolved = /\b(history|historical|resolved|earlier|past threats)\b/i.test(
    query ?? ''
  )
  const findings = selectedFinding
    ? [selectedFinding]
    : snapshot.findings
        .filter((f) =>
          selectedOperation
            ? f.subject === selectedOperation.id ||
              f.subject === createHash('sha256').update(selectedOperation.invoice).digest('hex')
            : !f.resolvedAt || includeResolved
        )
        .sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)))
        .slice(0, 6)
  const operations = selectedOperation
    ? [selectedOperation]
    : snapshot.operations
        .filter((o) =>
          selectedFinding
            ? o.id === selectedFinding.subject ||
              createHash('sha256').update(o.invoice).digest('hex') === selectedFinding.subject
            : true
        )
        .slice(0, 2)
  return JSON.stringify({
    observedAt: Math.floor(Date.now() / 1000),
    scope:
      'Bounded snapshot of recorded checks, not a live network query or complete fraud assessment.',
    monitoring: {
      lastSuccess: timestamp(snapshot.monitoring.lastSuccess),
      unavailable: Boolean(snapshot.monitoring.error)
    },
    selected: target ? { kind: target.kind, id: recordId(target.id) } : undefined,
    omittedFindings: snapshot.findings.length - findings.length,
    sourceTextExcluded: true,
    requiredConfirmations: snapshot.requiredConfirmations,
    includeResolved,
    findings: findings.map((f) => {
      const rule = Object.hasOwn(DESCRIPTIONS, f.rule) ? f.rule : 'unknown'
      const evidence = evidenceFields(f.evidence)
      return {
        id: recordId(f.id),
        rule,
        severity: member(f.severity, ['block', 'review', 'unavailable'], 'unavailable'),
        ruleGuidance: ruleGuidance(rule, evidence.check),
        subject: recordId(f.subject),
        message:
          DESCRIPTIONS[rule] ?? 'Unrecognized finding; inspect the recorded checks in the app.',
        lastSeen: timestamp(f.lastSeen),
        resolvedAt: timestamp(f.resolvedAt),
        acknowledgedAt: timestamp(f.acknowledgedAt),
        evidence,
        history: (f.history ?? []).slice(-10).map((h) => ({
          at: timestamp(h.at),
          check: member(h.check, CHECKS),
          resolvedAt: timestamp(h.resolvedAt)
        }))
      }
    }),
    operations: operations.map((o) => ({
      id: recordId(o.id),
      state: member(o.state, [
        'review',
        'submitting',
        'submitted',
        'confirming',
        'completed',
        'uncertain',
        'failed',
        'cancelled'
      ]),
      network: member(o.network, [
        'Mainnet',
        'Testnet',
        'Testnet4',
        'Regtest',
        'Signet',
        'SignetCustom'
      ]),
      amount: amount(o.amountRaw),
      // Asset identity is intentionally omitted; the model needs amount/state, not raw identifiers.
      confirmations: numeric(o.confirmations),
      rgbStatus: member(o.rgbStatus, [
        'Initiated',
        'WaitingCounterparty',
        'WaitingSafeHeight',
        'WaitingBroadcast',
        'WaitingConfirmations',
        'Settled',
        'Failed',
        'not-submitted'
      ]),
      checkedAt: timestamp(o.checkedAt),
      createdAt: timestamp(o.createdAt),
      completedAt: timestamp(o.completedAt)
    }))
  })
}

// Displayed separately from generated prose; the model cannot edit these facts.
export function securityTechnicalDetails(context: string): string {
  const data = JSON.parse(context) as {
    findings: {
      id: string
      rule: string
      severity: string
      resolvedAt?: number
      ruleGuidance?: string
      message: string
      evidence: Record<string, unknown>
      lastSeen: number
      history?: { at?: number; check?: string; resolvedAt?: number }[]
    }[]
    operations: { id: string; state: string; rgbStatus: string; confirmations: number }[]
  }
  const lines = [
    'Source free text is excluded from explanations. Recorded evidence only. Review severity is not settlement; acknowledgment never approves payment.'
  ]
  for (const f of data.findings) {
    lines.push(
      `${f.rule} [${f.id}]: ${f.severity}${f.resolvedAt ? ' (resolved)' : ''}. ${f.message}`
    )
    if (f.ruleGuidance) lines.push(f.ruleGuidance)
    for (const [key, value] of Object.entries(f.evidence)) lines.push(`${key}: ${value}`)
    for (const past of f.history ?? [])
      lines.push(
        `Earlier check: ${past.check ?? 'unknown'}; recorded ${past.at ? new Date(past.at * 1000).toISOString() : 'time unavailable'}.`
      )
    lines.push(
      `Last recorded: ${f.lastSeen === undefined ? 'unavailable' : new Date(f.lastSeen * 1000).toISOString()}`
    )
  }
  for (const o of data.operations)
    lines.push(
      `Operation ${o.id}: ${o.state}; RGB ${o.rgbStatus}; Bitcoin confirmations ${o.confirmations}.`
    )
  if (!data.operations.length)
    lines.push('No transaction settlement status is included in this context.')
  if (!data.findings.length) lines.push('No findings included. This is not proof of safety.')
  return lines.join('\n')
}

// Critical payment warnings use policy-authored responses. A small model must not
// reinterpret a hard block, invent settlement, or suggest retrying an unknown send.
export function criticalSecurityExplanation(context: string): string | undefined {
  const data = JSON.parse(context) as {
    findings: { id: string; rule: string; resolvedAt?: number; evidence: { check?: unknown } }[]
    operations: { id: string; state: string }[]
  }
  const paragraphs: string[] = []
  for (const f of data.findings) {
    const guidance = ruleGuidance(f.rule, f.evidence.check)
    if (!guidance) continue
    if (f.resolvedAt) {
      paragraphs.push(
        'An earlier payment check was marked resolved. It is not a current block and does not authorize another payment. See the recorded details for the original check.'
      )
      continue
    }
    paragraphs.push(
      `Recorded finding ${f.id} (${f.rule}${f.evidence.check ? ` / ${f.evidence.check}` : ''})${f.resolvedAt ? ' — historical, marked resolved; this does not authorize another payment' : ''}:\n${guidance}`
    )
  }
  // A selected uncertain operation still gets safe guidance if its finding is
  // absent from the bounded snapshot.
  if (!paragraphs.length && data.operations.some((o) => o.state === 'uncertain'))
    paragraphs.push(`Recorded operation is uncertain.\n${ruleGuidance('uncertain-submission')}`)
  if (!paragraphs.length) return undefined
  return [
    'Policy explanation (application rules, not generated by AI).',
    ...paragraphs,
    'I cannot send funds, bypass checks, acknowledge or resolve findings, or change policy. Use the normal app review flow; all mandatory checks still apply. Acknowledging a notice only marks it seen and never authorizes a payment.'
  ].join('\n\n')
}

export { paymentFacts as securityFacts } from './payment-presentation'
