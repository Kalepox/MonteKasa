import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxScopeStore } from './tax-scope'
import {
  changeTaxScope,
  calculationCompleteness,
  validateTaxScope,
  type TaxScope
} from '../shared/tax-scope'
import { emptyValuation, validateEnrichment, type TaxEnrichment } from '../shared/tax-enrichment'
import type { KasaSnapshot } from '../preload/index.d'
const records = new Set(['payment:1', 'payment:2', 'invoice:one'])
function fixture(): TaxScope {
  return {
    version: 1,
    databaseId: 'db',
    taxpayers: ['person', 'company'].map((id) => ({
      id,
      label: id,
      profile: {
        version: 1,
        country: 'IT',
        taxYear: 2026,
        userType: 'personal',
        personalRegime: 'dichiarativo',
        businessType: null,
        businessRegime: null,
        recordsCoverage: 'complete'
      }
    })),
    accounts: ['a', 'b', 'other'].map((id) => ({
      id,
      taxpayerId: id === 'other' ? 'company' : 'person',
      label: id,
      ownershipBps: 10000,
      kind: 'unknown'
    })),
    assets: [
      {
        id: 'btc',
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        decimals: 8,
        environment: 'live'
      },
      {
        id: 'token',
        symbol: 'TOKEN',
        canonicalId: 'token',
        network: 'bitcoin',
        decimals: 18,
        environment: 'live'
      }
    ],
    assignments: [
      { recordKey: 'payment:1', accountId: 'a', assetId: 'btc' },
      { recordKey: 'payment:2', accountId: 'b', assetId: 'btc' },
      { recordKey: 'invoice:one', accountId: 'other', assetId: 'btc' }
    ]
  }
}
function entry(): TaxEnrichment {
  return {
    recordKey: 'payment:1',
    accountId: 'a',
    assetId: 'btc',
    classification: 'own-transfer',
    valuation: {
      eur: '9007199254740993.12345678',
      date: '2026-10-17',
      source: 'Historical rate',
      reference: '<script>untrusted</script>'
    },
    fee: {
      status: 'recorded',
      amount: '0.00000001',
      assetId: 'btc',
      purpose: 'Network fee',
      reference: 'Receipt',
      valuation: { eur: '0.01', date: '2026-10-17', source: 'Rate', reference: 'Receipt' }
    },
    relatedRecordKey: 'payment:2'
  }
}
const change = (s: TaxScope, e = entry()): TaxScope =>
  changeTaxScope(s, { kind: 'enrich', enrichment: e }, null, records, '')
