import type { TaxScope } from './tax-scope'

export const recordClassifications = [
  'unknown',
  'purchase',
  'sale',
  'own-transfer',
  'goods-services',
  'income',
  'refund'
] as const
export type Valuation = { eur: string; date: string; source: string; reference: string }
export type TaxEnrichment = {
  recordKey: string
  accountId: string
  assetId: string
  classification: (typeof recordClassifications)[number]
  valuation: Valuation
  fee: {
    status: 'unknown' | 'none' | 'recorded'
    amount: string
    assetId: string
    purpose: string
    reference: string
    valuation: Valuation
  }
  relatedRecordKey: string
}
export const emptyValuation = (): Valuation => ({ eur: '', date: '', source: '', reference: '' })

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid enrichment data.')
  return input as Record<string, unknown>
}
function text(input: unknown): string {
  if (typeof input !== 'string' || input.length > 500)
    throw new Error('Text fields must be at most 500 characters.')
  return input.trim()
}
// Decimal strings preserve precision; blank means unknown, never zero.
function amount(input: unknown, decimals: number): string {
  const result = text(input)
  if (
    result &&
    !new RegExp(`^(0|[1-9][0-9]{0,29})${decimals ? `(\\.[0-9]{1,${decimals}})?` : ''}$`).test(
      result
    )
  )
    throw new Error(`Enter a non-negative decimal amount with at most ${decimals} decimal places.`)
  return result
}
function valuation(input: unknown): Valuation {
  const v = object(input)
  const date = text(v.date)
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    throw new Error('Enter a valid valuation date.')
  return { eur: amount(v.eur, 8), date, source: text(v.source), reference: text(v.reference) }
}
export function validateEnrichment(
  input: unknown,
  scope: TaxScope,
  records: Set<string>
): TaxEnrichment {
  const e = object(input)
  const recordKey = text(e.recordKey)
  const assignment = scope.assignments.find((a) => a.recordKey === recordKey)
  if (!records.has(recordKey) || !assignment)
    throw new Error('Assign an existing database record first.')
  if (e.accountId !== assignment.accountId || e.assetId !== assignment.assetId)
    throw new Error('Record scope changed. Reload before saving enrichment.')
  if (!recordClassifications.includes(e.classification as TaxEnrichment['classification']))
    throw new Error('Invalid record classification.')
  const f = object(e.fee)
  if (!['unknown', 'none', 'recorded'].includes(String(f.status)))
    throw new Error('Invalid fee status.')
  const feeAsset = scope.assets.find((a) => a.id === f.assetId)
  const fee: TaxEnrichment['fee'] =
    f.status === 'recorded'
      ? {
          status: 'recorded',
          amount: amount(f.amount, feeAsset?.decimals ?? 0),
          assetId: text(f.assetId),
          purpose: text(f.purpose),
          reference: text(f.reference),
          valuation: valuation(f.valuation)
        }
      : {
          status: f.status as 'unknown' | 'none',
          amount: '',
          assetId: '',
          purpose: '',
          reference: '',
          valuation: emptyValuation()
        }
  if (fee.status === 'recorded' && (!feeAsset || !fee.amount))
    throw new Error('A recorded fee needs an amount and declared asset.')
  const relatedRecordKey = text(e.relatedRecordKey)
  if (relatedRecordKey) {
    const related = scope.assignments.find((a) => a.recordKey === relatedRecordKey)
    const owner = (id: string): string | undefined =>
      scope.accounts.find((a) => a.id === id)?.taxpayerId
    if (
      !related ||
      !records.has(relatedRecordKey) ||
      relatedRecordKey === recordKey ||
      owner(related.accountId) !== owner(assignment.accountId)
    )
      throw new Error(
        'Related records must be distinct, present and assigned to the same taxpayer.'
      )
    if (!['own-transfer', 'refund'].includes(String(e.classification)))
      throw new Error('Links are available for own transfers and refunds.')
    if (
      e.classification === 'own-transfer' &&
      (related.accountId === assignment.accountId ||
        related.assetId !== assignment.assetId ||
        !recordKey.startsWith('payment:') ||
        !relatedRecordKey.startsWith('payment:'))
    )
      throw new Error(
        'Own transfers require payment records in different owned accounts with the same asset.'
      )
  }
  return {
    ...assignment,
    classification: e.classification as TaxEnrichment['classification'],
    valuation: valuation(e.valuation),
    fee,
    relatedRecordKey
  }
}
export function valuationComplete(v: Valuation): boolean {
  return [v.eur, v.date, v.source, v.reference].every(Boolean)
}
export function enrichmentGaps(entries: (TaxEnrichment | undefined)[]): string[] {
  if (!entries.length) return []
  const count = (test: (e: TaxEnrichment | undefined) => boolean): number =>
    entries.filter(test).length
  const gaps: string[] = []
  const classification = count((e) => !e || e.classification === 'unknown')
  const eur = count((e) => !e || !valuationComplete(e.valuation))
  const links = count((e) =>
    Boolean(e && ['own-transfer', 'refund'].includes(e.classification) && !e.relatedRecordKey)
  )
  if (classification) gaps.push(`${classification} record(s) need a transaction classification.`)
  if (eur)
    gaps.push(`${eur} record(s) need EUR value, valuation date, source and evidence reference.`)
  if (links)
    gaps.push(`${links} transfer/refund record(s) need a related record for reconciliation.`)
  return gaps
}
export function feeGaps(entries: (TaxEnrichment | undefined)[]): string[] {
  const missing = entries.filter(
    (e) =>
      !e ||
      e.fee.status === 'unknown' ||
      (e.fee.status === 'recorded' &&
        (!e.fee.purpose || !e.fee.reference || !valuationComplete(e.fee.valuation)))
  ).length
  return missing
    ? [`${missing} record(s) need fee status, or recorded fee purpose, EUR valuation and evidence.`]
    : []
}
