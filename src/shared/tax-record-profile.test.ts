import { describe, expect, it } from 'vitest'
import type { KasaSnapshot } from '../preload/index.d'
import { recordTaxpayerId } from './tax-record-profile'
import {
  calculationCompleteness,
  changeTaxScope,
  recordKeys,
  scopedRecords,
  validateTaxScope,
  type TaxScope
} from './tax-scope'

function fixture(): TaxScope {
  const profile = {
    version: 1 as const,
    country: 'IT',
    taxYear: 2026,
    userType: 'personal' as const,
    personalRegime: 'dichiarativo' as const,
    businessType: null,
    businessRegime: null,
    recordsCoverage: 'unknown' as const
  }
  return {
    version: 1,
    databaseId: 'fixture',
    activeTaxpayerId: 'selected',
    taxpayers: [
      { id: 'selected', label: 'Selected', profile },
      { id: 'other', label: 'Other', profile }
    ],
    accounts: [
      {
        id: 'account',
        taxpayerId: 'selected',
        label: 'Account',
        ownershipBps: null,
        kind: 'unknown'
      },
      {
        id: 'other-account',
        taxpayerId: 'other',
        label: 'Other account',
        ownershipBps: 10000,
        kind: 'provider'
      }
    ],
    assets: [
      {
        id: 'asset',
        symbol: 'BTC',
        canonicalId: 'btc',
        network: 'bitcoin',
        decimals: 8,
        environment: 'test'
      }
    ],
    assignments: []
  }
}
const snapshot: KasaSnapshot = {
  invoices: [
    {
      id: 'request',
      client: 'Fixture',
      amount: 1,
      received: 1,
      state: 'Paid',
      createdAt: 1,
      expiresAt: 2,
      rgbInvoice: 'fixture',
      recipientId: 'fixture'
    }
  ],
  payments: [1, 2].map((nodeIdx) => ({
    nodeIdx,
    direction: 'in',
    invoiceId: 'request',
    received: 1,
    status: 'settled',
    txid: `fixture-${nodeIdx}`,
    blockTime: null
  })),
  proposals: []
}
const records = recordKeys(snapshot)
const command = { kind: 'link-records', taxpayerId: 'selected', recordKeys: [...records] }
const link = (state: TaxScope = fixture(), input: unknown = command): TaxScope =>
  changeTaxScope(state, input, null, records, '')

