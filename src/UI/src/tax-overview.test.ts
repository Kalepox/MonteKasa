import { describe, expect, it } from 'vitest'
import { taxOverview } from './tax-overview'
import type { TaxScope } from '../../shared/tax-scope'
import type { KasaSnapshot } from '../../preload/index.d'
import { emptyValuation, type TaxEnrichment } from '../../shared/tax-enrichment'
const scope: TaxScope = {
  version: 1,
  databaseId: 'test',
  taxpayers: [],
  accounts: [
    { id: 'mine', taxpayerId: 'me', label: 'Mine', ownershipBps: null, kind: 'unknown' },
    { id: 'other', taxpayerId: 'them', label: 'Other', ownershipBps: 10000, kind: 'provider' }
  ],
  assets: [
    {
      id: 'btc',
      symbol: 'BTC',
      canonicalId: 'bitcoin',
      network: 'test',
      decimals: 8,
      environment: 'test'
    }
  ],
  assignments: [
    { recordKey: 'payment:1', accountId: 'mine', assetId: 'btc' },
    { recordKey: 'payment:2', accountId: 'other', assetId: 'btc' },
    { recordKey: 'payment:missing', accountId: 'mine', assetId: 'btc' },
    { recordKey: 'payment:foreign-missing', accountId: 'other', assetId: 'btc' }
  ]
}
const snapshot: KasaSnapshot = {
  invoices: [],
  proposals: [],
  payments: [1, 2, 3].map((nodeIdx) => ({
    nodeIdx,
    direction: 'in',
    invoiceId: null,
    received: 1,
    status: 'pending',
    txid: null,
    blockTime: null
  }))
}
function enriched(): TaxEnrichment {
  return {
    recordKey: 'payment:1',
    accountId: 'mine',
    assetId: 'btc',
    classification: 'income',
    valuation: { eur: '0', date: '2026-10-17', source: 'Rate', reference: 'Receipt' },
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
}
describe('profile overview', () => {
  it('isolates profile counts, counts orphans only for that profile and labels database-wide unassigned records', () => {
    const result = taxOverview(scope, snapshot, 'me')
    expect(result).toMatchObject({
      accounts: 1,
      assets: 1,
      invoices: 0,
      payments: 1,
      unassigned: 1,
      orphaned: 1,
      unknownOwnership: 1,
      testAssets: 1,
      unknownAssets: 0
    })
    expect(result.missing.classification).toEqual(['payment:1'])
    expect(result.missing.valuation).toEqual(['payment:1'])
    expect(result.missing.fees).toEqual(['payment:1'])
  })
  it('never treats an empty profile as complete or borrows another taxpayer’s data', () => {
    const result = taxOverview(scope, snapshot, 'absent')
    expect(result.accounts).toBe(0)
    expect(result.payments).toBe(0)
    expect(result.orphaned).toBe(0)
    expect(result.missing.classification).toEqual([])
    expect(result).not.toHaveProperty('ready')
  })
  it('updates missing entries from saved evidence references without claiming verification', () => {
    const s = { ...scope, enrichments: [enriched()] }
    const result = taxOverview(s, snapshot, 'me')
    expect(result.missing).toEqual({ classification: [], valuation: [], fees: [], links: [] })
    expect(result.unknownOwnership).toBe(1)
    expect(result.testAssets).toBe(1)
    expect(result).not.toHaveProperty('verified')
    expect(taxOverview(s, snapshot, 'them').missing.valuation).toEqual(['payment:2'])
  })
  it('distinguishes blank from zero and requires all valuation fields', () => {
    for (const field of ['eur', 'date', 'source', 'reference'] as const) {
      const e = enriched()
      e.valuation[field] = ''
      expect(taxOverview({ ...scope, enrichments: [e] }, snapshot, 'me').missing.valuation).toEqual(
        ['payment:1']
      )
    }
  })
  it('finds incomplete fees and missing or disappeared links', () => {
    const e = enriched()
    e.classification = 'refund'
    e.fee.status = 'recorded'
    expect(taxOverview({ ...scope, enrichments: [e] }, snapshot, 'me').missing).toMatchObject({
      fees: ['payment:1'],
      links: ['payment:1']
    })
    e.relatedRecordKey = 'payment:missing'
    expect(taxOverview({ ...scope, enrichments: [e] }, snapshot, 'me').missing.links).toEqual([
      'payment:1'
    ])
  })
  it('does not aggregate amounts or mutate source records', () => {
    const before = structuredClone({ scope, snapshot })
    const result = taxOverview(scope, snapshot, 'me')
    expect(result).not.toHaveProperty('totalAmount')
    expect({ scope, snapshot }).toEqual(before)
  })
})
