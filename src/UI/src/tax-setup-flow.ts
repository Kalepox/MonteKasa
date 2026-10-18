import { currentTaxYear, validateTaxProfile, type TaxProfile } from '../../shared/tax-profile'

export const setupSteps = [
  'Who is this for?',
  'Where and when?',
  'Your tax details',
  'Your app activity',
  'Review your profile'
] as const

// A draft is separate from saved taxpayer data. It can contain unanswered questions.
export type TaxSetupDraft = {
  version: 1
  step: number
  label: string
  country: TaxProfile['country'] | ''
  taxYear: number
  userType: TaxProfile['userType'] | ''
  personalRegime: NonNullable<TaxProfile['personalRegime']>
  businessType: NonNullable<TaxProfile['businessType']>
  businessRegime: NonNullable<TaxProfile['businessRegime']>
  recordsCoverage: TaxProfile['recordsCoverage']
  reusedLegacy: boolean
}

export function newSetupDraft(
  previous: TaxProfile | null = null,
  year = currentTaxYear()
): TaxSetupDraft {
  return {
    version: 1,
    step: previous ? 1 : 0,
    label: '',
    country: previous?.country ?? '',
    taxYear: previous?.taxYear ?? year,
    userType: previous?.userType ?? '',
    personalRegime: previous?.personalRegime ?? 'unknown',
    businessType: previous?.businessType ?? 'unknown',
    businessRegime: previous?.businessRegime ?? 'unknown',
    recordsCoverage: previous?.recordsCoverage ?? 'unknown',
    reusedLegacy: Boolean(previous)
  }
}

export function allowsForfettario(businessType: string): boolean {
  return ['sole-trader', 'professional'].includes(businessType)
}

export function setupProfile(draft: TaxSetupDraft, year = currentTaxYear()): TaxProfile {
  return validateTaxProfile(draft, year)
}

export function setupDraftKey(databaseId: string, appProfileId?: string): string {
  const databaseKey = `kasa:commercialista-setup:v1:${encodeURIComponent(databaseId)}`
  return appProfileId === undefined
    ? databaseKey
    : `${databaseKey}:app:${encodeURIComponent(appProfileId)}`
}

export function setupStepError(draft: TaxSetupDraft, step: number): string | null {
  if (step === 0 && !draft.userType) return 'Choose Personal or Business / professional.'
  if (step === 1) {
    if (!draft.label.trim()) return 'Enter a profile name so you can recognise it later.'
    if (draft.label.length > 200) return 'Use a profile name with no more than 200 characters.'
    if (!draft.country) return 'Choose the country of tax residence.'
  }
  return null
}

// localStorage is untrusted and can outlive an app update. Restore only known fields.
export function readSetupDraft(raw: string | null, year = currentTaxYear()): TaxSetupDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || value.version !== 1 || typeof value.label !== 'string') return null
    if (value.label.length > 200 || typeof value.reusedLegacy !== 'boolean') return null
    if (!Number.isInteger(value.step) || value.step < 0 || value.step >= setupSteps.length)
      return null
    if (!['', 'IT', 'other'].includes(value.country)) return null
    if (!['', 'personal', 'business'].includes(value.userType)) return null
    if (!['unknown', 'dichiarativo', 'amministrato'].includes(value.personalRegime)) return null
    if (
      !['unknown', 'company', 'partnership', 'sole-trader', 'professional'].includes(
        value.businessType
      )
    )
      return null
    if (!['unknown', 'ordinary', 'forfettario'].includes(value.businessRegime)) return null
    if (!['unknown', 'complete', 'incomplete'].includes(value.recordsCoverage)) return null
    if (!Number.isInteger(value.taxYear) || value.taxYear < 2023 || value.taxYear > year)
      return null
    const draft: TaxSetupDraft = {
      version: 1,
      step: value.step,
      label: value.label,
      country: value.country,
      taxYear: value.taxYear,
      userType: value.userType,
      personalRegime: value.personalRegime,
      businessType: value.businessType,
      businessRegime:
        value.businessRegime === 'forfettario' && !allowsForfettario(value.businessType)
          ? 'unknown'
          : value.businessRegime,
      recordsCoverage: value.recordsCoverage,
      reusedLegacy: value.reusedLegacy
    }
    for (let step = 0; step < draft.step; step++) {
      if (setupStepError(draft, step)) {
        draft.step = step
        break
      }
    }
    return draft
  } catch {
    return null
  }
}
