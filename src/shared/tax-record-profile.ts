import type { TaxScope } from './tax-scope'

export type TaxRecordProfile = { recordKey: string; taxpayerId: string }

export function recordTaxpayerMap(scope: TaxScope): Map<string, string> {
  const taxpayers = new Set(scope.taxpayers.map((entry) => entry.id))
  const owners = new Map<string, string>()
  for (const relationship of scope.recordProfiles ?? [])
    if (taxpayers.has(relationship.taxpayerId))
      owners.set(relationship.recordKey, relationship.taxpayerId)
  const accounts = new Map(scope.accounts.map((entry) => [entry.id, entry.taxpayerId]))
  for (const assignment of scope.assignments) {
    const taxpayerId = accounts.get(assignment.accountId)
    if (taxpayerId && taxpayers.has(taxpayerId)) owners.set(assignment.recordKey, taxpayerId)
  }
  return owners
}

// A profile relationship lets a person review their saved records without
// inventing the account, asset identity or ownership percentage needed for tax.
export function recordTaxpayerId(scope: TaxScope, recordKey: string): string | undefined {
  return recordTaxpayerMap(scope).get(recordKey)
}

export function validateRecordProfile(
  value: unknown,
  scope: TaxScope,
  owners: ReadonlyMap<string, string> = recordTaxpayerMap(scope)
): TaxRecordProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid record profile relationship.')
  const entry = value as Record<string, unknown>
  if (
    typeof entry.recordKey !== 'string' ||
    !/^(invoice|payment):\S+$/.test(entry.recordKey) ||
    entry.recordKey.length > 200 ||
    typeof entry.taxpayerId !== 'string' ||
    !scope.taxpayers.some((taxpayer) => taxpayer.id === entry.taxpayerId)
  )
    throw new Error('Invalid record profile relationship.')
  const owner = owners.get(entry.recordKey)
  if (owner && owner !== entry.taxpayerId)
    throw new Error(
      'This record already belongs to another profile. Review its existing relationship.'
    )
  return { recordKey: entry.recordKey, taxpayerId: entry.taxpayerId }
}
