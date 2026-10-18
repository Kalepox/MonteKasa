import { describe, expect, it } from 'vitest'
import { appProfileLabel, readLegacyAppProfile, validateAppProfileFields } from './app-profile'

const fields = {
  name: 'Person',
  email: '',
  company: 'Company',
  taxId: '',
  address: '',
  currency: 'EUR' as const
}

describe('app profile identity data', () => {
  it('validates and trims known display fields without treating them as tax or ownership verification', () => {
    expect(validateAppProfileFields({ ...fields, name: ' Person ', extra: 'discard' })).toEqual(
      fields
    )
    expect(appProfileLabel(fields, 'personal')).toBe('Person')
    expect(appProfileLabel(fields, 'business')).toBe('Company')
    expect(appProfileLabel({ ...fields, company: '' }, 'business')).toBe('Person')
  })
  it.each([
    null,
    [],
    { ...fields, name: '', company: '' },
    { ...fields, name: 'x'.repeat(201) },
    { ...fields, email: 'x'.repeat(255) },
    { ...fields, taxId: 'x'.repeat(81) },
    { ...fields, address: 'x'.repeat(2001) },
    { ...fields, currency: 'XYZ' }
  ])('rejects invalid identity input %#', (input) => {
    expect(() => validateAppProfileFields(input)).toThrow()
  })
  it('imports only actually saved legacy keys and never uses examples, unrelated fields or an identity inferred from a name', () => {
    expect(
      readLegacyAppProfile(
        JSON.stringify({
          'prof-name': 'Saved Person',
          'prof-co': 'Saved Company',
          'prof-email': 'saved@example.test',
          currency: 'BTC',
          taxpayerId: 'invented'
        })
      )
    ).toEqual({
      name: 'Saved Person',
      company: 'Saved Company',
      email: 'saved@example.test',
      taxId: '',
      address: '',
      currency: 'USDT'
    })
  })
  it.each([
    null,
    '',
    '{broken',
    '{}',
    '[]',
    '{"name":"Not a saved profile"}',
    '{"prof-name":123}',
    JSON.stringify({ 'prof-name': 'x'.repeat(201) })
  ])('does not import absent or malformed legacy data %#', (input) => {
    expect(readLegacyAppProfile(input)).toBeNull()
  })
})
