import { describe, expect, it } from 'vitest'
import type { TaxProfile } from '../../shared/tax-profile'
import { changeTaxScope, type TaxScope } from '../../shared/tax-scope'
import {
  allowsForfettario,
  newSetupDraft,
  readSetupDraft,
  setupDraftKey,
  setupProfile,
  setupStepError
} from './tax-setup-flow'

const legacy: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2025,
  userType: 'personal',
  personalRegime: 'amministrato',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'incomplete'
}

describe('guided personal and business setup', () => {
  it('requires a personal/business choice and location before moving beyond those steps', () => {
    const draft = newSetupDraft(null, 2026)
    expect(draft.taxYear).toBe(2026)
    expect(draft.recordsCoverage).toBe('unknown')
    expect(setupStepError(draft, 0)).toContain('Choose Personal')
    draft.userType = 'personal'
    expect(setupStepError(draft, 0)).toBeNull()
    expect(setupStepError(draft, 1)).toContain('name')
    draft.label = '   '
    expect(setupStepError(draft, 1)).toContain('name')
    draft.label = 'Personal review'
    expect(setupStepError(draft, 1)).toContain('residence')
    draft.country = 'IT'
    expect(setupStepError(draft, 1)).toBeNull()
  })

  it('allows unsure answers without inventing a tax regime or record completeness', () => {
    const draft = {
      ...newSetupDraft(null, 2026),
      country: 'IT' as const,
      userType: 'business' as const
    }
    expect(setupProfile(draft, 2026)).toMatchObject({
      businessType: 'unknown',
      businessRegime: 'unknown',
      personalRegime: null,
      recordsCoverage: 'unknown'
    })
  })

  it('keeps personal and business answers separate in the saved profile', () => {
    const draft = {
      ...newSetupDraft(legacy),
      userType: 'business' as const,
      businessType: 'company' as const,
      businessRegime: 'ordinary' as const
    }
    expect(setupProfile(draft, 2026).personalRegime).toBeNull()
    expect(setupProfile({ ...draft, userType: 'personal' }, 2026)).toMatchObject({
      personalRegime: 'amministrato',
      businessType: null,
      businessRegime: null
    })
  })

  it.each(['sole-trader', 'professional'])(
    'offers forfettario for %s only as a declaration',
    (kind) => {
      expect(allowsForfettario(kind)).toBe(true)
      const draft = {
        ...newSetupDraft(null, 2026),
        country: 'IT' as const,
        userType: 'business' as const,
        businessType: kind as 'sole-trader' | 'professional',
        businessRegime: 'forfettario' as const
      }
      expect(setupProfile(draft, 2026).businessRegime).toBe('forfettario')
    }
  )

  it.each(['company', 'partnership', 'unknown'])('rejects forfettario for %s', (kind) => {
    expect(allowsForfettario(kind)).toBe(false)
    expect(() =>
      setupProfile(
        {
          ...newSetupDraft(null, 2026),
          country: 'IT',
          userType: 'business',
          businessType: kind as 'company',
          businessRegime: 'forfettario'
        },
        2026
      )
    ).toThrow('Forfettario')
  })

  it('copies legacy answers without changing the standalone profile or marking history complete', () => {
    const before = structuredClone(legacy)
    const draft = newSetupDraft(legacy)
    expect(draft).toMatchObject({
      step: 1,
      reusedLegacy: true,
      label: '',
      recordsCoverage: 'incomplete'
    })
    draft.country = 'other'
    draft.personalRegime = 'unknown'
    expect(legacy).toEqual(before)
  })
})

