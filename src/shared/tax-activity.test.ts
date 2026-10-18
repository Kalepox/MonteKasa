import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../preload/index.d'
import type { LedgerSource } from './ledger-source'
import {
  activityRows,
  bindLedgerSource,
  formatLedgerAmount,
  observedSources,
  organiseTaxActivity
} from './tax-activity'
import { changeTaxScope, recordKeys, validateTaxScope, type TaxScope } from './tax-scope'
import { emptyValuation } from './tax-enrichment'

const source: LedgerSource = {
  id: 'app-btc',
  label: 'Saved Bitcoin activity',
  backend: 'wdk',
  asset: { symbol: 'BTC', canonicalId: 'btc', network: 'bitcoin', decimals: 8, environment: 'live' }
}
const invoice: KasaInvoice = {
  source,
  id: 'request',
  client: 'Client',
  amount: 1,
  amountRaw: 100000000,
  received: 1,
  receivedRaw: 100000000,
  rgbInvoice: 'request',
  recipientId: 'recipient',
  expiresAt: 1,
  createdAt: 1,
  state: 'Paid'
}
const payment: KasaPayment = {
  source,
  nodeIdx: 1,
  direction: 'in',
  invoiceId: 'request',
  received: 1,
  receivedRaw: 100000000,
  status: 'settled',
  txid: 'shared-tx',
  blockTime: 1
}
const snapshot: KasaSnapshot = { invoices: [invoice], payments: [payment], proposals: [] }
function scope(): TaxScope {
  return {
    version: 1,
    databaseId: 'db',
    taxpayers: [
      {
        id: 'me',
        label: 'Me',
        profile: {
          version: 1,
          country: 'IT',
          taxYear: 2026,
          userType: 'personal',
          personalRegime: 'dichiarativo',
          businessType: null,
          businessRegime: null,
          recordsCoverage: 'unknown'
        }
      }
    ],
    accounts: [],
    assets: [],
    assignments: []
  }
}
const bind = { kind: 'bind-source', sourceId: source.id, taxpayerId: 'me', ownershipBps: 10000 }

