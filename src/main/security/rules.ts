import type { DecodedInvoice, NetworkEvidence, SecurityPolicy } from './types'

export class SecurityViolation extends Error {
  constructor(
    public rule: string,
    message: string,
    public severity: 'block' | 'unavailable' = 'block'
  ) {
    super(message)
  }
}
export function requireCheck(
  condition: unknown,
  rule: string,
  message: string,
  severity: 'block' | 'unavailable' = 'block'
): asserts condition {
  if (!condition) throw new SecurityViolation(rule, message, severity)
}
export function validateInvoice(
  d: DecodedInvoice,
  raw: number,
  p: SecurityPolicy,
  now: number
): string[] {
  requireCheck(Number.isSafeInteger(raw) && raw > 0, 'amount', 'Invalid raw amount.')
  requireCheck(
    d.network === p.network,
    'network',
    'Invoice network does not match the configured network.'
  )
  requireCheck(
    d.assetId === null || d.assetId === p.assetId,
    'asset',
    'Invoice requests a different asset.'
  )
  requireCheck(
    typeof d.recipientId === 'string' && d.recipientId.length > 0,
    'recipient',
    'Invoice has no recipient.'
  )
  requireCheck(
    d.expiresAt === null || (Number.isSafeInteger(d.expiresAt) && d.expiresAt > now),
    'expiry',
    'Invoice has expired or has an invalid expiry.'
  )
  requireCheck(
    d.amountRaw === null || d.amountRaw === raw,
    'invoice-amount',
    'Amount does not match the fixed invoice amount.'
  )
  requireCheck(
    d.endpoints.length > 0,
    'transport',
    'Out-of-band delivery is not supported by this app.'
  )
  for (const endpoint of d.endpoints) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new SecurityViolation('transport', 'Invalid transport endpoint.')
    }
    requireCheck(
      url.protocol === 'rpcs:' &&
        !url.username &&
        !url.password &&
        p.allowedTransportHosts.includes(url.host),
      'transport',
      'Invoice transport is not an approved secure proxy.'
    )
  }
  return [
    d.assetId === null
      ? 'Invoice allows any asset; this approval sends only the configured asset.'
      : '',
    d.amountRaw === null ? 'Open-amount invoice: verify the amount shown.' : '',
    d.expiresAt === null ? 'Invoice has no expiry.' : ''
  ].filter(Boolean)
}
export function validateNetwork(
  n: NetworkEvidence,
  raw: number,
  p: SecurityPolicy,
  now: number
): string[] {
  requireCheck(
    n.online,
    'node-unavailable',
    'Node is offline, locked, or not ready.',
    'unavailable'
  )
  requireCheck(
    n.network === p.network && n.identityVerified,
    'chain-identity',
    'The node and reference chain identity could not be verified.',
    'unavailable'
  )
  requireCheck(
    Number.isFinite(n.checkedAt) && n.checkedAt <= now + 5 && now - n.checkedAt <= p.evidenceMaxAge,
    'stale-network',
    'Network evidence is stale.',
    'unavailable'
  )
  requireCheck(
    Number.isSafeInteger(n.height) &&
      Number.isSafeInteger(n.referenceHeight) &&
      n.height >= 0 &&
      n.referenceHeight >= 0 &&
      Math.abs(n.referenceHeight - n.height) <= p.maxHeightLag,
    'chain-sync',
    'Node and reference chain heights disagree.',
    'unavailable'
  )
  requireCheck(
    Number.isSafeInteger(n.balanceRaw) && n.balanceRaw >= raw,
    'balance',
    'Insufficient verified spendable asset balance.'
  )
  requireCheck(
    Number.isSafeInteger(n.btcSats) && n.btcSats >= p.minBtcSats,
    'btc-reserve',
    'Insufficient BTC fee reserve.'
  )
  requireCheck(
    Number.isFinite(p.feeRate) && p.feeRate > 0 && p.feeRate <= p.maxFeeRate,
    'fee-cap',
    'Configured fee rate exceeds policy.'
  )
  return n.recommendedFeeRate && p.feeRate < n.recommendedFeeRate
    ? ['The configured fee rate is below the reference estimate; confirmation may be delayed.']
    : []
}