describe('local setup drafts', () => {
  it('restores each step with answers and permits a safe incomplete first visit', () => {
    expect(readSetupDraft(JSON.stringify(newSetupDraft(null, 2026)), 2026)).toEqual(
      newSetupDraft(null, 2026)
    )
    for (let step = 0; step < 5; step++) {
      const draft = { ...newSetupDraft(legacy), step, label: 'Annual review' }
      expect(readSetupDraft(JSON.stringify(draft), 2026)).toEqual(draft)
    }
  })

  it('returns an incomplete restored draft to its first unanswered step', () => {
    const draft = { ...newSetupDraft(null, 2026), step: 4 }
    expect(readSetupDraft(JSON.stringify(draft), 2026)?.step).toBe(0)
    draft.userType = 'personal'
    expect(readSetupDraft(JSON.stringify(draft), 2026)?.step).toBe(1)
  })

  it('does not restore stale forfettario after the business form has changed', () => {
    const draft = {
      ...newSetupDraft(legacy),
      userType: 'business',
      businessType: 'company',
      businessRegime: 'forfettario'
    }
    expect(readSetupDraft(JSON.stringify(draft), 2026)?.businessRegime).toBe('unknown')
    draft.businessRegime = 'ordinary'
    expect(readSetupDraft(JSON.stringify(draft), 2026)?.businessRegime).toBe('ordinary')
  })

  it.each([
    null,
    '',
    '{broken',
    'null',
    '[]',
    '"value"',
    JSON.stringify({ ...newSetupDraft(legacy), version: 2 }),
    JSON.stringify({ ...newSetupDraft(legacy), step: 5 }),
    JSON.stringify({ ...newSetupDraft(legacy), step: -1 }),
    JSON.stringify({ ...newSetupDraft(legacy), step: 1.5 }),
    JSON.stringify({ ...newSetupDraft(legacy), label: 'x'.repeat(201) }),
    JSON.stringify({ ...newSetupDraft(legacy), taxYear: 2027 }),
    JSON.stringify({ ...newSetupDraft(legacy), taxYear: '2026' }),
    JSON.stringify({ ...newSetupDraft(legacy), country: 'invalid' }),
    JSON.stringify({ ...newSetupDraft(legacy), personalRegime: 'invalid' }),
    JSON.stringify({ ...newSetupDraft(legacy), businessType: 'invalid' }),
    JSON.stringify({ ...newSetupDraft(legacy), businessRegime: 'invalid' }),
    JSON.stringify({ ...newSetupDraft(legacy), recordsCoverage: 'invalid' })
  ])('ignores corrupt or incompatible stored draft %s', (raw) => {
    expect(readSetupDraft(raw, 2026)).toBeNull()
  })

  it('does not copy arbitrary data from local storage into the restored profile', () => {
    const raw = JSON.stringify({
      ...newSetupDraft(legacy),
      label: 'Annual review',
      taxRate: 0,
      walletKey: 'never-used'
    })
    const restored = readSetupDraft(raw, 2026)!
    expect(restored).not.toHaveProperty('taxRate')
    expect(restored).not.toHaveProperty('walletKey')
    expect(setupProfile(restored, 2026)).toEqual(legacy)
  })

  it('isolates draft keys between database sources', () => {
    expect(setupDraftKey('/data/kasa.db')).not.toBe(setupDraftKey('/data/kasa-wdk.db'))
    expect(setupDraftKey('/data/kasa.db')).toBe(setupDraftKey('/data/kasa.db'))
  })
})

describe('compatibility with existing saved data', () => {
  it('adds the new annual profile without merging, assigning or replacing existing records', () => {
    const scope: TaxScope = {
      version: 1,
      databaseId: 'existing-db',
      activeTaxpayerId: 'old',
      taxpayers: [{ id: 'old', label: 'Saved taxpayer', profile: legacy }],
      accounts: [
        {
          id: 'account',
          taxpayerId: 'old',
          label: 'Saved account',
          ownershipBps: 5000,
          kind: 'unknown'
        }
      ],
      assets: [
        {
          id: 'asset',
          symbol: 'BTC',
          canonicalId: 'bitcoin',
          network: 'mainnet',
          decimals: 8,
          environment: 'live'
        }
      ],
      assignments: [{ recordKey: 'payment:1', accountId: 'account', assetId: 'asset' }]
    }
    const before = structuredClone(scope)
    const profile = setupProfile(
      { ...newSetupDraft(legacy), label: 'New review', taxYear: 2026 },
      2026
    )
    const next = changeTaxScope(
      scope,
      { kind: 'create-profile', label: 'New review', profile },
      legacy,
      new Set(['payment:1']),
      'new'
    )
    expect(scope).toEqual(before)
    expect(next.taxpayers).toEqual([
      ...before.taxpayers,
      { id: 'new', label: 'New review', profile }
    ])
    expect(next.accounts).toEqual(before.accounts)
    expect(next.assets).toEqual(before.assets)
    expect(next.assignments).toEqual(before.assignments)
    expect(next.activeTaxpayerId).toBe('new')
  })
})
