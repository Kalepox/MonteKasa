import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaxScopeStore } from './tax-scope'
import type { TaxScope } from '../shared/tax-scope'
import type { TaxPreparationAnswer } from '../shared/tax-questions'
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
  recordsCoverage: 'incomplete'
}
const answer: TaxPreparationAnswer = {
  taxpayerId: 'person',
  taxYear: 2026,
  questionId: 'acquisition-history',
  status: 'partial',
  reference: 'Fixture statement',
  notes: 'Earlier acquisitions still need review'
}
const fixtures: string[] = []
afterEach(() => {
  for (const folder of fixtures.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function fixture(): { path: string; ledgerPath: string; original: TaxScope } {
  const folder = mkdtempSync(join(tmpdir(), 'tax-questions-'))
  fixtures.push(folder)
  const path = join(folder, 'scope.json')
  const ledgerPath = join(folder, 'ledger-fixture.json')
  // This is a standalone test fixture, never an application database.
  writeFileSync(ledgerPath, JSON.stringify({ payment: { id: 1, amount: '42', status: 'settled' } }))
  const assignment = { recordKey: 'payment:1', accountId: 'account', assetId: 'btc' }
  const original: TaxScope = {
    version: 1,
    databaseId: 'fixture-db',
    activeTaxpayerId: 'person',
    taxpayers: [
      { id: 'person', label: 'Fixture person', profile: personal },
      { id: 'another', label: 'Another fixture profile', profile: personal }
    ],
    accounts: [
      {
        id: 'account',
        taxpayerId: 'person',
        label: 'Fixture account',
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
        classification: 'income',
        valuation: {
          eur: '1.25',
          date: '2026-01-02',
          source: 'Fixture rate',
          reference: 'Fixture evidence'
        },
        fee: {
          status: 'unknown',
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
  writeFileSync(path, JSON.stringify(original, null, 2))
  return { path, ledgerPath, original }
}

describe('calculation preparation storage', () => {
  it('reads an existing file without migration or writes', () => {
    const { path, original } = fixture()
    const before = readFileSync(path, 'utf8')
    expect(new TaxScopeStore(path, 'fixture-db').get()).toEqual(original)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('persists answers across restart without changing saved records, profiles or enrichment', () => {
    const { path, ledgerPath, original } = fixture()
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const store = new TaxScopeStore(path, 'fixture-db')
    const next = store.change({ kind: 'preparation-answer', answer }, null, new Set(['payment:1']))
    const reloaded = new TaxScopeStore(path, 'fixture-db').get()
    expect(reloaded).toEqual(next)
    expect(reloaded).toEqual({ ...original, preparationAnswers: [answer] })
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    expect(new TaxScopeStore(path, 'other-db').get().preparationAnswers).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(next, null, 2))
  })

  it('updates the chosen answer and preserves historical and other-profile answers', () => {
    const { path, original } = fixture()
    const previous: TaxScope = {
      ...original,
      preparationAnswers: [
        answer,
        { ...answer, taxYear: 2025 },
        { ...answer, taxpayerId: 'another' }
      ]
    }
    writeFileSync(path, JSON.stringify(previous, null, 2))
    const revised: TaxPreparationAnswer = {
      ...answer,
      status: 'available',
      notes: 'Reference gathered, still unverified'
    }
    const store = new TaxScopeStore(path, 'fixture-db')
    store.change({ kind: 'preparation-answer', answer: revised }, null, new Set(['payment:1']))
    expect(new TaxScopeStore(path, 'fixture-db').get().preparationAnswers).toEqual([
      previous.preparationAnswers![1],
      previous.preparationAnswers![2],
      revised
    ])
  })

  it('does not write on a stale or invalid save', () => {
    const { path, ledgerPath } = fixture()
    const before = readFileSync(path, 'utf8')
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const store = new TaxScopeStore(path, 'fixture-db')
    for (const invalid of [
      { ...answer, taxYear: 2025 },
      { ...answer, taxpayerId: 'another' },
      { ...answer, questionId: 'vat-documents' },
      { ...answer, status: 'available', reference: '' },
      { ...answer, notes: 'x'.repeat(2001) }
    ]) {
      expect(() =>
        store.change({ kind: 'preparation-answer', answer: invalid }, null, new Set(['payment:1']))
      ).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    }
  })

  it('keeps historical answers when reloading a changed profile and rejects corrupted duplicate answers without writes', () => {
    const { path, original } = fixture()
    const changed = structuredClone(original)
    changed.taxpayers[0].profile = { ...personal, country: 'other', taxYear: 2025 }
    changed.preparationAnswers = [answer]
    writeFileSync(path, JSON.stringify(changed, null, 2))
    expect(new TaxScopeStore(path, 'fixture-db').get()).toEqual(changed)
    changed.preparationAnswers.push(answer)
    const corrupted = JSON.stringify(changed, null, 2)
    writeFileSync(path, corrupted)
    const store = new TaxScopeStore(path, 'fixture-db')
    expect(() => store.get()).toThrow('Scope file is invalid')
    expect(() => store.change({ kind: 'preparation-answer', answer }, null, new Set())).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(corrupted)
  })
})
