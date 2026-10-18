import type { TaxProfile } from './tax-profile'
import type { TaxScope } from './tax-scope'

export type AppProfileFields = {
  name: string
  email: string
  company: string
  taxId: string
  address: string
  currency: 'USDT' | 'EUR' | 'BTC'
}
export type AppProfile = AppProfileFields & { id: string; taxpayerId: string | null }
export type AppProfileState = {
  databaseId: string
  profiles: AppProfile[]
  activeProfileId: string | null
  scope: TaxScope
  legacyImported: boolean
}
export type AppProfileCommand =
  | { kind: 'create'; fields: AppProfileFields; requestId: string }
  | { kind: 'update'; profileId: string; fields: AppProfileFields }
  | { kind: 'select'; profileId: string }
  | { kind: 'import-legacy'; fields: AppProfileFields }
  | { kind: 'link-taxpayer'; profileId: string; taxpayerId: string }
  | { kind: 'save-tax'; profileId: string; profile: TaxProfile }
  | { kind: 'select-tax-year'; profileId: string; taxYear: number }
export interface AppProfilesAPI {
  get(): Promise<AppProfileState>
  change(command: AppProfileCommand): Promise<AppProfileState>
}
export type AppProfileAPI = AppProfilesAPI

export function validateAppProfileFields(value: unknown): AppProfileFields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Enter valid app profile details.')
  const fields = value as Record<string, unknown>
  const read = (key: string, maximum: number): string => {
    const input = fields[key]
    if (typeof input !== 'string' || input.length > maximum)
      throw new Error(`Enter ${key} using at most ${maximum} characters.`)
    return input.trim()
  }
  const result: AppProfileFields = {
    name: read('name', 200),
    email: read('email', 254),
    company: read('company', 200),
    taxId: read('taxId', 80),
    address: read('address', 2000),
    currency: fields.currency as AppProfileFields['currency']
  }
  if (!result.name && !result.company)
    throw new Error('Enter a name or company name for this profile.')
  if (!['USDT', 'EUR', 'BTC'].includes(result.currency))
    throw new Error('Choose a supported display currency.')
  return result
}

export function appProfileLabel(
  profile: AppProfileFields,
  userType?: 'personal' | 'business'
): string {
  return userType === 'business' ? profile.company || profile.name : profile.name || profile.company
}

// Import only values the user previously saved. Presentation defaults in HTML
// are not identity evidence and must never become persisted app profiles.
export function readLegacyAppProfile(raw: string | null): AppProfileFields | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const read = (key: string): unknown => (Object.hasOwn(value, key) ? value[key] : '')
    return validateAppProfileFields({
      name: read('prof-name'),
      email: read('prof-email'),
      company: read('prof-co'),
      taxId: read('prof-vat'),
      address: read('prof-addr'),
      currency: 'USDT'
    })
  } catch {
    return null
  }
}
