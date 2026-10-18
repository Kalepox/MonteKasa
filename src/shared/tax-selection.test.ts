import { describe, expect, it } from 'vitest'
import type { TaxScope } from './tax-scope'
import { savedTaxYears, taxScopeKey } from './tax-selection'

function fixture(): TaxScope {
  return {
    version: 1,
    databaseId: 'saved-db',
    appProfileId: 'app-one',
    activeTaxpayerId: 'taxpayer',
    taxpayers: [
      {
        id: 'taxpayer',
        label: 'Saved taxpayer',
        profile: {
          version: 1,
          country: 'IT',
          taxYear: 2026,
          userType: 'personal',
          personalRegime: 'dichiarativo',
          businessType: null,
          businessRegime: null,
          recordsCoverage: 'unknown'
        }
      }
    ],
    accounts: [],
    assets: [],
    assignments: []
  }
}

describe('saved app profile and year selection', () => {
  it('identifies the database, app profile, taxpayer and year independently', () => {
    const scope = fixture()
    const variants = [
      scope,
      { ...scope, databaseId: 'different-db' },
      { ...scope, appProfileId: 'app-two' },
      { ...scope, activeTaxpayerId: 'other', taxpayers: [{ ...scope.taxpayers[0], id: 'other' }] },
      {
        ...scope,
        taxpayers: [
          { ...scope.taxpayers[0], profile: { ...scope.taxpayers[0].profile, taxYear: 2025 } }
        ]
      }
    ]
    expect(taxScopeKey(scope)).toBe(JSON.stringify(['saved-db', 'app-one', 'taxpayer', 2026]))
    expect(new Set(variants.map(taxScopeKey)).size).toBe(5)
  })

  it('retains legacy keys but never falls back from an explicit missing app selection', () => {
    const scope = fixture()
    expect(taxScopeKey({ ...scope, appProfileId: undefined })).toBe(
      JSON.stringify(['saved-db', 'taxpayer', 2026])
    )
    for (const appProfileId of [null, ''])
      expect(taxScopeKey({ ...scope, appProfileId })).toBeNull()
    for (const activeTaxpayerId of [undefined, 'missing'])
      expect(taxScopeKey({ ...scope, activeTaxpayerId })).toBeNull()
    scope.taxpayers[0].profile.taxYear = NaN
    expect(taxScopeKey(scope)).toBeNull()
  })

  it('lists unique saved years including imported current settings without mutating them', () => {
    const taxpayer = fixture().taxpayers[0]
    expect(savedTaxYears(taxpayer)).toEqual([2026])
    taxpayer.yearProfiles = [2025, 2027, 2026, 2025].map((taxYear) => ({
      ...taxpayer.profile,
      taxYear
    }))
    const before = structuredClone(taxpayer)
    Object.freeze(taxpayer.yearProfiles)
    expect(savedTaxYears(taxpayer)).toEqual([2027, 2026, 2025])
    expect(taxpayer).toEqual(before)
  })
})