describe('database record profile relationships', () => {
  it('links legacy records without inventing account, asset, ownership or enrichment data', () => {
    const original = fixture()
    const before = structuredClone(original)
    const saved = link(original)
    expect(original).toEqual(before)
    expect(saved).toEqual({
      ...before,
      recordProfiles: [...records].map((recordKey) => ({ recordKey, taxpayerId: 'selected' }))
    })
    expect(scopedRecords(saved, snapshot, 'selected')).toEqual(snapshot)
    expect(scopedRecords(saved, snapshot, 'other').payments).toEqual([])
    expect(recordTaxpayerId(saved, 'payment:1')).toBe('selected')
  })

  it('does not claim linked records belong to a specific account or asset', () => {
    const saved = link()
    expect(scopedRecords(saved, snapshot, 'selected', 'account').payments).toEqual([])
    expect(scopedRecords(saved, snapshot, 'selected', '', 'asset').payments).toEqual([])
    expect(calculationCompleteness(saved, snapshot, 'selected')[0].missing.join(' ')).toContain(
      'without account and asset details'
    )
  })

  it('is idempotent and skips an existing same-profile account assignment', () => {
    const original = fixture()
    original.assignments = [{ recordKey: 'payment:1', accountId: 'account', assetId: 'asset' }]
    const saved = link(original)
    expect(saved.recordProfiles?.map((entry) => entry.recordKey)).toEqual([
      'invoice:request',
      'payment:2'
    ])
    expect(link(saved)).toEqual(saved)
    expect(scopedRecords(saved, snapshot, 'selected').payments).toHaveLength(2)
    expect(scopedRecords(saved, snapshot, 'selected', 'account').payments).toHaveLength(1)
  })

  it('preserves manually excluded records and unrelated evidence when explicitly linking them', () => {
    const original = fixture()
    original.autoAssignmentExclusions = ['payment:1']
    original.preparationAnswers = [
      {
        taxpayerId: 'selected',
        taxYear: 2026,
        questionId: 'acquisition-history',
        status: 'unknown',
        reference: '',
        notes: 'Keep this answer'
      }
    ]
    original.enrichments = []
    original.disposalBases = []
    const saved = link(original)
    expect(saved.autoAssignmentExclusions).toEqual(original.autoAssignmentExclusions)
    expect(saved.preparationAnswers).toEqual(original.preparationAnswers)
    expect(saved.enrichments).toEqual(original.enrichments)
    expect(saved.disposalBases).toEqual(original.disposalBases)
  })

  it.each(['assignment', 'relationship'])(
    'rejects the whole selection when another profile has an existing %s',
    (kind) => {
      const original = fixture()
      if (kind === 'assignment')
        original.assignments.push({
          recordKey: 'payment:2',
          accountId: 'other-account',
          assetId: 'asset'
        })
      else original.recordProfiles = [{ recordKey: 'payment:2', taxpayerId: 'other' }]
      const before = structuredClone(original)
      expect(() => link(original)).toThrow('another profile')
      expect(original).toEqual(before)
    }
  )

  it.each([
    { ...command, taxpayerId: 'other' },
    { ...command, taxpayerId: 'missing' },
    { ...command, recordKeys: [] },
    { ...command, recordKeys: ['payment:1', 'payment:1'] },
    { ...command, recordKeys: ['payment:1', 'payment:missing'] },
    { ...command, recordKeys: ['proposal:1'] },
    { ...command, recordKeys: [null] },
    { ...command, recordKeys: 'payment:1' }
  ])('rejects invalid or stale request %# without changing the scope', (input) => {
    const original = fixture()
    expect(() => link(original, input)).toThrow()
    expect(original.recordProfiles).toBeUndefined()
  })

  it('removes the relationship when an explicit assignment becomes authoritative', () => {
    const saved = changeTaxScope(
      link(),
      { kind: 'assign', recordKey: 'payment:1', accountId: 'other-account', assetId: 'asset' },
      null,
      records,
      ''
    )
    expect(saved.recordProfiles?.some((entry) => entry.recordKey === 'payment:1')).toBe(false)
    expect(recordTaxpayerId(saved, 'payment:1')).toBe('other')
    expect(scopedRecords(saved, snapshot, 'selected').payments).toHaveLength(1)
  })

  it('removes the relationship on unassign and retains the automatic-assignment exclusion', () => {
    const saved = changeTaxScope(
      link(),
      { kind: 'unassign', recordKey: 'payment:1' },
      null,
      records,
      ''
    )
    expect(recordTaxpayerId(saved, 'payment:1')).toBeUndefined()
    expect(saved.autoAssignmentExclusions).toContain('payment:1')
    expect(saved.recordProfiles).toHaveLength(2)
  })

  it('prefers an existing assigned owner and ignores invalid profile identities', () => {
    const saved = link()
    saved.assignments.push({ recordKey: 'payment:1', accountId: 'other-account', assetId: 'asset' })
    expect(recordTaxpayerId(saved, 'payment:1')).toBe('other')
    expect(scopedRecords(saved, snapshot, 'selected').payments).toHaveLength(1)
    saved.assignments[0].accountId = 'missing'
    expect(recordTaxpayerId(saved, 'payment:1')).toBe('selected')
    saved.recordProfiles![1].taxpayerId = 'missing'
    expect(recordTaxpayerId(saved, 'payment:1')).toBeUndefined()
  })

  it('roundtrips relationships including missing ledger records and preserves old field absence', () => {
    const original = fixture()
    expect(validateTaxScope(original, original.databaseId)).not.toHaveProperty('recordProfiles')
    const saved = link()
    saved.recordProfiles!.push({ recordKey: 'payment:orphan', taxpayerId: 'selected' })
    expect(validateTaxScope(saved, saved.databaseId).recordProfiles).toEqual(saved.recordProfiles)
    expect(scopedRecords(saved, snapshot, 'selected').payments).toHaveLength(2)
  })

  it.each([
    [{ recordKey: 'payment:1', taxpayerId: 'missing' }],
    [
      { recordKey: 'payment:1', taxpayerId: 'selected' },
      { recordKey: 'payment:1', taxpayerId: 'selected' }
    ],
    [{ recordKey: 'proposal:1', taxpayerId: 'selected' }],
    [null],
    'invalid'
  ])('rejects malformed persisted relationships %#', (recordProfiles) => {
    expect(() => validateTaxScope({ ...fixture(), recordProfiles }, 'fixture')).toThrow()
  })

  it('rejects persisted relationships that conflict with a saved account owner', () => {
    const saved = link()
    saved.assignments.push({ recordKey: 'payment:1', accountId: 'other-account', assetId: 'asset' })
    expect(() => validateTaxScope(saved, 'fixture')).toThrow('another profile')
  })
})
