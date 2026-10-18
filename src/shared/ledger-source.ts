// Identifies a configured application ledger stream, not a verified wallet or owner.
// Metadata is captured when a record is first saved; older records remain unknown.
export type LedgerSource = {
  id: string
  label: string
  backend: 'mock' | 'kaleido' | 'wdk'
  asset: {
    symbol: string
    canonicalId: string
    network: string
    decimals: number
    environment: 'live' | 'test' | 'unknown'
  }
}

export function readLedgerSource(value: unknown): LedgerSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const s = value as Record<string, unknown>
  if (!s.asset || typeof s.asset !== 'object' || Array.isArray(s.asset)) return undefined
  const a = s.asset as Record<string, unknown>
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= 2048
  if (
    !text(s.id) ||
    !text(s.label) ||
    typeof s.backend !== 'string' ||
    !['mock', 'kaleido', 'wdk'].includes(s.backend) ||
    !text(a.symbol) ||
    !text(a.canonicalId) ||
    !text(a.network) ||
    !Number.isInteger(a.decimals) ||
    Number(a.decimals) < 0 ||
    Number(a.decimals) > 18 ||
    typeof a.environment !== 'string' ||
    !['live', 'test', 'unknown'].includes(a.environment)
  )
    return undefined
  return {
    id: s.id,
    label: s.label,
    backend: s.backend as LedgerSource['backend'],
    asset: {
      symbol: a.symbol,
      canonicalId: a.canonicalId,
      network: a.network,
      decimals: a.decimals as number,
      environment: a.environment as LedgerSource['asset']['environment']
    }
  }
}
