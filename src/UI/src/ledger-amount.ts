import { readLedgerSource } from '../../shared/ledger-source'

export function rawLedgerAmount(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null
}

// Sum atomic units as integers; never round a saved amount through floating point.
export function formatLedgerRaw(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, '0')
  return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits
}

export function savedLedgerAmount(
  sourceValue: unknown,
  raw: unknown,
  legacy: unknown
): { amount: string; unit: string } {
  const source = readLedgerSource(sourceValue)
  if (!source)
    return {
      amount:
        typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0
          ? legacy.toFixed(6)
          : 'Unavailable',
      unit: 'recorded app units'
    }
  const units = rawLedgerAmount(raw)
  return {
    amount: units === null ? 'Unavailable' : formatLedgerRaw(units, source.asset.decimals),
    unit: source.asset.symbol
  }
}

export function ledgerDate(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
