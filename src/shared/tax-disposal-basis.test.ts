import { describe, expect, it } from 'vitest'
import { emptyValuation } from './tax-enrichment'
import { currentTaxYear, type TaxProfile } from './tax-profile'
import { changeTaxScope, validateTaxScope, type TaxScope } from './tax-scope'
import {
  disposalBasisKey,
  validateDisposalBasis,
  type TaxDisposalBasis
} from './tax-disposal-basis'

const personal: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'complete'
}
const assignment = { recordKey: 'payment:1', accountId: 'account', assetId: 'btc' }
function scope(): TaxScope {
  return {
    version: 1,
    databaseId: 'fixture-db',
    activeTaxpayerId: 'person',
    taxpayers: [
      { id: 'person', label: 'Fixture person', profile: { ...personal } },
      { id: 'another', label: 'Other fixture person', profile: { ...personal } }
    ],
    accounts: [
      {
        id: 'account',
        taxpayerId: 'person',
        label: 'Fixture account',
        ownershipBps: 10000,
        kind: 'unknown'
      },
      {
        id: 'other-account',
        taxpayerId: 'another',
        label: 'Other fixture account',
        ownershipBps: 10000,
        kind: 'unknown'
      }
    ],
    assets: [
      {
        id: 'btc',
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        decimals: 8,
        environment: 'live'
      }
    ],
    assignments: [{ ...assignment }],
    enrichments: [
      {
        ...assignment,
        classification: 'sale',
        valuation: {
          eur: '50',
          date: '2026-01-02',
          source: 'Fixture statement',
          reference: 'Document A'
        },
        fee: {
          status: 'none',
          amount: '',
          assetId: '',
          purpose: '',
          reference: '',
          valuation: emptyValuation()
        },
        relatedRecordKey: ''
      }
    ]
  }
}
const basis = (overrides: Partial<TaxDisposalBasis> = {}): TaxDisposalBasis => ({
  taxpayerId: 'person',
  taxYear: 2026,
  recordKey: 'payment:1',
  facts: '["saved fixture facts"]',
  transactionKind: 'fiat-sale',
  costBasisEur: '30.12345678',
  reference: 'Documented fixture cost allocation',
  reviewed: true,
  ...overrides
})
function save(state: TaxScope, input: unknown): TaxScope {
  return changeTaxScope(
    state,
    { kind: 'disposal-basis', basis: input },
    null,
    new Set(['payment:1']),
    ''
  )
}

describe('documented disposal cost validation', () => {
  it('keeps exact record facts and decimal precision while trimming user text', () => {
    const value = basis({
      facts: ' ["exact facts"] ',
      costBasisEur: ' 30.12345678 ',
      reference: '  Statement A  '
    })
    expect(validateDisposalBasis(value, scope(), new Set(['payment:1']))).toEqual({
      ...value,
      costBasisEur: '30.12345678',
      reference: 'Statement A'
    })
  })

  it.each(['0', '0.00000000', '999999999999999999.99999999'])(
    'accepts explicit exact EUR cost %s',
    (costBasisEur) => {
      expect(save(scope(), basis({ costBasisEur })).disposalBases?.[0].costBasisEur).toBe(
        costBasisEur
      )
    }
  )

  it('permits an unconfirmed evidence draft without changing preparation answers or history', () => {
    const state = scope()
    state.taxpayers[0].profile.recordsCoverage = 'incomplete'
    state.preparationAnswers = [
      {
        taxpayerId: 'person',
        taxYear: 2026,
        questionId: 'acquisition-history',
        status: 'available',
        reference: 'Statement A',
        notes: ''
      }
    ]
    const next = save(state, basis({ reviewed: false }))
    expect(next.disposalBases?.[0].reviewed).toBe(false)
    expect(next.preparationAnswers).toEqual(state.preparationAnswers)
    expect(next.taxpayers).toEqual(state.taxpayers)
  })

  it('supports reviewed spending when the saved payment purpose matches', () => {
    const state = scope()
    state.enrichments![0].classification = 'goods-services'
    expect(
      save(state, basis({ transactionKind: 'goods-services' })).disposalBases?.[0].transactionKind
    ).toBe('goods-services')
  })

  it('supports the saved 2025 profile year', () => {
    const state = scope()
    state.taxpayers[0].profile.taxYear = 2025
    expect(save(state, basis({ taxYear: 2025 })).disposalBases?.[0].taxYear).toBe(2025)
  })

  it.each([
    null,
    [],
    {},
    { taxpayerId: 'missing' },
    { taxYear: 2025 },
    { taxYear: 2024 },
    { taxYear: '2026' },
    { taxYear: 2026.5 },
    { taxYear: currentTaxYear() + 1 },
    { recordKey: 'invoice:1' },
    { recordKey: 'payment:' },
    { recordKey: 'payment:missing' },
    { facts: '' },
    { facts: '   ' },
    { facts: null },
    { facts: 'x'.repeat(20001) },
    { transactionKind: 'swap' },
    { transactionKind: 'goods-services' },
    { costBasisEur: '' },
    { costBasisEur: '-1' },
    { costBasisEur: '1e2' },
    { costBasisEur: '1.123456789' },
    { costBasisEur: '1000000000000000000' },
    { costBasisEur: '01' },
    { costBasisEur: 30 },
    { costBasisEur: '1,20' },
    { reference: '' },
    { reference: '   ' },
    { reference: 'x'.repeat(501) },
    { reviewed: 'true' },
    { reviewed: null }
  ])('rejects invalid or stale inputs without mutating the scope: %j', (invalid) => {
    const state = scope()
    const before = structuredClone(state)
    const input =
      invalid && !Array.isArray(invalid) && Object.keys(invalid).length
        ? { ...basis(), ...invalid }
        : invalid
    expect(() => save(state, input)).toThrow()
    expect(state).toEqual(before)
  })

  it.each([
    { country: 'other' },
    { userType: 'business' },
    { personalRegime: 'amministrato' },
    { personalRegime: 'unknown' }
  ])('rejects unsupported profile settings: %j', (patch) => {
    const state = scope()
    Object.assign(state.taxpayers[0].profile, patch)
    expect(() => save(state, basis())).toThrow('supported saved profile')
  })

  it.each(['another', undefined])(
    'rejects a save after selected taxpayer changes to %s',
    (activeTaxpayerId) => {
      expect(() => save({ ...scope(), activeTaxpayerId }, basis())).toThrow(
        'selected profile changed'
      )
    }
  )

  it('requires a current payment assigned to the taxpayer and a valid matching enrichment', () => {
    const variants: TaxScope[] = []
    const missingRecord = scope()
    expect(() => validateDisposalBasis(basis(), missingRecord, new Set())).toThrow(
      'existing payment'
    )
    const unassigned = scope()
    unassigned.assignments = []
    variants.push(unassigned)
    const foreign = scope()
    foreign.assignments[0].accountId = 'other-account'
    variants.push(foreign)
    const missingAccount = scope()
    missingAccount.accounts = []
    variants.push(missingAccount)
    const missingAsset = scope()
    missingAsset.assets = []
    variants.push(missingAsset)
    const noEnrichment = scope()
    noEnrichment.enrichments = []
    variants.push(noEnrichment)
    const staleEnrichment = scope()
    staleEnrichment.enrichments![0].assetId = 'old-asset'
    variants.push(staleEnrichment)
    const staleAccount = scope()
    staleAccount.enrichments![0].accountId = 'other-account'
    variants.push(staleAccount)
    for (const state of variants) expect(() => save(state, basis())).toThrow()
  })
})

