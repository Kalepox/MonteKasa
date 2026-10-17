import type { SecurityFinding } from '../../shared/security'

const reasons: Record<string, string> = {
  expiry: 'The invoice has expired or its expiry is invalid. Ask for a new invoice.',
  'invoice-amount':
    'The entered amount does not match the amount requested by the invoice. Use the requested amount or ask for a new invoice.',
  balance: 'There is not enough verified spendable USDT for this payment.',
  'btc-reserve':
    'The Bitcoin balance available for fees is below the required reserve. This reserve is not an exact fee quote.',
  network:
    'The invoice uses a different network from this wallet. Ask for an invoice on the correct network.',
  asset: 'The invoice requests a different asset from the one configured in this wallet.',
  duplicate:
    'A payment has already been submitted for this recipient or refund. Check the original payment; do not send it again.',
  'approval-expiry': 'Your payment approval expired. Review the payment again before confirming.',
  approval: 'The approval does not match this payment. Start a new payment review.',
  'approval-change':
    'The payment details changed after review. Review them again before confirming.',
  'fee-change': 'The fee settings changed after review. Start a new payment review.',
  'fee-cap': 'The configured Bitcoin fee rate exceeds the allowed limit.',
  amount: 'Enter a positive payment amount with no more than six decimal places.',
  recipient: 'The invoice is missing a valid recipient. Ask for a new invoice.',
  transport: 'The invoice delivery service is unsupported or is not an approved secure proxy.',
  'node-unavailable':
    'The wallet node is offline, locked, or not ready. Check the node connection.',
  'chain-config': 'Bitcoin verification is not configured. Check the network configuration.',
  'chain-identity':
    'The wallet node and reference Bitcoin network could not be verified as matching.',
  'chain-sync':
    'The wallet node and reference service disagree on the Bitcoin block height. Allow the node to synchronize.',
  'stale-network':
    'The network information is out of date. Refresh it before reviewing the payment again.',
  busy: 'Another payment review or submission is in progress. Check its status first.'
}
const titles: Record<string, string> = {
  'invoice-discrepancy': 'Payment amount needs review',
  'late-payment-change': 'Invoice payment details changed',
  'incoming-refresh': 'Incoming payment check unavailable',
  'incoming-confirmations': 'Incoming payment verification pending',
  'refund-destination': 'Verify refund recipient',
  'uncertain-submission': 'Payment outcome unknown',
  'monitor-configuration': 'Payment network configuration changed',
  'transfer-evidence': 'Payment could not be matched',
  'rgb-failed': 'Transfer failed',
  'settlement-regression': 'Payment confirmation needs review',
  'chain-unavailable': 'Confirmation check unavailable',
  'monitor-unavailable': 'Payment monitoring unavailable'
}
const explanations: Record<string, string> = {
  'uncertain-submission':
    'The node may have accepted this payment, but its outcome could not be confirmed. Do not resend it; check the original payment.',
  'transfer-evidence':
    'A unique matching transfer could not be found. The payment status cannot currently be verified.',
  'incoming-confirmations':
    'The incoming payment has not met the verified Bitcoin confirmation requirement, or that check is unavailable.',
  'chain-unavailable':
    'Current Bitcoin confirmations could not be verified. The last recorded payment status may be out of date.',
  'monitor-unavailable':
    'Outgoing payments could not be refreshed. The displayed statuses may be out of date.',
  'incoming-refresh': 'Incoming payments could not be refreshed. Check the wallet node connection.'
}
const numbers: Record<string, [string, string]> = {
  expectedRaw: ['Invoice amount', 'USDT'],
  receivedRaw: ['Received amount', 'USDT'],
  requestedRaw: ['Entered payment amount', 'USDT'],
  invoiceAmountRaw: ['Invoice amount', 'USDT'],
  availableRaw: ['Verified spendable balance', 'USDT'],
  availableSats: ['Bitcoin available for fees', 'sats'],
  requiredSats: ['Minimum Bitcoin reserve', 'sats'],
  confirmations: ['Recorded Bitcoin confirmations', ''],
  requiredConfirmations: ['Required Bitcoin confirmations', ''],
  feeRate: ['Configured fee rate', 'sat/vB'],
  maxFeeRate: ['Maximum allowed fee rate', 'sat/vB']
}
export function securityNotice(f: SecurityFinding): {
  title: string
  reason: string
  evidence: string[]
} {
  const check = typeof f.evidence.check === 'string' ? f.evidence.check : ''
  const validation = f.rule === 'review-failed' || f.rule === 'execution-blocked'
  const title = validation
    ? f.severity === 'unavailable'
      ? 'Payment verification unavailable'
      : 'Payment blocked'
    : (titles[f.rule] ?? 'Security notice')
  let reason = (validation ? reasons[check] : explanations[f.rule]) ?? f.message
  if (f.rule === 'invoice-discrepancy') {
    const { expectedRaw, receivedRaw } = f.evidence
    if (
      typeof expectedRaw === 'number' &&
      typeof receivedRaw === 'number' &&
      Number.isSafeInteger(expectedRaw) &&
      Number.isSafeInteger(receivedRaw)
    )
      reason =
        receivedRaw > expectedRaw
          ? 'More USDT was received than the invoice requested. Compare the amounts before arranging any refund.'
          : receivedRaw < expectedRaw
            ? 'Less USDT was received than the invoice requested. Check the remaining amount with the payer.'
            : 'The invoice needs reconciliation. Review its recorded payments.'
  }
  const evidence: string[] = []
  for (const [key, [label, unit]] of Object.entries(numbers)) {
    const value = f.evidence[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    if (unit !== 'sat/vB' && !Number.isSafeInteger(value)) continue
    evidence.push(
      `${label}: ${unit === 'USDT' ? (value / 1e6).toFixed(6).replace(/\.?0+$/, '') : value}${unit ? ` ${unit}` : ''}`
    )
  }
  for (const [key, label] of Object.entries({
    expiresAt: 'Invoice expiry',
    checkedAt: 'Evidence recorded'
  })) {
    const value = f.evidence[key]
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= 253402300799
    )
      evidence.push(`${label}: ${new Date(value * 1000).toLocaleString()}`)
  }
  for (const [key, label] of Object.entries({
    invoiceNetwork: 'Invoice network',
    configuredNetwork: 'Wallet network',
    previousState: 'Previous invoice status',
    state: 'Updated invoice status',
    rgbStatus: 'Recorded RGB status',
    relatedOperationId: 'Original payment reference'
  })) {
    const value = f.evidence[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 100)
      evidence.push(`${label}: ${value}`)
  }
  return { title: f.resolvedAt ? `Resolved · ${title}` : title, reason, evidence }
}
