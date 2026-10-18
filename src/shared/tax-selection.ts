import type { Taxpayer, TaxScope } from './tax-scope'

// The app profile is part of the identity even when two views happen to carry
// the same taxpayer and year. An explicit missing app selection must fail closed.
export function taxScopeKey(scope: TaxScope): string | null {
  if (scope.appProfileId !== undefined && !scope.appProfileId) return null
  const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
  if (!taxpayer || !validYear(taxpayer.profile.taxYear)) return null
  return JSON.stringify(
    scope.appProfileId === undefined
      ? [scope.databaseId, taxpayer.id, taxpayer.profile.taxYear]
      : [scope.databaseId, scope.appProfileId, taxpayer.id, taxpayer.profile.taxYear]
  )
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= 2023 && year <= 9999
}

// Always include the current settings for taxpayers imported before annual
// settings existed. Reading the available years does not create or edit settings.
export function savedTaxYears(taxpayer: Taxpayer): number[] {
  return [...new Set([taxpayer.profile, ...(taxpayer.yearProfiles ?? [])].map((p) => p.taxYear))]
    .filter(validYear)
    .sort((a, b) => b - a)
}
