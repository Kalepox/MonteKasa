import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxScopeStore } from './tax-scope'
import {
  changeTaxScope,
  scopedRecords,
  calculationCompleteness,
  validateTaxScope,
  type TaxScope,
  type ScopeCommand
} from '../shared/tax-scope'
import type { TaxProfile } from '../shared/tax-profile'
import type { KasaSnapshot } from '../preload/index.d'
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
const business: TaxProfile = {
  ...personal,
  userType: 'business',
  personalRegime: null,
  businessType: 'company',
  businessRegime: 'ordinary'
}
const snapshot: KasaSnapshot = {
  invoices: [
    {
      id: 'one',
      client: 'Test',
      amount: 10,
      received: 10,
      state: 'Paid',
      createdAt: 1,
      expiresAt: 2,
      rgbInvoice: 'test',
      recipientId: 'test'
    }
  ],
  payments: [
    {
      nodeIdx: 1,
      invoiceId: 'one',
      direction: 'in',
      received: 10,
      status: 'settled',
      blockTime: null,
      txid: 'tx'
    }
  ],
  proposals: []
}
const records = new Set(['invoice:one', 'payment:1'])
const empty: TaxScope = {
  version: 1,
  databaseId: 'db-one',
  taxpayers: [],
  accounts: [],
  assets: [],
  assignments: []
}
function fixture(): TaxScope {
  let s = changeTaxScope(empty, { kind: 'taxpayer', label: 'Person' }, personal, records, 'person')
  s = changeTaxScope(s, { kind: 'taxpayer', label: 'Company' }, business, records, 'company')
  for (const id of ['person', 'company'])
    s = changeTaxScope(
      s,
      { kind: 'account', taxpayerId: id, label: id, ownershipBps: 10000, accountKind: 'unknown' },
      null,
      records,
      `${id}-account`
    )
  for (const id of ['live', 'test'])
    s = changeTaxScope(
      s,
      {
        kind: 'asset',
        symbol: 'USDT',
        canonicalId: `asset-${id}`,
        network: 'declared-network',
        decimals: 6,
        environment: id
      },
      null,
      records,
      id
    )
  return s
}
const directories: string[] = []
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true })
})
describe('tax scoping', () => {
  it('starts unassigned and never inherits linked invoice/payment ownership', () => {
    let s = fixture()
    expect(scopedRecords(s, snapshot, 'person').invoices).toHaveLength(0)
    s = changeTaxScope(
      s,
      { kind: 'assign', recordKey: 'invoice:one', accountId: 'person-account', assetId: 'live' },
      null,
      records,
      ''
    )
    expect(scopedRecords(s, snapshot, 'person').invoices).toHaveLength(1)
    expect(scopedRecords(s, snapshot, 'person').payments).toHaveLength(0)
    expect(scopedRecords(s, snapshot, 'company').invoices).toHaveLength(0)
    expect(scopedRecords(s, snapshot, 'person', 'company-account').invoices).toHaveLength(0)
    expect(scopedRecords(s, snapshot, 'person', '', 'test').invoices).toHaveLength(0)
  })
  it('allows explicit reassignment and removal without duplicate counting', () => {
    let s = fixture()
    for (const accountId of ['person-account', 'company-account'])
      s = changeTaxScope(
        s,
        { kind: 'assign', recordKey: 'payment:1', accountId, assetId: 'live' },
        null,
        records,
        ''
      )
    expect(s.assignments).toHaveLength(1)
    expect(scopedRecords(s, snapshot, 'person').payments).toHaveLength(0)
    expect(scopedRecords(s, snapshot, 'company').payments).toHaveLength(1)
    s = changeTaxScope(s, { kind: 'unassign', recordKey: 'payment:1' }, null, records, '')
    expect(s.assignments).toHaveLength(0)
  })
  it('preserves taxpayer profile snapshots when setup changes', () => {
    const original = structuredClone(personal)
    const s = changeTaxScope(empty, { kind: 'taxpayer', label: 'Me' }, original, records, 'person')
    original.userType = 'business'
    original.taxYear = 2025
    expect(s.taxpayers[0].profile).toEqual(personal)
  })
  it.each([
    {
      kind: 'account',
      taxpayerId: 'absent',
      label: 'x',
      ownershipBps: 10000,
      accountKind: 'unknown'
    },
    { kind: 'account', taxpayerId: 'person', label: 'x', ownershipBps: 0, accountKind: 'unknown' },
    {
      kind: 'account',
      taxpayerId: 'person',
      label: 'x',
      ownershipBps: 10001,
      accountKind: 'unknown'
    },
    { kind: 'assign', recordKey: 'payment:999', accountId: 'person-account', assetId: 'live' },
    { kind: 'assign', recordKey: 'invoice:one', accountId: 'missing', assetId: 'live' },
    { kind: 'assign', recordKey: 'invoice:one', accountId: 'person-account', assetId: 'missing' },
    {
      kind: 'asset',
      symbol: 'BTC',
      canonicalId: 'btc',
      network: '',
      decimals: 8,
      environment: 'live'
    },
    {
      kind: 'asset',
      symbol: 'BTC',
      canonicalId: 'btc',
      network: 'btc',
      decimals: 19,
      environment: 'live'
    }
  ])('rejects invalid scope command %j', (command) => {
    expect(() => changeTaxScope(fixture(), command, null, records, 'new')).toThrow()
  })
  it('keeps same ticker assets distinct by canonical ID/network and rejects duplicate identities', () => {
    expect(fixture().assets).toHaveLength(2)
    expect(() =>
      changeTaxScope(
        fixture(),
        {
          kind: 'asset',
          symbol: 'USDT',
          canonicalId: 'asset-live',
          network: 'declared-network',
          decimals: 6,
          environment: 'live'
        },
        null,
        records,
        'new'
      )
    ).toThrow('already declared')
  })
})
describe('calculation completeness', () => {
  it('does not treat a complete-history declaration as calculation readiness', () => {
    const report = calculationCompleteness(fixture(), snapshot, 'person')
    expect(report.find((r) => r.calculation === 'Personal gains and losses')?.status).toBe(
      'missing-data'
    )
    expect(report.find((r) => r.calculation === 'Business income')?.status).toBe('not-applicable')
    expect(JSON.stringify(report)).toContain('reconciliation')
    expect(JSON.stringify(report)).toContain('No database records')
  })
  it('reports test assets, missing dates and business-specific requirements', () => {
    const s = changeTaxScope(
      fixture(),
      { kind: 'assign', recordKey: 'payment:1', accountId: 'company-account', assetId: 'test' },
      null,
      records,
      ''
    )
    const report = calculationCompleteness(s, snapshot, 'company')
    expect(JSON.stringify(report)).toContain('Test assets are excluded')
    expect(JSON.stringify(report)).toContain('payment dates are missing')
    expect(report.find((r) => r.calculation === 'VAT')?.status).toBe('missing-data')
    expect(report.find((r) => r.calculation === 'Personal gains and losses')?.status).toBe(
      'not-applicable'
    )
  })
  it('supports forfettario requirements without declaring all VAT irrelevant', () => {
    const s = fixture()
    s.taxpayers[1].profile = {
      ...business,
      businessType: 'sole-trader',
      businessRegime: 'forfettario'
    }
    const report = calculationCompleteness(s, snapshot, 'company')
    expect(report.find((r) => r.calculation === 'Forfettario')?.status).toBe('missing-data')
    expect(report.find((r) => r.calculation === 'VAT')?.status).toBe('missing-data')
  })
  it('does not apply Italian calculations to an unsupported country or missing taxpayer', () => {
    const s = fixture()
    s.taxpayers[0].profile.country = 'other'
    expect(
      calculationCompleteness(s, snapshot, 'person').every((r) => r.status === 'unsupported')
    ).toBe(true)
    expect(calculationCompleteness(s, snapshot, '').every((r) => r.status === 'unsupported')).toBe(
      true
    )
  })
})
describe('scope persistence', () => {
  it('persists declarations and assignments across restart; rejects database changes and bad commands', () => {
    const d = mkdtempSync(join(tmpdir(), 'scope-test-'))
    directories.push(d)
    const path = join(d, 'scope.json')
    writeFileSync(path, JSON.stringify(fixture()))
    const store = new TaxScopeStore(path, 'db-one')
    const command: ScopeCommand = {
      kind: 'assign',
      recordKey: 'invoice:one',
      accountId: 'person-account',
      assetId: 'live'
    }
    store.change(command, null, records)
    expect(new TaxScopeStore(path, 'db-one').get().assignments).toHaveLength(1)
    expect(() => new TaxScopeStore(path, 'db-two').get()).toThrow('different database')
    const before = readFileSync(path, 'utf8')
    expect(() => store.change({ ...command, assetId: 'absent' }, null, records)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  it('rejects corrupt references but preserves orphaned record assignments for review', () => {
    const s = changeTaxScope(
      fixture(),
      { kind: 'assign', recordKey: 'payment:1', accountId: 'person-account', assetId: 'live' },
      null,
      records,
      ''
    )
    expect(validateTaxScope(s, 'db-one').assignments).toHaveLength(1)
    s.accounts = []
    expect(() => validateTaxScope(s, 'db-one')).toThrow()
    expect(() => validateTaxScope({ ...empty, taxpayers: [null] }, 'db-one')).toThrow()
  })
})

describe('unified profile creation', () => {
  it('creates and selects a profile atomically without changing existing declarations', () => {
    const original = fixture()
    const next = changeTaxScope(
      original,
      { kind: 'create-profile', label: ' My new profile ', profile: personal },
      null,
      records,
      'new'
    )
    expect(next.taxpayers).toEqual([
      ...original.taxpayers,
      { id: 'new', label: 'My new profile', profile: personal }
    ])
    expect(next.activeTaxpayerId).toBe('new')
    expect(next.accounts).toEqual(original.accounts)
    expect(next.assets).toEqual(original.assets)
    expect(next.assignments).toEqual(original.assignments)
    expect(original.activeTaxpayerId).toBeUndefined()
    expect(validateTaxScope(next, 'db-one')).toEqual(next)
  })
  it('supports unknown business type and keeps it on the completeness checklist', () => {
    const profile = { ...business, businessType: 'unknown', businessRegime: 'unknown' }
    const next = changeTaxScope(
      fixture(),
      { kind: 'create-profile', label: 'Business', profile },
      null,
      records,
      'unknown'
    )
    expect(JSON.stringify(calculationCompleteness(next, snapshot, 'unknown'))).toContain(
      'Confirm the business type'
    )
    expect(() =>
      changeTaxScope(
        fixture(),
        {
          kind: 'create-profile',
          label: 'Business',
          profile: { ...profile, businessRegime: 'forfettario' }
        },
        null,
        records,
        'invalid'
      )
    ).toThrow()
  })
  it('preserves files after invalid creation, reloads selection and rejects invalid selection', () => {
    const d = mkdtempSync(join(tmpdir(), 'unified-profile-'))
    directories.push(d)
    const path = join(d, 'scopes.json')
    writeFileSync(path, JSON.stringify(fixture()))
    const store = new TaxScopeStore(path, 'db-one')
    const before = readFileSync(path, 'utf8')
    for (const command of [
      { kind: 'create-profile', label: ' ', profile: personal },
      { kind: 'create-profile', label: 'Invalid', profile: { ...personal, taxYear: 2000 } },
      { kind: 'select-taxpayer', taxpayerId: 'missing' }
    ]) {
      expect(() => store.change(command, null, records)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
    const next = store.change(
      { kind: 'create-profile', label: 'New', profile: personal },
      null,
      records
    )
    expect(new TaxScopeStore(path, 'db-one').get()).toEqual(next)
    store.change({ kind: 'select-taxpayer', taxpayerId: 'person' }, null, records)
    expect(new TaxScopeStore(path, 'db-one').get().activeTaxpayerId).toBe('person')
    expect(() => validateTaxScope({ ...next, activeTaxpayerId: 'missing' }, 'db-one')).toThrow(
      'Invalid active profile'
    )
  })
})

describe('account ownership declarations', () => {
  it.each([null, 1, 2500, 10000])(
    'preserves unknown or precise ownership %s through persistence validation',
    (ownershipBps) => {
      const state = changeTaxScope(
        fixture(),
        {
          kind: 'account',
          taxpayerId: 'person',
          label: 'Declared account',
          ownershipBps,
          accountKind: 'provider'
        },
        null,
        records,
        'new-account'
      )
      expect(validateTaxScope(state, 'db-one').accounts.at(-1)?.ownershipBps).toBe(ownershipBps)
      const report = JSON.stringify(
        calculationCompleteness(state, snapshot, 'person', 'new-account')
      )
      expect(report.includes('Confirm the ownership share')).toBe(ownershipBps === null)
      expect(JSON.stringify(calculationCompleteness(state, snapshot, 'company'))).not.toContain(
        'Confirm the ownership share'
      )
      expect(state.accounts.slice(0, -1)).toEqual(fixture().accounts)
    }
  )
  it.each([undefined, 'unknown', 1.5, -1])(
    'rejects malformed ownership %s without modifying existing accounts',
    (ownershipBps) => {
      const state = fixture()
      expect(() =>
        changeTaxScope(
          state,
          {
            kind: 'account',
            taxpayerId: 'person',
            label: 'Bad',
            ownershipBps,
            accountKind: 'unknown'
          },
          null,
          records,
          'bad'
        )
      ).toThrow()
      expect(state).toEqual(fixture())
    }
  )
})

describe('per-profile history coverage', () => {
  it.each(['unknown', 'incomplete', 'complete'])(
    'saves %s only to the selected profile and survives reload validation',
    (coverage) => {
      const original = fixture()
      const next = changeTaxScope(
        original,
        { kind: 'history-coverage', taxpayerId: 'person', coverage },
        null,
        records,
        ''
      )
      expect(next.taxpayers[0].profile.recordsCoverage).toBe(coverage)
      expect(next.taxpayers[1]).toEqual(original.taxpayers[1])
      expect(next.accounts).toEqual(original.accounts)
      expect(next.assignments).toEqual(original.assignments)
      expect(validateTaxScope(next, 'db-one')).toEqual(next)
      expect(original.taxpayers[0].profile.recordsCoverage).toBe('complete')
    }
  )
  it('rejects unknown profiles and malformed coverage', () => {
    for (const command of [
      { kind: 'history-coverage', taxpayerId: 'absent', coverage: 'complete' },
      { kind: 'history-coverage', taxpayerId: 'person', coverage: 'verified' }
    ])
      expect(() => changeTaxScope(fixture(), command, null, records, '')).toThrow()
  })
})