describe('saved ledger source ownership', () => {
  it('requires one explicit confirmation, derives asset facts from saved records, and fills new records idempotently', () => {
    const original = scope()
    expect(organiseTaxActivity(original, snapshot)).toBe(original)
    const linked = bindLedgerSource(
      original,
      snapshot,
      { ...bind, asset: { decimals: 0 } },
      'account'
    )
    expect(linked.accounts[0]).toMatchObject({
      id: 'account',
      sourceId: source.id,
      ownershipBps: 10000
    })
    expect(linked.assets[0]).toEqual({ id: 'account-asset', ...source.asset })
    expect(linked.assignments).toHaveLength(2)
    const next = organiseTaxActivity(linked, {
      ...snapshot,
      payments: [...snapshot.payments, { ...payment, nodeIdx: 2 }]
    })
    expect(next.assignments).toHaveLength(3)
    expect(organiseTaxActivity(next, snapshot)).toBe(next)
    expect(validateTaxScope(next, 'db')).toEqual({ ...next, enrichments: [] })
    expect(original).toEqual(scope())
  })
  it('does not infer a legacy record source from the current configuration or linked invoice', () => {
    const mixed = { ...snapshot, payments: [{ ...payment, source: undefined }] }
    const linked = bindLedgerSource(scope(), mixed, bind, 'account')
    expect(linked.assignments.map((item) => item.recordKey)).toEqual(['invoice:request'])
    expect(observedSources(mixed)[0].paymentCount).toBe(0)
  })
  it('binds an existing owned account without changing its declarations or creating another account', () => {
    const existing = changeTaxScope(
      scope(),
      {
        kind: 'account',
        taxpayerId: 'me',
        label: 'Existing',
        ownershipBps: 2500,
        accountKind: 'provider'
      },
      null,
      new Set(),
      'account'
    )
    const linked = bindLedgerSource(
      existing,
      snapshot,
      { ...bind, accountId: 'account', label: 'Ignore', ownershipBps: 10000 },
      'binding'
    )
    expect(linked.accounts).toEqual([{ ...existing.accounts[0], sourceId: source.id }])
    expect(linked.assignments.every((assignment) => assignment.accountId === 'account')).toBe(true)
  })
  it('preserves explicit assignments, enrichments and incoming related links exactly', () => {
    let existing = bindLedgerSource(scope(), snapshot, bind, 'account')
    existing = changeTaxScope(
      existing,
      {
        kind: 'enrich',
        enrichment: {
          recordKey: 'payment:1',
          accountId: 'account',
          assetId: 'account-asset',
          classification: 'refund',
          valuation: { eur: '123.456789', date: '2026-01-01', source: 'Evidence', reference: '' },
          fee: {
            status: 'unknown',
            amount: '',
            assetId: '',
            purpose: '',
            reference: '',
            valuation: emptyValuation()
          },
          relatedRecordKey: 'invoice:request'
        }
      },
      null,
      recordKeys(snapshot),
      ''
    )
    const oldAssignments = structuredClone(existing.assignments)
    const oldEnrichment = structuredClone(existing.enrichments)
    const next = organiseTaxActivity(existing, {
      ...snapshot,
      payments: [...snapshot.payments, { ...payment, nodeIdx: 2 }]
    })
    expect(next.assignments.slice(0, 2)).toEqual(oldAssignments)
    expect(next.enrichments).toEqual(oldEnrichment)
  })
  it('never reassigns a record manually belonging to another profile', () => {
    const state = scope()
    state.taxpayers.push({ ...state.taxpayers[0], id: 'other' })
    state.accounts.push({
      id: 'other-account',
      taxpayerId: 'other',
      ownershipBps: 10000,
      kind: 'unknown',
      label: 'Other'
    })
    state.assets.push({ ...source.asset, id: 'asset' })
    state.assignments.push({ recordKey: 'payment:1', accountId: 'other-account', assetId: 'asset' })
    const linked = bindLedgerSource(state, snapshot, bind, 'my-account')
    expect(linked.assignments[0]).toEqual(state.assignments[0])
    expect(linked.assignments).toHaveLength(2)
  })
  it('keeps manually removed records excluded on later refresh and after reload', () => {
    const linked = bindLedgerSource(scope(), snapshot, bind, 'account')
    const removed = changeTaxScope(
      linked,
      { kind: 'unassign', recordKey: 'payment:1' },
      null,
      recordKeys(snapshot),
      ''
    )
    const reloaded = validateTaxScope(removed, 'db')
    expect(organiseTaxActivity(reloaded, snapshot).assignments).toHaveLength(1)
    expect(reloaded.autoAssignmentExclusions).toEqual(['payment:1'])
    const assigned = changeTaxScope(
      reloaded,
      { kind: 'assign', recordKey: 'payment:1', accountId: 'account', assetId: 'account-asset' },
      null,
      recordKeys(snapshot),
      ''
    )
    expect(assigned.autoAssignmentExclusions).toEqual([])
  })
  it('stops future automatic assignments when disconnected, preserving historical scope', () => {
    const linked = bindLedgerSource(scope(), snapshot, bind, 'account')
    const detached = changeTaxScope(
      linked,
      { kind: 'unbind-source', accountId: 'account' },
      null,
      recordKeys(snapshot),
      ''
    )
    const next = organiseTaxActivity(detached, {
      ...snapshot,
      payments: [{ ...payment, nodeIdx: 2 }]
    })
    expect(next.assignments).toEqual(linked.assignments)
    expect(next.accounts[0].sourceId).toBeUndefined()
  })
  it.each([
    { ...bind, sourceId: 'invented' },
    { ...bind, taxpayerId: 'missing' },
    { ...bind, ownershipBps: null },
    { ...bind, ownershipBps: 0 },
    { ...bind, accountId: 'missing' }
  ])('rejects unobserved or unconfirmed ownership %j', (command) => {
    expect(() => bindLedgerSource(scope(), snapshot, command, 'account')).toThrow()
  })
  it('rejects conflicting owners, account links, asset precision and metadata', () => {
    const linked = bindLedgerSource(scope(), snapshot, bind, 'account')
    expect(() => bindLedgerSource(linked, snapshot, bind, 'another')).toThrow('already linked')
    const wrongPrecision = scope()
    wrongPrecision.assets.push({ ...source.asset, decimals: 6, id: 'existing' })
    expect(() => bindLedgerSource(wrongPrecision, snapshot, bind, 'account')).toThrow('precision')
    const conflicting = {
      ...snapshot,
      payments: [
        payment,
        { ...payment, nodeIdx: 2, source: { ...source, asset: { ...source.asset, decimals: 6 } } }
      ]
    }
    expect(observedSources(conflicting)[0].conflict).toBe(true)
    expect(() => bindLedgerSource(scope(), conflicting, bind, 'account')).toThrow(
      'conflicting metadata'
    )
    expect(organiseTaxActivity(linked, conflicting)).toBe(linked)
  })
  it('rejects malformed persisted bindings and duplicate exclusions, preserving older scopes unchanged', () => {
    expect(validateTaxScope(scope(), 'db')).toEqual(scope())
    const linked = bindLedgerSource(scope(), snapshot, bind, 'account')
    expect(() =>
      validateTaxScope(
        { ...linked, accounts: [...linked.accounts, { ...linked.accounts[0], id: 'duplicate' }] },
        'db'
      )
    ).toThrow('duplicate source')
    expect(() =>
      validateTaxScope(
        { ...linked, accounts: [{ ...linked.accounts[0], ownershipBps: null }] },
        'db'
      )
    ).toThrow('confirmed ownership')
    expect(() =>
      validateTaxScope({ ...linked, autoAssignmentExclusions: ['payment:1', 'payment:1'] }, 'db')
    ).toThrow('duplicate assignment exclusion')
  })
})

