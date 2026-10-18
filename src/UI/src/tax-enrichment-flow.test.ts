import { describe, expect, it } from 'vitest'
import { enrichmentQuestions, relatedRecordCandidates } from './tax-enrichment-flow'
import { recordClassifications } from '../../shared/tax-enrichment'
import type { TaxScope } from '../../shared/tax-scope'
const scope: TaxScope = {
  version: 1,
  databaseId: 'test',
  taxpayers: [],
  assets: [],
  accounts: [
    { id: 'one', taxpayerId: 'person', label: 'One', ownershipBps: 10000, kind: 'unknown' },
    { id: 'two', taxpayerId: 'person', label: 'Two', ownershipBps: null, kind: 'unknown' },
    {
      id: 'foreign',
      taxpayerId: 'business',
      label: 'Business',
      ownershipBps: 10000,
      kind: 'unknown'
    }
  ],
  assignments: [
    { recordKey: 'payment:1', accountId: 'one', assetId: 'btc' },
    { recordKey: 'payment:2', accountId: 'two', assetId: 'btc' },
    { recordKey: 'payment:3', accountId: 'one', assetId: 'btc' },
    { recordKey: 'payment:4', accountId: 'two', assetId: 'token' },
    { recordKey: 'payment:5', accountId: 'foreign', assetId: 'btc' },
    { recordKey: 'payment:missing', accountId: 'two', assetId: 'btc' },
    { recordKey: 'invoice:1', accountId: 'one', assetId: 'btc' }
  ]
}
const records = new Set(
  scope.assignments.map((a) => a.recordKey).filter((key) => key !== 'payment:missing')
)
describe('conditional enrichment questions', () => {
  it.each(recordClassifications)('provides a question and explanation for %s', (kind) => {
    expect(enrichmentQuestions[kind].value).toContain('euros')
    expect(enrichmentQuestions[kind].explanation.length).toBeGreaterThan(40)
  })
  it('distinguishes proceeds, reference value, invoice request and incomplete data', () => {
    expect(enrichmentQuestions.sale.explanation).toContain('not the gain')
    expect(enrichmentQuestions['own-transfer'].value).toContain('not sale proceeds')
    expect(enrichmentQuestions['goods-services'].explanation).toContain('not proof of payment')
    expect(enrichmentQuestions.unknown.explanation).toContain('remain unclassified')
  })
  it('lists only same-owner same-asset transfers between distinct accounts', () => {
    expect(relatedRecordCandidates(scope, records, 'payment:1', 'own-transfer')).toEqual([
      'payment:2'
    ])
    expect(relatedRecordCandidates(scope, records, 'invoice:1', 'own-transfer')).toEqual([])
    expect(scope.accounts[1].ownershipBps).toBeNull() // A candidate is not verified ownership.
  })
  it('offers other same-taxpayer records for refunds but excludes absent and foreign records', () => {
    expect(relatedRecordCandidates(scope, records, 'payment:1', 'refund')).toEqual([
      'payment:2',
      'payment:3',
      'payment:4',
      'invoice:1'
    ])
  })
  it.each(['unknown', 'purchase', 'sale', 'goods-services', 'income'])(
    'does not offer links for %s',
    (kind) => {
      expect(relatedRecordCandidates(scope, records, 'payment:1', kind)).toEqual([])
    }
  )
  it('does not offer links for missing or unassigned records and never mutates scope', () => {
    const before = structuredClone(scope)
    expect(relatedRecordCandidates(scope, records, 'payment:missing', 'refund')).toEqual([])
    expect(
      relatedRecordCandidates(
        scope,
        new Set([...records, 'payment:unassigned']),
        'payment:unassigned',
        'refund'
      )
    ).toEqual([])
    expect(scope).toEqual(before)
  })
})
