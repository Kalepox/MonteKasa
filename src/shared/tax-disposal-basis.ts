import { currentTaxYear } from './tax-profile'
import type { TaxScope } from './tax-scope'

// A documented allocation supplied by the user, not a lot calculation or verified cost.
export type TaxDisposalBasis = {
  taxpayerId: string
  taxYear: number
  recordKey: string
  facts: string
  transactionKind: 'fiat-sale' | 'goods-services'
  costBasisEur: string
  reference: string
  reviewed: boolean
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`${label} must be nonblank text of at most ${limit} characters.`)
  return value.trim()
}

export function disposalBasisKey(
  basis: Pick<TaxDisposalBasis, 'taxpayerId' | 'taxYear' | 'recordKey'>
): string {
  return JSON.stringify([basis.taxpayerId, basis.taxYear, basis.recordKey])
}

export function validateDisposalBasis(
  input: unknown,
  scope: TaxScope,
  records: ReadonlySet<string>,
  requireCurrentApplicability = true
): TaxDisposalBasis {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid disposal cost evidence.')
  const value = input as Record<string, unknown>
  const taxpayerId = text(value.taxpayerId, 200, 'Profile ID')
  const taxpayer = scope.taxpayers.find((entry) => entry.id === taxpayerId)
  if (!taxpayer) throw new Error('Select an existing profile.')
  const taxYear = value.taxYear
  if (!Number.isInteger(taxYear) || Number(taxYear) < 2023 || Number(taxYear) > currentTaxYear())
    throw new Error('Invalid disposal tax year.')
  const recordKey = text(value.recordKey, 200, 'Payment ID')
  if (!/^payment:.+$/.test(recordKey)) throw new Error('Cost evidence requires a payment record.')
  text(value.facts, 20000, 'Saved record facts')
  const transactionKind = value.transactionKind
  if (transactionKind !== 'fiat-sale' && transactionKind !== 'goods-services')
    throw new Error('Select a supported disposal type.')
  const costBasisEur = text(value.costBasisEur, 27, 'Documented cost in EUR')
  if (!/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$/.test(costBasisEur))
    throw new Error('Enter a non-negative EUR cost with at most 18 digits and 8 decimal places.')
  const reference = text(value.reference, 500, 'Cost allocation reference')
  if (typeof value.reviewed !== 'boolean') throw new Error('Invalid cost review confirmation.')

  if (requireCurrentApplicability) {
    if (scope.activeTaxpayerId !== taxpayerId)
      throw new Error('The selected profile changed. Reload before saving this cost evidence.')
    const profile = taxpayer.profile
    if (
      taxYear !== profile.taxYear ||
      ![2025, 2026].includes(Number(taxYear)) ||
      profile.country !== 'IT' ||
      profile.userType !== 'personal' ||
      profile.personalRegime !== 'dichiarativo'
    )
      throw new Error('Cost evidence does not match a supported saved profile and tax year.')
    const assignment = scope.assignments.find((entry) => entry.recordKey === recordKey)
    const account = scope.accounts.find((entry) => entry.id === assignment?.accountId)
    if (
      !records.has(recordKey) ||
      !assignment ||
      account?.taxpayerId !== taxpayerId ||
      !scope.assets.some((entry) => entry.id === assignment.assetId)
    )
      throw new Error('Assign an existing payment to this taxpayer before adding cost evidence.')
    const enrichment = scope.enrichments?.find(
      (entry) =>
        entry.recordKey === recordKey &&
        entry.accountId === assignment.accountId &&
        entry.assetId === assignment.assetId
    )
    const classification = transactionKind === 'fiat-sale' ? 'sale' : 'goods-services'
    if (enrichment?.classification !== classification)
      throw new Error(
        'The payment purpose changed. Review its details before saving cost evidence.'
      )
  }

  return {
    taxpayerId,
    taxYear: Number(taxYear),
    recordKey,
    // This opaque fingerprint must compare exactly against the current saved facts.
    facts: value.facts as string,
    transactionKind,
    costBasisEur,
    reference,
    reviewed: value.reviewed
  }
}