describe('reconciled activity presentation', () => {
  it('keeps partial payments and multiple observations sharing a transaction, without a second receipt for the invoice', () => {
    const ledger = {
      ...snapshot,
      payments: [payment, { ...payment, nodeIdx: 2, receivedRaw: 25000000, status: 'confirming' }]
    }
    const rows = activityRows(scope(), ledger)
    expect(rows.map((row) => row.recordKey)).toEqual(['payment:1', 'payment:2'])
    expect(rows.every((row) => row.invoice?.id === 'request')).toBe(true)
    expect(rows.map((row) => row.status)).toEqual(['settled', 'pending'])
    expect(formatLedgerAmount(rows[1])).toBe('0.25 BTC')
  })
  it('leaves requests separate when only outgoing payments refer to them', () => {
    const rows = activityRows(scope(), {
      ...snapshot,
      payments: [{ ...payment, direction: 'out' }]
    })
    expect(rows.map((row) => row.kind)).toEqual(['payment', 'request'])
    expect(rows[0].invoice).toBeUndefined()
  })
  it('keeps a request separate when its saved source conflicts with the linked payment', () => {
    const rows = activityRows(scope(), {
      ...snapshot,
      payments: [{ ...payment, source: { ...source, id: 'another-source' } }]
    })
    expect(rows.map((row) => row.kind)).toEqual(['payment', 'request'])
    expect(rows[0].invoice).toBeUndefined()
    const changedAsset = activityRows(scope(), {
      ...snapshot,
      payments: [{ ...payment, source: { ...source, asset: { ...source.asset, decimals: 6 } } }]
    })
    expect(changedAsset).toHaveLength(2)
  })
  it('keeps unassigned requests visible when their linked payments belong to another profile', () => {
    const state = bindLedgerSource(scope(), snapshot, bind, 'account')
    state.taxpayers.push({ ...state.taxpayers[0], id: 'other' })
    state.accounts.push({
      id: 'other',
      taxpayerId: 'other',
      label: 'Other',
      kind: 'unknown',
      ownershipBps: 10000
    })
    state.assignments = [{ recordKey: 'payment:1', accountId: 'other', assetId: 'account-asset' }]
    const review = activityRows(state, snapshot, 'me', true)
    expect(review.map((row) => [row.recordKey, row.kind])).toEqual([['invoice:request', 'request']])
    expect(review[0].assignment).toBeUndefined()
    expect(activityRows(state, snapshot, 'me')).toEqual([])
    const all = activityRows(state, snapshot)
    expect(all.map((row) => row.recordKey)).toEqual(['payment:1'])
    expect(all[0].invoice?.id).toBe('request')
  })
  it('filters invoice evidence as well as payment rows before reconciliation', () => {
    const state = bindLedgerSource(scope(), snapshot, bind, 'account')
    state.assignments = state.assignments.filter((item) => item.recordKey === 'payment:1')
    const assignedOnly = activityRows(state, snapshot, 'me')
    expect(assignedOnly.map((row) => row.recordKey)).toEqual(['payment:1'])
    expect(assignedOnly[0].invoice).toBeUndefined()
    const withUnassigned = activityRows(state, snapshot, 'me', true)
    expect(withUnassigned).toHaveLength(1)
    expect(withUnassigned[0].invoice?.id).toBe('request')
    expect(activityRows(state, snapshot, '', true).map((row) => row.recordKey)).toEqual([
      'invoice:request'
    ])
  })
  it('does not attach another profile request to a visible unassigned payment', () => {
    const state = bindLedgerSource(scope(), snapshot, bind, 'account')
    state.assignments = state.assignments.filter((item) => item.recordKey === 'invoice:request')
    const review = activityRows(state, snapshot, 'other', true)
    expect(review.map((row) => row.recordKey)).toEqual(['payment:1'])
    expect(review[0].invoice).toBeUndefined()
  })
  it('does not leak another profile invoice into selected activity', () => {
    const linked = bindLedgerSource(scope(), snapshot, bind, 'account')
    linked.taxpayers.push({ ...linked.taxpayers[0], id: 'other' })
    linked.accounts.push({
      id: 'other',
      taxpayerId: 'other',
      label: 'Other',
      kind: 'unknown',
      ownershipBps: 10000
    })
    linked.assignments.find((assignment) => assignment.recordKey === 'invoice:request')!.accountId =
      'other'
    const rows = activityRows(linked, snapshot, 'me')
    expect(rows).toHaveLength(1)
    expect(rows[0].invoice).toBeUndefined()
    expect(activityRows(linked, snapshot, 'missing')).toEqual([])
  })
  it('shows pending, failed, test and legacy separately without classifying receipts or calculating tax', () => {
    const rows = activityRows(scope(), {
      invoices: [],
      proposals: [],
      payments: [
        { ...payment, status: 'failed' },
        {
          ...payment,
          nodeIdx: 2,
          source: { ...source, asset: { ...source.asset, environment: 'test' } }
        },
        { ...payment, nodeIdx: 3, status: 'unrecognised', source: undefined }
      ]
    })
    expect(rows.map((row) => [row.status, row.environment])).toEqual([
      ['failed', 'live'],
      ['settled', 'test'],
      ['unknown', 'unknown']
    ])
    expect(formatLedgerAmount(rows[2])).toBe('1 recorded app units')
    expect(rows.every((row) => !('tax' in row) && !('classification' in row))).toBe(true)
  })
  it.each([
    [0, 8, '0 BTC'],
    [1, 8, '0.00000001 BTC'],
    [123456789, 8, '1.23456789 BTC'],
    [100, 0, '100 BTC']
  ])('formats integer raw amount %s exactly with precision %s', (raw, decimals, expected) => {
    const row = activityRows(scope(), {
      ...snapshot,
      payments: [
        {
          ...payment,
          receivedRaw: Number(raw),
          source: { ...source, asset: { ...source.asset, decimals: Number(decimals) } }
        }
      ]
    })[0]
    expect(formatLedgerAmount(row)).toBe(expected)
  })
  it.each([undefined, Number.MAX_SAFE_INTEGER + 1, -1, 0.5])(
    'does not use display amounts as precise source amounts when raw is %s',
    (receivedRaw) => {
      const row = activityRows(scope(), { ...snapshot, payments: [{ ...payment, receivedRaw }] })[0]
      expect(formatLedgerAmount(row)).toContain('Amount unavailable')
    }
  )
})
