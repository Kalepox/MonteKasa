import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
import { emptyValuation, type TaxEnrichment } from '../../shared/tax-enrichment'
import type { TaxScope } from '../../shared/tax-scope'
import { buildTaxDashboard } from './tax-dashboard'
import { buildTaxReport } from './tax-report'

const source: LedgerSource = {
  id: 'saved-btc',
  label: 'Saved Bitcoin',
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
const date = seconds('2026-02-02T10:00:00Z')
function payment(nodeIdx: number, changes: Partial<KasaPayment> = {}): KasaPayment {
  return {
    nodeIdx,
    invoiceId: null,
    direction: 'in',
    received: 9,
    receivedRaw: 1,
    status: 'settled',
    txid: `fixture-tx-${nodeIdx}`,
    blockTime: date,
    source,
    ...changes
  }
}
function invoice(id: string, changes: Partial<KasaInvoice> = {}): KasaInvoice {
  return {
    id,
    client: 'Fixture client',
    amount: 999,
    amountRaw: 99900000000,
    received: 888,
    receivedRaw: 88800000000,
    state: 'Paid',
    createdAt: date,
    expiresAt: date + 86400,
    rgbInvoice: 'fixture invoice',
    recipientId: 'fixture recipient',
    source,
    ...changes
  }
}
function fixture(): { scope: TaxScope; snapshot: KasaSnapshot } {
  return {
    scope: {
      version: 1,
      databaseId: 'fixture-db',
      activeTaxpayerId: 'me',
      taxpayers: [
        {
          id: 'me',
          label: 'My profile',
          profile: {
            version: 1,
            country: 'IT',
            taxYear: 2026,
            userType: 'personal',
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
          label: 'Saved account',
          ownershipBps: 10000,
          kind: 'unknown'
        }
      ],
      assets: [{ id: 'btc', ...source.asset }],
      assignments: [
        { recordKey: 'invoice:inv', accountId: 'account', assetId: 'btc' },
        { recordKey: 'payment:1', accountId: 'account', assetId: 'btc' },
        { recordKey: 'payment:2', accountId: 'account', assetId: 'btc' }
      ]
    },
    snapshot: {
      invoices: [invoice('inv')],
      payments: [payment(1), payment(2, { direction: 'out', receivedRaw: 2 })],
      proposals: []
    }
  }
}
function build(scope: TaxScope, snapshot: KasaSnapshot): ReturnType<typeof buildTaxDashboard> {
  return buildTaxDashboard(scope, buildTaxReport(scope, snapshot)!)
}
function assign(scope: TaxScope, ...keys: string[]): void {
  scope.assignments.push(
    ...keys.map((recordKey) => ({ recordKey, accountId: 'account', assetId: 'btc' }))
  )
}
function completeEntry(recordKey: string): TaxEnrichment {
  return {
    recordKey,
    accountId: 'account',
    assetId: 'btc',
    classification: 'purchase',
    valuation: { eur: '2', date: '2026-02-02', source: 'statement', reference: 'fixture evidence' },
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

describe('database-only selected-year Overview model', () => {
  it('shows exact settled payment amounts and separate record counts, never invoice money', () => {
    const { scope, snapshot } = fixture()
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts).toEqual({
      invoices: 1,
      payments: 2,
      settledIncoming: 1,
      settledOutgoing: 1,
      notSettled: 0
    })
    expect(dashboard.groups[0].incoming).toEqual({
      amount: '0.00000001',
      records: 1,
      unavailable: 0
    })
    expect(dashboard.groups[0].outgoing.amount).toBe('0.00000002')
    expect(JSON.stringify(dashboard)).not.toContain('999')
    expect(JSON.stringify(dashboard)).not.toContain('888')
    expect(dashboard.groups[0]).not.toHaveProperty('requested')
    expect(dashboard.groups[0]).not.toHaveProperty('received')
  })

  it('does not show payment totals for invoice-only source groups', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = []
    const dashboard = build(scope, snapshot)
    expect(dashboard.groups).toEqual([])
    expect(dashboard.counts.invoices).toBe(1)
    expect(dashboard.counts.payments).toBe(0)
    expect(
      dashboard.months.every((month) => month.incoming + month.outgoing + month.notSettled === 0)
    ).toBe(true)
  })

  it('keeps large integer sums exact without using legacy display amounts', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = [
      payment(1, { receivedRaw: Number.MAX_SAFE_INTEGER }),
      payment(2, { receivedRaw: Number.MAX_SAFE_INTEGER })
    ]
    const dashboard = build(scope, snapshot)
    expect(dashboard.groups[0].incoming.amount).toBe('180143985.09481982')
    expect(dashboard.groups[0].outgoing.amount).toBeNull()
  })

  it('keeps BTC and token sources separate without a currency total', () => {
    const { scope, snapshot } = fixture()
    const token: LedgerSource = {
      ...source,
      id: 'token',
      label: 'Token source',
      asset: {
        symbol: 'USDT',
        canonicalId: 'token-id',
        network: 'ethereum',
        decimals: 6,
        environment: 'live'
      }
    }
    snapshot.payments[1] = payment(2, { source: token, receivedRaw: 1234567 })
    const dashboard = build(scope, snapshot)
    expect(dashboard.groups).toHaveLength(2)
    expect(dashboard.groups.map((group) => group.incoming.amount)).toEqual([
      '0.00000001',
      '1.234567'
    ])
    expect(dashboard).not.toHaveProperty('total')
    expect(dashboard).not.toHaveProperty('eur')
  })

  it('withholds unknown-source and unsafe raw amounts instead of treating them as zero', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = [
      payment(1, { source: undefined }),
      payment(2, { receivedRaw: Number.MAX_SAFE_INTEGER + 1 })
    ]
    const dashboard = build(scope, snapshot)
    expect(dashboard.groups).toHaveLength(2)
    expect(dashboard.groups.every((group) => group.incoming.amount === null)).toBe(true)
    expect(dashboard.groups.every((group) => group.incoming.unavailable === 1)).toBe(true)
    expect(dashboard.counts.settledIncoming).toBe(2)
  })

  it('carries global source conflicts through from records outside the selected year and profile', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments.push(
      payment(99, {
        blockTime: seconds('2024-04-01T12:00:00Z'),
        source: { ...source, asset: { ...source.asset, decimals: 6 } }
      })
    )
    const dashboard = build(scope, snapshot)
    expect(dashboard.groups[0].conflict).toBe(true)
    expect(dashboard.groups[0].incoming.amount).toBeNull()
    expect(dashboard.groups[0].outgoing.amount).toBeNull()
    expect(dashboard.coverage.unassigned).toBe(1)
    expect(dashboard.counts.payments).toBe(2)
  })

  it('groups months using Europe/Rome and keeps pending and failed out of settled counts and totals', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments = [
      payment(1, { blockTime: seconds('2025-12-31T23:30:00Z') }),
      payment(2, { direction: 'out', blockTime: seconds('2026-01-31T23:30:00Z') }),
      payment(3, {
        status: 'pending',
        receivedRaw: 999999,
        blockTime: seconds('2026-03-31T22:30:00Z')
      }),
      payment(4, {
        status: 'failed',
        receivedRaw: 999999,
        blockTime: seconds('2026-03-31T22:30:00Z')
      }),
      payment(5, { blockTime: seconds('2026-12-31T23:30:00Z') })
    ]
    assign(scope, 'payment:3', 'payment:4', 'payment:5')
    const dashboard = build(scope, snapshot)
    expect(dashboard.months).toHaveLength(12)
    expect(dashboard.months[0]).toEqual({
      month: 1,
      label: 'Jan',
      incoming: 1,
      outgoing: 0,
      notSettled: 0
    })
    expect(dashboard.months[1]).toEqual({
      month: 2,
      label: 'Feb',
      incoming: 0,
      outgoing: 1,
      notSettled: 0
    })
    expect(dashboard.months[3].notSettled).toBe(2)
    expect(dashboard.counts).toMatchObject({
      payments: 4,
      settledIncoming: 1,
      settledOutgoing: 1,
      notSettled: 2
    })
    expect(dashboard.groups[0].incoming.amount).toBe('0.00000001')
    expect(dashboard.groups[0].notSettled).toBe(2)
    expect(dashboard.coverage.otherYearPayments).toBe(1)
  })

  it('isolates other profiles, invalid assignments and other years from details and requirements', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers.push({
      ...structuredClone(scope.taxpayers[0]),
      id: 'other',
      label: 'Other taxpayer'
    })
    scope.accounts.push({ ...scope.accounts[0], id: 'other-account', taxpayerId: 'other' })
    snapshot.payments.push(
      payment(3),
      payment(4),
      payment(5, { blockTime: seconds('2024-01-01T10:00:00Z') })
    )
    scope.assignments.push({ recordKey: 'payment:3', accountId: 'other-account', assetId: 'btc' })
    scope.assignments.push({ recordKey: 'payment:4', accountId: 'account', assetId: 'missing' })
    assign(scope, 'payment:5')
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts.payments).toBe(2)
    expect(dashboard.estimates[0].missing).toContain(
      '3 record(s) need a transaction classification.'
    )
    expect(
      dashboard.nextSteps.every(
        (step) => !['payment:3', 'payment:4', 'payment:5'].includes(step.recordKey ?? '')
      )
    ).toBe(true)
    expect(dashboard.coverage.otherYearPayments).toBe(1)
    expect(dashboard.coverage.unassigned).toBe(1)
  })

  it('keeps undated records separate from monthly counts and prioritises one for review', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[0].blockTime = null
    snapshot.invoices[0].createdAt = NaN
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts).toMatchObject({ invoices: 0, payments: 1, settledIncoming: 0 })
    expect(dashboard.coverage).toMatchObject({ undatedInvoices: 1, undatedPayments: 1 })
    expect(dashboard.groups[0].incoming.amount).toBeNull()
    expect(dashboard.nextSteps.find((step) => step.target === 'enrichment-title')?.recordKey).toBe(
      'invoice:inv'
    )
    expect(dashboard.estimates[0].missing).toContain(
      '3 record(s) need a transaction classification.'
    )
  })

  it('reports ownership coverage without scaling saved payment amounts', () => {
    const { scope, snapshot } = fixture()
    scope.accounts[0].ownershipBps = 5000
    scope.accounts.push({ ...scope.accounts[0], id: 'unknown', ownershipBps: null })
    const dashboard = build(scope, snapshot)
    expect(dashboard.coverage).toMatchObject({ partialOwnership: 1, unknownOwnership: 1 })
    expect(dashboard.groups[0].incoming.amount).toBe('0.00000001')
    expect(
      dashboard.nextSteps.find((step) => step.target === 'scope-accounts-title')?.description
    ).toContain('full saved amounts')
  })

  it('never marks complete declarations as calculation-ready or supplies a numeric tax amount', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers[0].profile.recordsCoverage = 'complete'
    scope.enrichments = scope.assignments.map((assignment) => completeEntry(assignment.recordKey))
    const dashboard = build(scope, snapshot)
    const applicable = dashboard.estimates.filter((entry) => entry.status === 'missing-data')
    expect(applicable.length).toBeGreaterThan(0)
    expect(
      applicable.every((entry) => entry.label === 'Not yet estimable' && entry.missing.length > 0)
    ).toBe(true)
    expect(dashboard.estimates.every((entry) => !('amount' in entry))).toBe(true)
    expect(dashboard.estimates[0].missing.join(' ')).toContain('unverified')
    expect(dashboard.coverage.historyNote).toContain('not been independently verified')
    expect(dashboard.nextSteps.map((step) => step.target)).toEqual(['scope-checklist-title'])
  })

  it('distinguishes personal, business and forfettario calculation applicability', () => {
    const { scope, snapshot } = fixture()
    let dashboard = build(scope, snapshot)
    const status = (calculation: string): string | undefined =>
      dashboard.estimates.find((entry) => entry.calculation === calculation)?.status
    expect(status('Personal gains and losses')).toBe('missing-data')
    expect(status('Business income')).toBe('not-applicable')
    expect(status('VAT')).toBe('not-applicable')
    scope.taxpayers[0].profile = {
      ...scope.taxpayers[0].profile,
      userType: 'business',
      personalRegime: null,
      businessType: 'sole-trader',
      businessRegime: 'forfettario'
    }
    dashboard = build(scope, snapshot)
    expect(status('Personal gains and losses')).toBe('not-applicable')
    expect(status('Business income')).toBe('missing-data')
    expect(status('VAT')).toBe('missing-data')
    expect(status('Forfettario')).toBe('missing-data')
    expect(
      dashboard.estimates.find((entry) => entry.calculation === 'Forfettario')?.explanation
    ).toContain('not verified eligibility')
  })

  it('allows record review for unsupported countries without implying supported estimates', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers[0].profile.country = 'other'
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts.payments).toBe(2)
    expect(
      dashboard.estimates.every(
        (entry) => entry.status === 'unsupported' && entry.label === 'Unsupported country'
      )
    ).toBe(true)
    expect(dashboard.nextSteps[0].description).toContain('not supported')
  })

  it('ignores stale enrichment scope and keeps next steps concise with existing navigation targets', () => {
    const { scope, snapshot } = fixture()
    scope.enrichments = scope.assignments.map((assignment) => ({
      ...completeEntry(assignment.recordKey),
      accountId: 'wrong-account'
    }))
    snapshot.payments.push(payment(3))
    const dashboard = build(scope, snapshot)
    expect(dashboard.estimates[0].missing).toContain(
      '3 record(s) need a transaction classification.'
    )
    expect(dashboard.nextSteps).toHaveLength(4)
    expect(dashboard.nextSteps.map((step) => step.target)).toEqual([
      'scope-history-form',
      'tax-activity-title',
      'enrichment-title',
      'scope-checklist-title'
    ])
    expect(dashboard.nextSteps[1].description).toContain('may belong to another profile')
  })

  it('rejects a report from another selection, year or database', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    expect(() => buildTaxDashboard({ ...scope, activeTaxpayerId: undefined }, report)).toThrow(
      'Reload'
    )
    expect(() => buildTaxDashboard({ ...scope, databaseId: 'other-database' }, report)).toThrow(
      'Reload'
    )
    scope.taxpayers[0].profile.taxYear = 2025
    expect(() => buildTaxDashboard(scope, report)).toThrow('Reload')
  })

  it('rejects stale app selection even when taxpayer and year are unchanged', () => {
    const { scope, snapshot } = fixture()
    scope.appProfileId = 'app-one'
    const report = buildTaxReport(scope, snapshot)!
    expect(buildTaxDashboard(scope, report).scopeKey).toBe(report.scopeKey)
    for (const appProfileId of ['app-two', null, ''])
      expect(() => buildTaxDashboard({ ...scope, appProfileId }, report)).toThrow('Reload')
    expect(() => buildTaxDashboard(scope, { ...report, year: 2025 })).toThrow('Reload')
    expect(() =>
      buildTaxDashboard(scope, { ...report, taxpayer: { ...report.taxpayer, id: 'other' } })
    ).toThrow('Reload')
  })

  it('does not mutate saved declarations, records or the shared Reports model', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    const before = structuredClone({ scope, snapshot, report })
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      Object.freeze(value)
      Object.values(value).forEach(freeze)
    }
    freeze(scope)
    freeze(snapshot)
    freeze(report)
    expect(() => buildTaxDashboard(scope, report)).not.toThrow()
    expect({ scope, snapshot, report }).toEqual(before)
  })

  it('counts and charts profile-linked activity before account and asset setup without implying tax readiness', () => {
    const { scope, snapshot } = fixture()
    scope.recordProfiles = scope.assignments.map(({ recordKey }) => ({
      recordKey,
      taxpayerId: 'me'
    }))
    scope.assignments = []
    scope.accounts = []
    scope.assets = []
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts).toEqual({
      invoices: 1,
      payments: 2,
      settledIncoming: 1,
      settledOutgoing: 1,
      notSettled: 0
    })
    expect(dashboard.months[1]).toMatchObject({ incoming: 1, outgoing: 1, notSettled: 0 })
    expect(dashboard.groups[0].incoming.amount).toBe('0.00000001')
    expect(dashboard.coverage).toMatchObject({ profileOnly: 3, unassigned: 0 })
    expect(dashboard.nextSteps.find((step) => step.target === 'tax-activity-title')).toMatchObject({
      title: 'Review linked records',
      description: expect.stringContaining('account, asset and ownership still need review')
    })
    expect(dashboard.nextSteps.every((step) => !step.recordKey)).toBe(true)
    expect(
      dashboard.estimates
        .filter((entry) => entry.status !== 'not-applicable')
        .every((entry) => entry.status === 'missing-data' && entry.label === 'Not yet estimable')
    ).toBe(true)
    expect(dashboard.estimates.every((entry) => !('amount' in entry))).toBe(true)
    expect(dashboard.estimates[0].missing).toContain(
      'Some records are linked to this profile without account and asset details. Confirm those details and ownership before using them in tax calculations.'
    )
  })

  it('routes linked records needing account review to Activity and only opens assigned records for enrichment', () => {
    const { scope, snapshot } = fixture()
    scope.assignments = scope.assignments.filter((entry) => entry.recordKey === 'payment:2')
    scope.recordProfiles = [
      { recordKey: 'invoice:inv', taxpayerId: 'me' },
      { recordKey: 'payment:1', taxpayerId: 'me' }
    ]
    snapshot.invoices[0].createdAt = NaN
    snapshot.payments[0].source = undefined
    snapshot.payments[0].blockTime = null
    const dashboard = build(scope, snapshot)
    expect(dashboard.coverage).toMatchObject({
      profileOnly: 2,
      undatedInvoices: 1,
      undatedPayments: 1
    })
    expect(dashboard.counts.payments).toBe(1)
    expect(dashboard.nextSteps.find((step) => step.target === 'enrichment-title')?.recordKey).toBe(
      'payment:2'
    )
    expect(dashboard.nextSteps.find((step) => step.target === 'tax-activity-title')).toBeDefined()
  })

  it('excludes other-profile and other-year profile links from annual charts and coverage requirements', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers.push({ ...structuredClone(scope.taxpayers[0]), id: 'other', label: 'Other' })
    scope.assignments = []
    scope.recordProfiles = [
      { recordKey: 'invoice:inv', taxpayerId: 'other' },
      { recordKey: 'payment:1', taxpayerId: 'me' },
      { recordKey: 'payment:2', taxpayerId: 'other' },
      { recordKey: 'payment:3', taxpayerId: 'me' }
    ]
    snapshot.payments.push(payment(3, { blockTime: seconds('2025-02-02T10:00:00Z') }))
    const dashboard = build(scope, snapshot)
    expect(dashboard.counts).toMatchObject({ invoices: 0, payments: 1, settledOutgoing: 0 })
    expect(dashboard.coverage).toMatchObject({
      profileOnly: 1,
      otherYearPayments: 1,
      unassigned: 0
    })
    expect(dashboard.months[1]).toMatchObject({ incoming: 1, outgoing: 0 })
  })
})