const directories: string[] = []
afterEach(() => directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
describe('record enrichment', () => {
  it('preserves exact decimal strings and leaves scope and ledger identities unchanged', () => {
    const original = fixture()
    const s = change(original)
    expect(s.enrichments?.[0]).toEqual(entry())
    expect(s.assignments).toEqual(original.assignments)
    expect(original.enrichments).toBeUndefined()
    const e = entry()
    e.fee.assetId = 'token'
    e.fee.amount = '0.000000000000000001'
    expect(change(original, e).enrichments?.[0].fee.amount).toBe(e.fee.amount)
  })
  it('keeps partial data unknown and explicit zero intact', () => {
    const e = entry()
    e.valuation = emptyValuation()
    e.valuation.eur = '0'
    e.classification = 'unknown'
    e.relatedRecordKey = ''
    e.fee.status = 'unknown'
    const saved = change(fixture(), e).enrichments![0]
    expect(saved.valuation).toEqual({ ...emptyValuation(), eur: '0' })
    expect(saved.fee.amount).toBe('')
  })
  it.each(['-1', '1e3', '1,23', 'NaN', 'Infinity', '1.123456789', '01', '9'.repeat(31)])(
    'rejects invalid EUR amount %s',
    (eur) => {
      const e = entry()
      e.valuation.eur = eur
      expect(() => change(fixture(), e)).toThrow()
    }
  )
  it.each(['2026-02-30', '2026-13-01', '17/10/2026'])(
    'rejects impossible valuation date %s',
    (date) => {
      const e = entry()
      e.valuation.date = date
      expect(() => change(fixture(), e)).toThrow()
    }
  )
  it('rejects invalid classification, oversized references, fee precision and missing assets', () => {
    for (const patch of [
      { classification: 'tax-free' },
      { valuation: { ...entry().valuation, reference: 'x'.repeat(501) } },
      { fee: { ...entry().fee, amount: '0.000000001' } },
      { fee: { ...entry().fee, assetId: 'missing' } }
    ]) {
      expect(() => validateEnrichment({ ...entry(), ...patch }, fixture(), records)).toThrow()
    }
  })
  it('rejects unassigned, missing and stale-scope records', () => {
    const e = entry()
    expect(() => validateEnrichment(e, { ...fixture(), assignments: [] }, records)).toThrow()
    expect(() => validateEnrichment(e, fixture(), new Set())).toThrow()
    expect(() => validateEnrichment({ ...e, accountId: 'other' }, fixture(), records)).toThrow(
      'scope changed'
    )
    expect(() => validateEnrichment({ ...e, assetId: 'token' }, fixture(), records)).toThrow(
      'scope changed'
    )
  })
  it('rejects cross-taxpayer, self, missing, same-account and different-asset transfer links', () => {
    for (const relatedRecordKey of ['invoice:one', 'payment:1', 'payment:999'])
      expect(() => change(fixture(), { ...entry(), relatedRecordKey })).toThrow()
    for (const patch of [{ accountId: 'a' }, { assetId: 'token' }]) {
      const s = fixture()
      Object.assign(s.assignments[1], patch)
      expect(() => change(s)).toThrow()
    }
    expect(() => change(fixture(), { ...entry(), classification: 'income' })).toThrow()
  })
  it('allows refund links for the same taxpayer without inferring fiscal treatment', () => {
    expect(
      change(fixture(), { ...entry(), classification: 'refund' }).enrichments![0].classification
    ).toBe('refund')
  })
  it('clears scoped enrichment and incoming links on reassignment, retains them on identical assignment', () => {
    const s = change(fixture())
    const assign = { kind: 'assign', recordKey: 'payment:1', accountId: 'a', assetId: 'btc' }
    expect(changeTaxScope(s, assign, null, records, '').enrichments).toEqual(s.enrichments)
    expect(
      changeTaxScope(s, { ...assign, accountId: 'other' }, null, records, '').enrichments
    ).toEqual([])
    const next = changeTaxScope(s, { kind: 'unassign', recordKey: 'payment:2' }, null, records, '')
    expect(next.enrichments![0].relatedRecordKey).toBe('')
    expect(
      changeTaxScope(s, { ...assign, assetId: 'token' }, null, records, '').enrichments
    ).toEqual([])
  })
  it('removes enrichment without altering assignments', () => {
    const s = change(fixture())
    const next = changeTaxScope(
      s,
      { kind: 'clear-enrichment', recordKey: 'payment:1' },
      null,
      records,
      ''
    )
    expect(next.enrichments).toEqual([])
    expect(next.assignments).toEqual(s.assignments)
  })
  it('updates scoped completeness without declaring calculations ready or evidence verified', () => {
    const snapshot: KasaSnapshot = {
      invoices: [],
      proposals: [],
      payments: [
        {
          nodeIdx: 1,
          blockTime: null,
          direction: 'out',
          invoiceId: null,
          received: 1,
          status: 'settled',
          txid: 'tx-one'
        },
        {
          nodeIdx: 2,
          blockTime: null,
          direction: 'in',
          invoiceId: null,
          received: 1,
          status: 'settled',
          txid: 'tx-two'
        }
      ]
    }
    const before = JSON.stringify(calculationCompleteness(fixture(), snapshot, 'person', 'a'))
    expect(before).toContain('1 record(s) need a transaction classification')
    const s = change(fixture())
    const after = JSON.stringify(calculationCompleteness(s, snapshot, 'person', 'a'))
    expect(after).not.toContain('1 record(s) need a transaction classification')
    expect(after).not.toContain('1 record(s) need EUR value')
    expect(after).not.toContain('1 record(s) need fee status')
    expect(after).toContain('unverified')
    expect(after).toContain('missing-data')
    expect(after).toContain('acquisition lots')
    expect(JSON.stringify(calculationCompleteness(s, snapshot, 'person', 'b'))).toContain(
      '1 record(s) need a transaction classification'
    )
  })
  it('persists, reloads and validates older files; rejects corrupt data without overwriting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'enrichment-test-'))
    directories.push(directory)
    const path = join(directory, 'tax-scopes.json')
    writeFileSync(path, JSON.stringify(fixture()))
    const store = new TaxScopeStore(path, 'db')
    expect(store.get().enrichments).toEqual([])
    store.change({ kind: 'enrich', enrichment: entry() }, null, records)
    expect(new TaxScopeStore(path, 'db').get().enrichments).toEqual([entry()])
    const saved = readFileSync(path, 'utf8')
    expect(() =>
      store.change(
        { kind: 'enrich', enrichment: { ...entry(), assetId: 'missing' } },
        null,
        records
      )
    ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(() => new TaxScopeStore(path, 'another-db').get()).toThrow()
    const corrupt = { ...fixture(), enrichments: [entry(), entry()] }
    expect(() => validateTaxScope(corrupt, 'db')).toThrow('Duplicate enrichment')
    writeFileSync(
      path,
      JSON.stringify({ ...fixture(), enrichments: [{ ...entry(), accountId: 'other' }] })
    )
    expect(() => store.get()).toThrow()
  })
})
