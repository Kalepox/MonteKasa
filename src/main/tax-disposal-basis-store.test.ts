import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaxScopeStore } from './tax-scope'
import type { TaxScope } from '../shared/tax-scope'
import type { TaxDisposalBasis } from '../shared/tax-disposal-basis'
import type { TaxProfile } from '../shared/tax-profile'
import { emptyValuation } from '../shared/tax-enrichment'

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
const basis: TaxDisposalBasis = {
  taxpayerId: 'person',
  taxYear: 2026,
  recordKey: 'payment:1',
  facts: '["fixture saved facts"]',
  transactionKind: 'fiat-sale',
  costBasisEur: '100.12345678',
  reference: 'Fixture LIFO allocation schedule',
  reviewed: true
}
const fixtures: string[] = []
afterEach(() => {
  for (const folder of fixtures.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function fixture(): { path: string; ledgerPath: string; original: TaxScope } {
  const folder = mkdtempSync(join(tmpdir(), 'tax-disposal-basis-'))
  fixtures.push(folder)
  const path = join(folder, 'scope.json')
  const ledgerPath = join(folder, 'ledger-fixture.json')
  // An isolated saved-ledger fixture. The application database is never opened.
  writeFileSync(
    ledgerPath,
    JSON.stringify({ payments: [{ nodeIdx: 1, receivedRaw: 1000, direction: 'out' }] })
  )
  const assignment = { recordKey: 'payment:1', accountId: 'account', assetId: 'btc' }
  const original: TaxScope = {
    version: 1,
    databaseId: 'fixture-db',
    activeTaxpayerId: 'person',
    taxpayers: [
      { id: 'person', label: 'Fixture person', profile: personal },
      { id: 'another', label: 'Other fixture person', profile: personal }
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
    assignments: [assignment],
    enrichments: [
      {
        ...assignment,
        classification: 'sale',
        valuation: {
          eur: '150',
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
    ],
    preparationAnswers: [
      {
        taxpayerId: 'person',
        taxYear: 2026,
        questionId: 'acquisition-history',
        status: 'available',
        reference: 'Statement A',
        notes: ''
      }
    ]
  }
  writeFileSync(path, JSON.stringify(original, null, 2))
  return { path, ledgerPath, original }
}

describe('documented disposal cost storage', () => {
  it('reads an existing file without migrating or writing optional evidence', () => {
    const { path, original } = fixture()
    const before = readFileSync(path, 'utf8')
    expect(new TaxScopeStore(path, 'fixture-db').get()).toEqual(original)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('persists exact evidence across restart without changing the ledger or existing declarations', () => {
    const { path, ledgerPath, original } = fixture()
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const next = new TaxScopeStore(path, 'fixture-db').change(
      { kind: 'disposal-basis', basis },
      null,
      new Set(['payment:1'])
    )
    expect(new TaxScopeStore(path, 'fixture-db').get()).toEqual({
      ...original,
      disposalBases: [basis]
    })
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(next, null, 2))
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    expect(new TaxScopeStore(path, 'another-database').get().disposalBases).toBeUndefined()
  })

  it('replaces only the chosen allocation and preserves other profiles, years and records', () => {
    const { path, original } = fixture()
    const previous: TaxScope = {
      ...original,
      disposalBases: [
        basis,
        { ...basis, taxYear: 2025 },
        { ...basis, taxpayerId: 'another' },
        { ...basis, recordKey: 'payment:missing' }
      ]
    }
    writeFileSync(path, JSON.stringify(previous, null, 2))
    const revised = { ...basis, costBasisEur: '0', reviewed: false }
    new TaxScopeStore(path, 'fixture-db').change(
      { kind: 'disposal-basis', basis: revised },
      null,
      new Set(['payment:1'])
    )
    expect(new TaxScopeStore(path, 'fixture-db').get().disposalBases).toEqual([
      ...previous.disposalBases!.slice(1),
      revised
    ])
  })

  it('does not write scope or ledger data for invalid or stale saves', () => {
    const { path, ledgerPath } = fixture()
    const before = readFileSync(path, 'utf8')
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const store = new TaxScopeStore(path, 'fixture-db')
    for (const invalid of [
      { ...basis, taxpayerId: 'another' },
      { ...basis, taxYear: 2025 },
      { ...basis, transactionKind: 'goods-services' },
      { ...basis, recordKey: 'payment:absent' },
      { ...basis, costBasisEur: '-1' },
      { ...basis, reference: '' },
      { ...basis, facts: '' }
    ]) {
      expect(() =>
        store.change({ kind: 'disposal-basis', basis: invalid }, null, new Set(['payment:1']))
      ).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    }
    expect(() => store.change({ kind: 'disposal-basis', basis }, null, new Set())).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('keeps previous evidence when reassignment invalidates enrichment or profile eligibility changes', () => {
    const { path } = fixture()
    const store = new TaxScopeStore(path, 'fixture-db')
    store.change({ kind: 'disposal-basis', basis }, null, new Set(['payment:1']))
    const moved = store.change(
      { kind: 'assign', recordKey: 'payment:1', accountId: 'other-account', assetId: 'btc' },
      null,
      new Set(['payment:1'])
    )
    expect(moved.enrichments).toEqual([])
    expect(new TaxScopeStore(path, 'fixture-db').get().disposalBases).toEqual([basis])
    moved.taxpayers[0].profile = { ...personal, country: 'other', taxYear: 2025 }
    writeFileSync(path, JSON.stringify(moved, null, 2))
    expect(new TaxScopeStore(path, 'fixture-db').get()).toEqual(moved)
  })

  it('rejects corrupted duplicate evidence without repairing or overwriting the source file', () => {
    const { path, original } = fixture()
    const corrupted = JSON.stringify({ ...original, disposalBases: [basis, basis] }, null, 2)
    writeFileSync(path, corrupted)
    const store = new TaxScopeStore(path, 'fixture-db')
    expect(() => store.get()).toThrow('Scope file is invalid')
    expect(() =>
      store.change({ kind: 'disposal-basis', basis }, null, new Set(['payment:1']))
    ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(corrupted)
  })
})
