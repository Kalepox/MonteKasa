import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxProfileStore } from './tax-profile'
import { validateTaxProfile, taxProfileNotes } from '../shared/tax-profile'

const personal = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'unknown'
}
const business = {
  ...personal,
  userType: 'business',
  personalRegime: null,
  businessType: 'company',
  businessRegime: 'ordinary'
}
const directories: string[] = []
function store(): { path: string; store: TaxProfileStore } {
  const directory = mkdtempSync(join(tmpdir(), 'tax-profile-test-'))
  directories.push(directory)
  const path = join(directory, 'profile.json')
  return { path, store: new TaxProfileStore(path) }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('tax profile validation', () => {
  it.each(['dichiarativo', 'amministrato', 'unknown'])(
    'supports personal regime %s',
    (personalRegime) => {
      expect(validateTaxProfile({ ...personal, personalRegime }, 2026).personalRegime).toBe(
        personalRegime
      )
    }
  )
  it.each(['company', 'partnership', 'sole-trader', 'professional'])(
    'supports business type %s',
    (businessType) => {
      expect(validateTaxProfile({ ...business, businessType }, 2026).businessType).toBe(
        businessType
      )
    }
  )
  it.each(['sole-trader', 'professional'])(
    'allows declared forfettario for %s without verifying eligibility',
    (businessType) => {
      const profile = validateTaxProfile(
        { ...business, businessType, businessRegime: 'forfettario' },
        2026
      )
      expect(taxProfileNotes(profile).join(' ')).toContain('eligibility has not been verified')
    }
  )
  it.each(['company', 'partnership'])('rejects forfettario for %s', (businessType) => {
    expect(() =>
      validateTaxProfile({ ...business, businessType, businessRegime: 'forfettario' }, 2026)
    ).toThrow('only selectable')
  })
  it.each([
    { version: 2 },
    { country: 'XX' },
    { taxYear: 2027 },
    { taxYear: 2022 },
    { taxYear: 2025.5 },
    { taxYear: '2026' },
    { userType: 'invalid' },
    { personalRegime: 'invalid' },
    { recordsCoverage: 'invalid' }
  ])('rejects invalid input %j', (invalid) => {
    expect(() => validateTaxProfile({ ...personal, ...invalid }, 2026)).toThrow()
  })
  it('discards fields from the other profile type and arbitrary extra input', () => {
    expect(
      validateTaxProfile(
        { ...personal, businessType: 'company', businessRegime: 'ordinary', taxRate: 0 },
        2026
      )
    ).toEqual(personal)
    expect(validateTaxProfile({ ...business, personalRegime: 'amministrato' }, 2026)).toEqual(
      business
    )
  })
  it('flags unsupported countries and self-declared completeness', () => {
    const notes = taxProfileNotes(
      validateTaxProfile(
        { ...personal, country: 'other', recordsCoverage: 'complete', personalRegime: 'unknown' },
        2026
      )
    ).join(' ')
    expect(notes).toContain('professional review')
    expect(notes).toContain('regime still needs to be confirmed')
    expect(notes).toContain('not been independently verified')
    expect(notes).toContain('all recorded dates')
  })
})

describe('local profile persistence', () => {
  it('returns no profile on first use and persists through a new store instance', () => {
    const fixture = store()
    expect(fixture.store.get()).toBeNull()
    expect(fixture.store.save(personal)).toEqual(personal)
    expect(new TaxProfileStore(fixture.path).get()).toEqual(personal)
    fixture.store.save(business)
    expect(new TaxProfileStore(fixture.path).get()).toEqual(business)
  })
  it('does not overwrite a saved profile with invalid input', () => {
    const fixture = store()
    fixture.store.save(personal)
    expect(() => fixture.store.save({ ...business, businessRegime: 'forfettario' })).toThrow()
    expect(fixture.store.get()).toEqual(personal)
  })
  it('reports corrupt storage instead of silently resetting it', () => {
    const fixture = store()
    writeFileSync(fixture.path, '{invalid')
    expect(() => fixture.store.get()).toThrow('has not been changed')
    expect(readFileSync(fixture.path, 'utf8')).toBe('{invalid')
  })
  it('surfaces write failures', () => {
    const fixture = store()
    const unwritable = new TaxProfileStore(join(fixture.path, 'missing', 'profile.json'))
    expect(() => unwritable.save(personal)).toThrow()
    expect(fixture.store.get()).toBeNull()
  })
})