describe('disposal cost evidence preservation', () => {
  it('upserts only the matching taxpayer, year and payment and preserves existing data', () => {
    const state = scope()
    state.disposalBases = [
      basis(),
      basis({ taxYear: 2025 }),
      basis({ taxpayerId: 'another' }),
      basis({ recordKey: 'payment:2' })
    ]
    const before = structuredClone(state)
    const revised = basis({ costBasisEur: '35', reviewed: false })
    const next = save(state, revised)
    expect(next.disposalBases).toEqual([...state.disposalBases.slice(1), revised])
    expect(disposalBasisKey(revised)).toBe(JSON.stringify(['person', 2026, 'payment:1']))
    expect({ ...next, disposalBases: undefined }).toEqual({ ...state, disposalBases: undefined })
    expect(state).toEqual(before)
    next.disposalBases![0].reference = 'Changed copy'
    expect(state).toEqual(before)
  })

  it('reads legacy files with no migration or new optional field', () => {
    const original = scope()
    expect(validateTaxScope(original, original.databaseId)).toEqual(original)
    expect(validateTaxScope(original, original.databaseId)).not.toHaveProperty('disposalBases')
    expect(
      validateTaxScope({ ...original, disposalBases: [] }, original.databaseId).disposalBases
    ).toEqual([])
  })

  it('retains historical and obsolete evidence after a profile or assignment changes', () => {
    const state = scope()
    state.disposalBases = [basis(), basis({ taxYear: 2025 })]
    state.taxpayers[0].profile = { ...personal, country: 'other', taxYear: 2025 }
    state.assignments = []
    delete state.enrichments
    expect(validateTaxScope(state, state.databaseId)).toEqual(state)
  })

  it('retains evidence on unassignment or reassignment while existing enrichment invalidation still works', () => {
    const state = scope()
    state.disposalBases = [basis()]
    for (const command of [
      { kind: 'unassign', recordKey: 'payment:1' },
      { kind: 'assign', recordKey: 'payment:1', accountId: 'other-account', assetId: 'btc' }
    ]) {
      const next = changeTaxScope(state, command, null, new Set(['payment:1']), '')
      expect(next.disposalBases).toEqual(state.disposalBases)
      expect(next.enrichments).toEqual([])
      expect(validateTaxScope(next, next.databaseId).disposalBases).toEqual(state.disposalBases)
    }
  })

  it.each([null, {}, [null], [basis(), basis()], [basis({ taxpayerId: 'missing' })]])(
    'rejects corrupted or duplicate stored evidence: %j',
    (disposalBases) => {
      const original = scope()
      expect(() => validateTaxScope({ ...original, disposalBases }, original.databaseId)).toThrow()
    }
  )
})
