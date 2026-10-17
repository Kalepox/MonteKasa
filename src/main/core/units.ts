import { rgbConfig } from '../rgb/config'
const FACTOR = 10 ** rgbConfig.precision

// Parse decimal digits exactly. Never silently round financial inputs.
export function toRaw(value: string | number): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid amount.')
  const text = String(value)
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text)
  if (!match || (match[2]?.length ?? 0) > rgbConfig.precision)
    throw new Error('Use a positive amount with at most 6 decimal places.')
  const raw =
    BigInt(match[1]) * BigInt(FACTOR) + BigInt((match[2] ?? '').padEnd(rgbConfig.precision, '0'))
  if (raw <= 0n || raw > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Amount is outside the supported range.')
  return Number(raw)
}
export const toUsdt = (raw: number): number => raw / FACTOR
