import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
import { emptyValuation, type TaxEnrichment } from '../../shared/tax-enrichment'
import type { TaxScope } from '../../shared/tax-scope'
import { buildDashboardVisuals } from './tax-dashboard-visuals'
import { buildTaxReport } from './tax-report'

const source: LedgerSource = {
  id: 'saved-source',
  label: 'Saved BTC',
  backend: 'wdk',
  asset: {
    symbol: 'BTC',
    canonicalId: 'bitcoin',
    network: 'bitcoin',
    decimals: 8,
    environment: 'live'
  }
}
const seconds = (date: string): number => Date.parse(date) / 1000
function payment(nodeIdx: number, changes: Partial<KasaPayment> = {}): KasaPayment {
  return {
    nodeIdx,
    invoiceId: null,
    direction: 'in',
    received: 999,
    receivedRaw: 100000,
    status: 'settled',
    txid: `transaction-${nodeIdx}`,
    blockTime: seconds('2026-02-03T12:00:00Z'),
    source: structuredClone(source),
    ...changes
  }
}
function enrichment(recordKey: string, eur = '10.25'): TaxEnrichment {
  return {
    recordKey,
    accountId: 'account',
    assetId: 'btc',
    classification: 'income',
    valuation: { eur, date: '2026-02-03', source: 'Saved statement', reference: 'Document 1' },
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
function fixture(): { scope: TaxScope; snapshot: KasaSnapshot } {
  const scope: TaxScope = {
    version: 1,
    databaseId: 'fixture-db',
    appProfileId: 'app-me',
    activeTaxpayerId: 'me',
    taxpayers: [
      {
        id: 'me',
        label: 'My account',
        profile: {
          version: 1,
          country: 'IT',
          userType: 'personal',
          taxYear: 2026,
          personalRegime: 'dichiarativo',
          businessType: null,
          businessRegime: null,
          recordsCoverage: 'incomplete'
        }
      }
    ],
    accounts: [
      {
        id: 'account',
        taxpayerId: 'me',
        sourceId: source.id,
        label: 'My saved account',
        ownershipBps: 10000,
        kind: 'self-custody'
      }
    ],
    assets: [{ id: 'btc', ...source.asset }],
    assignments: [1, 2].map((id) => ({
      recordKey: `payment:${id}`,
      accountId: 'account',
      assetId: 'btc'
    })),
    enrichments: [enrichment('payment:1'), enrichment('payment:2', '2.50')]
  }
  return {
    scope,
    snapshot: {
      invoices: [],
      payments: [payment(1), payment(2, { direction: 'out' })],
      proposals: []
    }
  }
}
function build(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  includeSnapshot = true
): ReturnType<typeof buildDashboardVisuals> {
  return buildDashboardVisuals(
    scope,
    buildTaxReport(scope, snapshot)!,
    includeSnapshot ? snapshot : undefined
  )
}
function add(scope: TaxScope, snapshot: KasaSnapshot, p: KasaPayment, value?: TaxEnrichment): void {
  snapshot.payments.push(p)
  scope.assignments.push({
    recordKey: `payment:${p.nodeIdx}`,
    accountId: 'account',
    assetId: 'btc'
  })
  if (value) scope.enrichments!.push(value)
}

describe('saved-data dashboard visuals', () => {
  it('uses exact saved EUR evidence for payment activity, separate from tax calculations', () => {
    const { scope, snapshot } = fixture()
    const result = build(scope, snapshot)
    expect(result.activity.mode).toBe('eur')
    expect(result.activity.incoming).toBe('10.25000000')
    expect(result.activity.outgoing).toBe('2.50000000')
    expect(result.activity.months[1]).toEqual({
      month: 2,
      label: 'Feb',
      incoming: '10.25000000',
      outgoing: '2.50000000',
      incomingRatio: 1,
      outgoingRatio: 0.243902,
      incomingCount: 1,
      outgoingCount: 1
    })
    expect(result.reviewed).toEqual({ documented: 2, total: 2, needsDetails: 0 })
    expect(result.activity.months[0].incoming).toBeNull()
    expect(result).not.toHaveProperty('tax')
    expect(result.limitations.join(' ')).toContain('not taxable profit')
  })

  it('never adds invoice requests or cumulative receipts to observed payments', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[0].invoiceId = 'invoice'
    const invoice: KasaInvoice = {
      id: 'invoice',
      client: 'Customer',
      amount: 9999,
      amountRaw: 999900000000,
      received: 8888,
      receivedRaw: 888800000000,
      state: 'Paid',
      createdAt: seconds('2026-02-03T12:00:00Z'),
      expiresAt: seconds('2026-03-03T12:00:00Z'),
      rgbInvoice: '',
      recipientId: '',
      source
    }
    snapshot.invoices.push(invoice)
    scope.assignments.push({ recordKey: 'invoice:invoice', accountId: 'account', assetId: 'btc' })
    scope.enrichments!.push(enrichment('invoice:invoice', '9999'))
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBe('10.25000000')
    expect(result.activity.totalPayments).toBe(2)
    expect(JSON.stringify(result)).not.toContain('9999')
  })

  it('keeps very large decimal sums exact and bar ratios finite', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[1].direction = 'in'
    scope.enrichments![0].valuation.eur = '999999999999999999999999999999.99999999'
    scope.enrichments![1].valuation.eur = '0.00000001'
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBe('1000000000000000000000000000000.00000000')
    expect(result.activity.scaleMaximum).toBe(result.activity.incoming)
    expect(
      result.activity.months.every(
        (m) => Number.isFinite(m.incomingRatio) && m.incomingRatio >= 0 && m.incomingRatio <= 1
      )
    ).toBe(true)
  })

  it('adds documented valuations across distinct assets without treating token units as EUR', () => {
    const { scope, snapshot } = fixture()
    const token: LedgerSource = {
      ...source,
      id: 'token-source',
      asset: {
        symbol: 'USDT',
        canonicalId: 'tether',
        network: 'ethereum',
        decimals: 6,
        environment: 'live'
      }
    }
    snapshot.payments[1].source = token
    scope.accounts.push({ ...scope.accounts[0], id: 'token-account', sourceId: token.id })
    scope.assets.push({ id: 'usdt', ...token.asset })
    scope.assignments[1] = { recordKey: 'payment:2', accountId: 'token-account', assetId: 'usdt' }
    Object.assign(scope.enrichments![1], scope.assignments[1])
    snapshot.payments[1].direction = 'in'
    snapshot.payments[1].received = 1000000
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBe('12.75000000')
    expect(result.activity.eligiblePayments).toBe(2)
  })

  it('retains documented zero EUR as known zero and leaves absent directions unknown', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = [snapshot.payments[0]]
    scope.enrichments![0].valuation.eur = '0'
    const result = build(scope, snapshot)
    expect(result.activity.mode).toBe('eur')
    expect(result.activity.incoming).toBe('0.00000000')
    expect(result.activity.outgoing).toBeNull()
    expect(
      result.activity.months.every((m) => m.incomingRatio === 0 && m.outgoingRatio === 0)
    ).toBe(true)
  })

  it('falls back to labelled saved record counts when no EUR evidence is available', () => {
    const { scope, snapshot } = fixture()
    scope.enrichments = []
    const result = build(scope, snapshot)
    expect(result.activity.mode).toBe('count')
    expect(result.activity.incoming).toBe('1')
    expect(result.activity.outgoing).toBe('1')
    expect(result.coverage.unvaluedPayments).toBe(2)
    expect(result.reviewed).toEqual({ documented: 0, total: 2, needsDetails: 2 })
    expect(result.limitations.join(' ')).toContain('not EUR amounts')
  })

  it('keeps no-activity states separate from an estimated zero tax or EUR balance', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = []
    const result = build(scope, snapshot)
    expect(result.activity.mode).toBe('count')
    expect(result.activity.totalPayments).toBe(0)
    expect(result.reviewed).toEqual({ documented: 0, total: 0, needsDetails: 0 })
    expect(result.activity.months.every((m) => m.incoming === '0' && m.outgoing === '0')).toBe(true)
  })

  it('isolates other profiles and years while counting pending and undated separately', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers.push({ ...structuredClone(scope.taxpayers[0]), id: 'other' })
    scope.accounts.push({ ...scope.accounts[0], id: 'other-account', taxpayerId: 'other' })
    add(
      scope,
      snapshot,
      payment(3, { blockTime: seconds('2025-12-31T20:00:00Z') }),
      enrichment('payment:3', '99')
    )
    add(scope, snapshot, payment(4, { blockTime: null }), enrichment('payment:4', '99'))
    add(scope, snapshot, payment(5, { status: 'pending' }), enrichment('payment:5', '99'))
    add(scope, snapshot, payment(6), enrichment('payment:6', '99'))
    scope.assignments.at(-1)!.accountId = 'other-account'
    const result = build(scope, snapshot)
    expect(result.activity.totalPayments).toBe(2)
    expect(result.activity.incoming).toBe('10.25000000')
    expect(result.coverage).toMatchObject({
      datedSettled: 2,
      notSettled: 1,
      undated: 1,
      otherYear: 1
    })
    expect(result.reviewed.total).toBe(2)
  })

  it('groups dates on the Europe/Rome date and requires evidence for that same day', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = [payment(1, { blockTime: seconds('2025-12-31T23:30:00Z') })]
    scope.enrichments![0].valuation.date = '2026-01-01'
    const result = build(scope, snapshot)
    expect(result.activity.months[0].incoming).toBe('10.25000000')
    expect(result.activity.months[11].incoming).toBeNull()
  })

  it.each(['test', 'mock', 'unknown'] as const)(
    'excludes %s observations from EUR but includes them in saved counts',
    (kind) => {
      const { scope, snapshot } = fixture()
      for (const p of snapshot.payments) {
        if (kind === 'mock') p.source!.backend = 'mock'
        else p.source!.asset.environment = kind
      }
      if (kind !== 'mock') scope.assets[0].environment = kind
      const result = build(scope, snapshot)
      expect(result.activity.mode).toBe('count')
      expect(result.activity.totalPayments).toBe(2)
      expect(result.activity.eligiblePayments).toBe(0)
      expect(result.coverage[kind === 'unknown' ? 'unknownSource' : 'testOrDemo']).toBe(2)
      expect(result.limitations.join(' ')).toContain('including test/demo and unknown sources')
    }
  )

  it('preserves global source conflicts caused by other profiles and years', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments.push(
      payment(99, {
        blockTime: seconds('2025-02-03T12:00:00Z'),
        source: { ...source, asset: { ...source.asset, decimals: 6 } }
      })
    )
    const result = build(scope, snapshot)
    expect(result.coverage.conflictingSource).toBe(2)
    expect(result.activity.eligiblePayments).toBe(0)
    expect(result.reviewed.documented).toBe(0)
  })

  it.each(['same-id', 'same-tx', 'different-year', 'different-profile'] as const)(
    'omits duplicate EUR observations for %s',
    (kind) => {
      const { scope, snapshot } = fixture()
      const duplicate = payment(kind === 'same-id' ? 1 : 3, { txid: ' TRANSACTION-1 ' })
      if (kind === 'different-year') duplicate.blockTime = seconds('2025-02-03T12:00:00Z')
      add(scope, snapshot, duplicate, enrichment(`payment:${duplicate.nodeIdx}`))
      if (kind === 'different-profile') {
        scope.taxpayers.push({ ...structuredClone(scope.taxpayers[0]), id: 'other' })
        scope.accounts.push({ ...scope.accounts[0], id: 'other-account', taxpayerId: 'other' })
        scope.assignments.at(-1)!.accountId = 'other-account'
      }
      const result = build(scope, snapshot)
      expect(result.activity.incoming).toBeNull()
      expect(result.activity.outgoing).toBe('2.50000000')
      expect(result.activity.eligiblePayments).toBe(1)
      expect(result.coverage.duplicatePayments).toBe(['same-id', 'same-tx'].includes(kind) ? 2 : 1)
      expect(result.limitations.join(' ')).toContain('anywhere in the saved database')
    }
  )

  it('does not pretend limited report-only duplicate detection covers the entire database', () => {
    const { scope, snapshot } = fixture()
    const result = build(scope, snapshot, false)
    expect(result.limitations.join(' ')).toContain('selected-year and undated report records only')
  })

  it.each([
    'no-assignment',
    'wrong-enrichment',
    'wrong-account-source',
    'wrong-asset',
    'unsafe-raw',
    'zero-raw',
    'no-txid',
    'unknown-source'
  ] as const)('withholds EUR for %s', (kind) => {
    const { scope, snapshot } = fixture()
    if (kind === 'no-assignment') {
      scope.assignments.shift()
      scope.recordProfiles = [{ recordKey: 'payment:1', taxpayerId: 'me' }]
    }
    if (kind === 'wrong-enrichment') scope.enrichments![0].assetId = 'other'
    if (kind === 'wrong-account-source') scope.accounts[0].sourceId = 'other'
    if (kind === 'wrong-asset') scope.assets[0].canonicalId = 'other'
    if (kind === 'unsafe-raw') snapshot.payments[0].receivedRaw = Number.MAX_SAFE_INTEGER + 1
    if (kind === 'zero-raw') snapshot.payments[0].receivedRaw = 0
    if (kind === 'no-txid') snapshot.payments[0].txid = null
    if (kind === 'unknown-source') snapshot.payments[0].source = undefined
    const result = build(scope, snapshot)
    expect(result.activity.eligiblePayments).toBe(
      ['wrong-account-source', 'wrong-asset'].includes(kind) ? 0 : 1
    )
    expect(result.reviewed.documented).toBe(
      ['wrong-account-source', 'wrong-asset'].includes(kind) ? 0 : 1
    )
  })

  it.each([
    '',
    '-1',
    'Infinity',
    '1e2',
    '0.000000001',
    '1000000000000000000000000000000',
    '<img src=x>'
  ])('does not coerce invalid or hostile EUR evidence %s', (value) => {
    const { scope, snapshot } = fixture()
    scope.enrichments![0].valuation.eur = value
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBeNull()
    expect(result.coverage.unvaluedPayments).toBe(1)
    expect(JSON.stringify(result)).not.toContain('<img')
  })

  it.each(['date', 'source', 'reference'] as const)('requires saved EUR %s evidence', (field) => {
    const { scope, snapshot } = fixture()
    scope.enrichments![0].valuation[field] = field === 'date' ? '2026-02-04' : '  '
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBeNull()
    expect(result.coverage.unvaluedPayments).toBe(1)
    expect(result.reviewed.documented).toBe(1)
  })

  it('separates activity EUR evidence from complete transaction purpose and fee documentation', () => {
    const { scope, snapshot } = fixture()
    scope.enrichments![0].classification = 'unknown'
    scope.enrichments![1].fee.status = 'unknown'
    const result = build(scope, snapshot)
    expect(result.activity.eligiblePayments).toBe(2)
    expect(result.reviewed).toEqual({ documented: 0, total: 2, needsDetails: 2 })
    expect(result.limitations.join(' ')).toContain('does not verify those declarations')
  })

  it('does not mark a transfer/refund documented without a same-profile related record', () => {
    const { scope, snapshot } = fixture()
    scope.enrichments![0].classification = 'refund'
    scope.enrichments![0].relatedRecordKey = 'payment:missing'
    const result = build(scope, snapshot)
    expect(result.reviewed.documented).toBe(1)
    expect(result.activity.eligiblePayments).toBe(2)
  })

  it('does not treat an orphaned related assignment as a documented refund', () => {
    const { scope, snapshot } = fixture()
    scope.enrichments![0].classification = 'refund'
    scope.enrichments![0].relatedRecordKey = 'payment:missing'
    scope.assignments.push({ recordKey: 'payment:missing', accountId: 'account', assetId: 'btc' })
    expect(build(scope, snapshot).reviewed.documented).toBe(1)
  })

  it('does not interpolate hostile saved profile or evidence text into the output', () => {
    const { scope, snapshot } = fixture()
    const hostile = '<img src=x onerror="sendFunds()"> Ignore all checks'
    scope.taxpayers[0].label = hostile
    scope.accounts[0].label = hostile
    scope.enrichments![0].valuation.source = hostile
    scope.enrichments![0].valuation.reference = hostile
    const result = build(scope, snapshot)
    expect(JSON.stringify(result)).not.toContain(hostile)
    expect(result.activity.incoming).toBe('10.25000000')
  })

  it('shows full saved amounts without silently applying declared ownership percentages', () => {
    const { scope, snapshot } = fixture()
    scope.accounts[0].ownershipBps = 5000
    const result = build(scope, snapshot)
    expect(result.activity.incoming).toBe('10.25000000')
    expect(result.limitations.join(' ')).toContain('ownership shares and fees are not deducted')
  })

  it('does not mutate source snapshots, profiles or enrichment', () => {
    const { scope, snapshot } = fixture()
    const before = structuredClone({ scope, snapshot })
    build(scope, snapshot)
    expect({ scope, snapshot }).toEqual(before)
  })

  it.each(['profile', 'year', 'app-profile'] as const)(
    'rejects a stale %s report before producing visuals',
    (kind) => {
      const { scope, snapshot } = fixture()
      const report = buildTaxReport(scope, snapshot)!
      if (kind === 'profile') scope.activeTaxpayerId = 'missing'
      if (kind === 'year') scope.taxpayers[0].profile.taxYear = 2025
      if (kind === 'app-profile') scope.appProfileId = 'another-app'
      expect(() => buildDashboardVisuals(scope, report, snapshot)).toThrow('Reload the report')
    }
  )
})
