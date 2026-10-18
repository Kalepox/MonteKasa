export type TaxProfile = {
  version: 1
  country: 'IT' | 'other'
  taxYear: number
  userType: 'personal' | 'business'
  personalRegime: 'dichiarativo' | 'amministrato' | 'unknown' | null
  businessType: 'company' | 'partnership' | 'sole-trader' | 'professional' | 'unknown' | null
  businessRegime: 'ordinary' | 'forfettario' | 'unknown' | null
  recordsCoverage: 'complete' | 'incomplete' | 'unknown'
}

export interface TaxProfileAPI {
  get(): Promise<TaxProfile | null>
  save(profile: TaxProfile): Promise<TaxProfile>
}

export function currentTaxYear(): number {
  return Number(
    new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Europe/Rome' }).format(new Date())
  )
}

// Validate at the IPC boundary too. Only recognized fields are persisted.
export function validateTaxProfile(input: unknown, year = currentTaxYear()): TaxProfile {
  if (!input || typeof input !== 'object') throw new Error('Enter a tax profile.')
  const p = input as Record<string, unknown>
  const choice = (value: unknown, choices: string[], label: string): string => {
    if (typeof value !== 'string' || !choices.includes(value)) throw new Error(`Select ${label}.`)
    return value
  }
  if (p.version !== 1) throw new Error('Unsupported tax profile version.')
  choice(p.country, ['IT', 'other'], 'a tax country')
  if (!Number.isInteger(p.taxYear) || Number(p.taxYear) < 2023 || Number(p.taxYear) > year)
    throw new Error(`Select a tax year from 2023 to ${year}.`)
  choice(p.userType, ['personal', 'business'], 'personal or business use')
  choice(p.recordsCoverage, ['complete', 'incomplete', 'unknown'], 'record coverage')
  if (p.userType === 'personal') {
    choice(p.personalRegime, ['dichiarativo', 'amministrato', 'unknown'], 'a personal tax regime')
  } else {
    choice(
      p.businessType,
      ['company', 'partnership', 'sole-trader', 'professional', 'unknown'],
      'a business type'
    )
    choice(p.businessRegime, ['ordinary', 'forfettario', 'unknown'], 'a business tax regime')
    if (
      p.businessRegime === 'forfettario' &&
      !['sole-trader', 'professional'].includes(String(p.businessType))
    )
      throw new Error('Forfettario is only selectable for sole traders and professionals.')
  }
  return {
    version: 1,
    country: p.country as TaxProfile['country'],
    taxYear: Number(p.taxYear),
    userType: p.userType as TaxProfile['userType'],
    personalRegime:
      p.userType === 'personal' ? (p.personalRegime as TaxProfile['personalRegime']) : null,
    businessType: p.userType === 'business' ? (p.businessType as TaxProfile['businessType']) : null,
    businessRegime:
      p.userType === 'business' ? (p.businessRegime as TaxProfile['businessRegime']) : null,
    recordsCoverage: p.recordsCoverage as TaxProfile['recordsCoverage']
  }
}

export function taxProfileNotes(profile: TaxProfile): string[] {
  const notes = [
    'Profile saved on this device. Reports use the selected saved profile’s assignments and tax year; undated records remain separate for review. A limited personal Bitcoin disposal estimate is available when its required evidence is recorded. A separate entire-database export covers all profiles and dates.'
  ]
  if (profile.country === 'other')
    notes.push(
      'Only Italy is planned for the first tax rules. Other countries need professional review.'
    )
  if (profile.personalRegime === 'unknown' || profile.businessRegime === 'unknown')
    notes.push('Your tax regime still needs to be confirmed.')
  if (profile.businessType === 'unknown')
    notes.push('Your business type still needs to be confirmed.')
  if (profile.businessRegime === 'forfettario')
    notes.push('Forfettario eligibility has not been verified.')
  notes.push(
    profile.recordsCoverage === 'complete'
      ? 'You marked your records complete; this has not been independently verified.'
      : 'Records from other wallets or exchanges may be missing.'
  )
  return notes
}
