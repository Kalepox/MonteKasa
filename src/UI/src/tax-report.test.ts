import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
import type { TaxProfile } from '../../shared/tax-profile'
import type { TaxScope } from '../../shared/tax-scope'
import { buildTaxReport, taxReportCsv } from './tax-report'

const seconds = (date: string): number => Date.parse(date) / 1000
const current = seconds('2026-06-01T12:00:00Z')
const previous = seconds('2025-06-01T12:00:00Z')
const bitcoin: LedgerSource = {
  id: 'saved-bitcoin',
  label: 'Saved Bitcoin source',
  backend: 'wdk',
  asset: {
    symbol: 'BTC',
    canonicalId: 'bitcoin',
    network: 'bitcoin',
    decimals: 8,
    environment: 'live'
  }
}
const profile: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'incomplete'
}

function invoice(id: string, createdAt = current): KasaInvoice {
  return {
    id,
    client: `Client ${id}`,
    amount: 1,
    amountRaw: 100000000,
    received: 9,
    receivedRaw: 900000000,
    state: 'Overpaid',
    createdAt,
    expiresAt: createdAt + 86400,
    rgbInvoice: 'fixture invoice',
    recipientId: 'fixture recipient',
    source: bitcoin
  }
}
function payment(
  nodeIdx: number,
  invoiceId: string | null,
  blockTime: number | null = current
): KasaPayment {
  return {
    nodeIdx,
    invoiceId,
    direction: 'in',
    received: 1,
    receivedRaw: 100000000,
    status: 'settled',
    txid: `fixture-tx-${nodeIdx}`,
    blockTime,
    source: bitcoin
  }
}

function fixture(): { scope: TaxScope; snapshot: KasaSnapshot } {
  const scope: TaxScope = {
    version: 1,
    databaseId: 'fixture-database',
    activeTaxpayerId: 'personal',
    taxpayers: [
      { id: 'personal', label: 'My personal profile', profile: { ...profile } },
      {
        id: 'business',
        label: 'Other business',
        profile: {
          ...profile,
          userType: 'business',
          personalRegime: null,
          businessType: 'company',
          businessRegime: 'ordinary'
        }
      }
    ],
    accounts: [
      {
        id: 'mine',
        taxpayerId: 'personal',
        label: 'Mine',
        ownershipBps: 10000,
        kind: 'self-custody'
      },
      {
        id: 'theirs',
        taxpayerId: 'business',
        label: 'Theirs',
        ownershipBps: 10000,
        kind: 'provider'
      }
    ],
    assets: [{ id: 'btc', ...bitcoin.asset }],
    assignments: [
      ...['own', 'prior', 'undated'].map((id) => ({
        recordKey: `invoice:${id}`,
        accountId: 'mine',
        assetId: 'btc'
      })),
      ...[1, 2, 5, 6].map((id) => ({
        recordKey: `payment:${id}`,
        accountId: 'mine',
        assetId: 'btc'
      })),
      { recordKey: 'invoice:foreign', accountId: 'theirs', assetId: 'btc' },
      { recordKey: 'payment:3', accountId: 'theirs', assetId: 'btc' }
    ]
  }
  const snapshot: KasaSnapshot = {
    invoices: [
      invoice('own'),
      invoice('prior', previous),
      invoice('foreign'),
      invoice('unassigned'),
      invoice('undated', NaN)
    ],
    payments: [
      payment(1, 'prior'),
      payment(2, 'own'),
      payment(3, 'foreign'),
      payment(4, null),
      payment(5, 'own', null),
      payment(6, 'own', previous)
    ],
    proposals: []
  }
  return { scope, snapshot }
}

describe('selected taxpayer and tax-year Reports', () => {
  it('includes only valid assignments owned by the saved active taxpayer and the saved year', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    expect(report.taxpayer.id).toBe('personal')
    expect(report.year).toBe(2026)
    expect(report.scopeKey).toBe(JSON.stringify(['fixture-database', 'personal', 2026]))
    expect(report.review.invoices.map((row) => row.id)).toEqual(['own'])
    expect(report.review.payments.map((row) => row.nodeIdx)).toEqual([1, 2])
    expect(report.review).toMatchObject({ excludedInvoices: 1, excludedPayments: 1 })
    expect(report.unassigned).toBe(2)
    expect(report.summary.invoiceCount).toBe(1)
    expect(report.summary.groups[0].requested.amount).toBe('1.00000000')
    expect(report.summary.groups[0].incoming.amount).toBe('2.00000000')
    expect(report.rows.map((row) => row.id)).toEqual(['own', '1', '2', 'undated', '5'])
  })

  it('does not select a fallback taxpayer or legacy profile when no valid selection exists', () => {
    const { scope, snapshot } = fixture()
    for (const activeTaxpayerId of [undefined, '', 'missing'])
      expect(buildTaxReport({ ...scope, activeTaxpayerId }, snapshot)).toBeNull()
    for (const appProfileId of [null, ''])
      expect(buildTaxReport({ ...scope, appProfileId }, snapshot)).toBeNull()
  })

  it('uses the app profile identity and keeps two profiles and saved years separate without changing records', () => {
    const { scope, snapshot } = fixture()
    scope.appProfileId = 'app-personal'
    const personal = scope.taxpayers[0]
    personal.yearProfiles = [{ ...personal.profile, taxYear: 2025 }, { ...personal.profile }]
    const before = structuredClone({ scope, snapshot })
    const report = buildTaxReport(scope, snapshot)!
    const priorScope = {
      ...scope,
      taxpayers: [{ ...personal, profile: personal.yearProfiles[0] }, scope.taxpayers[1]]
    }
    const prior = buildTaxReport(priorScope, snapshot)!
    const business = buildTaxReport(
      { ...scope, appProfileId: 'app-business', activeTaxpayerId: 'business' },
      snapshot
    )!
    expect(report.scopeKey).toBe(
      JSON.stringify(['fixture-database', 'app-personal', 'personal', 2026])
    )
    expect(new Set([report.scopeKey, prior.scopeKey, business.scopeKey]).size).toBe(3)
    expect(prior.review.payments.map((row) => row.nodeIdx)).toEqual([6])
    expect(business.review.payments.map((row) => row.nodeIdx)).toEqual([3])
    expect(taxReportCsv(prior)).not.toContain('Client foreign')
    expect({ scope, snapshot }).toEqual(before)
  })

  it('uses all selected-profile accounts and assets without inferring a different owner from invoice links', () => {
    const { scope, snapshot } = fixture()
    const usdt = {
      ...bitcoin,
      id: 'saved-usdt',
      asset: { ...bitcoin.asset, symbol: 'USDT', canonicalId: 'usdt', decimals: 6 }
    }
    scope.accounts.push({
      id: 'second',
      taxpayerId: 'personal',
      label: 'Second',
      ownershipBps: 5000,
      kind: 'unknown'
    })
    scope.assets.push({ id: 'usdt', ...usdt.asset })
    scope.assignments.push({ recordKey: 'payment:7', accountId: 'second', assetId: 'usdt' })
    snapshot.payments.push({ ...payment(7, 'foreign'), source: usdt, receivedRaw: 1250000 })
    const report = buildTaxReport(scope, snapshot)!
    expect(report.summary.groups).toHaveLength(2)
    expect(
      report.summary.groups.find((group) => group.source?.id === 'saved-usdt')?.incoming.amount
    ).toBe('1.250000')
    expect(report.rows.find((row) => row.id === '7')).toMatchObject({
      client: '',
      invoiceId: 'foreign',
      amount: '1.250000'
    })
    expect(report.summary.unlinked).toBe(1)
  })

  it('keeps same-owner prior-year invoice context but never borrows another taxpayer or unassigned client', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[1].invoiceId = 'foreign'
    snapshot.payments.push(payment(7, 'unassigned'))
    scope.assignments.push({ recordKey: 'payment:7', accountId: 'mine', assetId: 'btc' })
    const report = buildTaxReport(scope, snapshot)!
    expect(report.rows.find((row) => row.id === '1')).toMatchObject({
      client: 'Client prior',
      invoiceId: 'prior'
    })
    expect(report.rows.find((row) => row.id === '2')?.client).toBe('')
    expect(report.rows.find((row) => row.id === '7')?.client).toBe('')
    expect(report.summary.unlinked).toBe(2)
    const csv = taxReportCsv(report)
    expect(csv).not.toContain('Client foreign')
    expect(csv).not.toContain('Client unassigned')
  })

  it('keeps assigned undated records in review without including them in annual totals', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    expect(report.review.undatedInvoices.map((row) => row.id)).toEqual(['undated'])
    expect(report.review.undatedPayments.map((row) => row.nodeIdx)).toEqual([5])
    expect(report.rows.filter((row) => row.date === '').map((row) => row.type)).toEqual([
      'Undated invoice — year unassigned',
      'Undated payment — year unassigned'
    ])
    expect(report.summary.groups[0]).toMatchObject({ invoiceCount: 1, paymentCount: 2 })
    expect(taxReportCsv(report)).toContain('excluded from year totals')
  })

  it('uses Europe/Rome boundaries and filters invoice dates separately from payment dates', () => {
    const { scope, snapshot } = fixture()
    snapshot.invoices[0].createdAt = seconds('2025-12-31T22:59:59Z')
    snapshot.payments[0].blockTime = seconds('2025-12-31T23:00:00Z')
    snapshot.payments[1].blockTime = seconds('2026-12-31T23:00:00Z')
    const report = buildTaxReport(scope, snapshot)!
    expect(report.review.invoices).toEqual([])
    expect(report.review.payments.map((row) => row.nodeIdx)).toEqual([1])
    expect(report.summary.groups[0].incoming.amount).toBe('1.00000000')
  })

  it('changes scope keys and record sets when the saved taxpayer, year or database changes', () => {
    const { scope, snapshot } = fixture()
    const first = buildTaxReport(scope, snapshot)!
    const other = buildTaxReport({ ...scope, activeTaxpayerId: 'business' }, snapshot)!
    expect(other.rows.map((row) => row.id)).toEqual(['foreign', '3'])
    scope.taxpayers[0].profile.taxYear = 2025
    const prior = buildTaxReport(scope, snapshot)!
    expect(prior.review.invoices.map((row) => row.id)).toEqual(['prior'])
    expect(prior.review.payments.map((row) => row.nodeIdx)).toEqual([6])
    expect(
      new Set([
        first.scopeKey,
        other.scopeKey,
        prior.scopeKey,
        buildTaxReport({ ...scope, databaseId: 'another' }, snapshot)!.scopeKey
      ]).size
    ).toBe(4)
  })

  it('never exposes cumulative invoice receipts as year receipts', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    for (const group of report.summary.groups) expect(group).not.toHaveProperty('received')
    expect(report.rows.find((row) => row.id === 'own')?.amount).toBe('1.00000000')
    const csv = taxReportCsv(report)
    expect(csv).not.toContain('9.00000000')
    expect(csv).not.toContain('900000000')
    expect(csv).toContain('Cumulative invoice receipts are omitted')
  })

  it('keeps conflicts found in another taxpayer and year from becoming safe after filtering', () => {
    const { scope, snapshot } = fixture()
    snapshot.invoices[2] = {
      ...snapshot.invoices[2],
      createdAt: previous,
      source: { ...bitcoin, asset: { ...bitcoin.asset, decimals: 6 } }
    }
    const report = buildTaxReport(scope, snapshot)!
    expect(report.summary.groups[0]).toMatchObject({
      conflict: true,
      incoming: { amount: null },
      requested: { amount: null }
    })
    expect(
      report.rows.every((row) => row.sourceStatus === 'conflict' && row.amount === 'Unavailable')
    ).toBe(true)
    expect(taxReportCsv(report)).toContain('100000000')
    expect(taxReportCsv(report)).not.toContain('Client foreign')
  })

  it('counts missing account/asset/owner assignments as unassigned and selected-profile orphan references separately', () => {
    const { scope, snapshot } = fixture()
    scope.assignments.push(
      { recordKey: 'invoice:unassigned', accountId: 'missing', assetId: 'btc' },
      { recordKey: 'payment:4', accountId: 'mine', assetId: 'missing' },
      { recordKey: 'payment:absent', accountId: 'mine', assetId: 'btc' },
      { recordKey: 'invoice:absent-foreign', accountId: 'theirs', assetId: 'btc' }
    )
    let report = buildTaxReport(scope, snapshot)!
    expect(report.unassigned).toBe(2)
    expect(report.orphaned).toBe(1)
    expect(report.rows.some((row) => row.id === '4' || row.id === 'unassigned')).toBe(false)
    scope.accounts.push({
      id: 'invalid-owner',
      taxpayerId: 'missing',
      label: 'Orphan owner',
      ownershipBps: 10000,
      kind: 'unknown'
    })
    scope.assignments[
      scope.assignments.findIndex((assignment) => assignment.recordKey === 'payment:3')
    ].accountId = 'invalid-owner'
    report = buildTaxReport(scope, snapshot)!
    expect(report.unassigned).toBe(3)
  })

  it('reports partial and unknown ownership without scaling saved amounts', () => {
    const { scope, snapshot } = fixture()
    scope.accounts[0].ownershipBps = 5000
    scope.accounts.push({
      id: 'unconfirmed',
      taxpayerId: 'personal',
      label: 'Unconfirmed',
      ownershipBps: null,
      kind: 'unknown'
    })
    scope.accounts[1].ownershipBps = null
    const report = buildTaxReport(scope, snapshot)!
    expect(report.partialOwnership).toBe(1)
    expect(report.unknownOwnership).toBe(1)
    expect(report.summary.groups[0].incoming.amount).toBe('2.00000000')
    expect(taxReportCsv(report)).toContain(
      'Full saved amounts are shown; ownership shares are not applied'
    )
  })

  it('preserves pending/failed/outbound status and totals only saved settled observations', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[0].status = 'pending'
    snapshot.payments[1].direction = 'out'
    const report = buildTaxReport(scope, snapshot)!
    expect(report.summary.unsettled).toBe(1)
    expect(report.summary.groups[0].incoming.amount).toBeNull()
    expect(report.summary.groups[0].outgoing.amount).toBe('1.00000000')
    expect(report.rows.find((row) => row.id === '1')?.status).toBe('pending')
    expect(report.rows.find((row) => row.id === '2')?.direction).toBe('out')
  })

  it('exports profile metadata and source evidence with safe CSV escaping and every review row', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers[0].label = 'Profile "personal", one'
    snapshot.invoices[0].client = '=SUM(1),"unsafe"'
    for (let id = 7; id < 110; id++) {
      snapshot.payments.push(payment(id, null))
      scope.assignments.push({ recordKey: `payment:${id}`, accountId: 'mine', assetId: 'btc' })
    }
    const report = buildTaxReport(scope, snapshot)!
    const csv = taxReportCsv(report)
    expect(csv).toContain(
      'Taxpayer: Profile ""personal"", one; ID: personal; type: personal; saved tax year: 2026'
    )
    expect(csv).toContain('"\'=SUM(1),""unsafe"""')
    expect(csv).toContain('"Payment observation in year","109"')
    expect(csv).toContain(
      '"saved-bitcoin","Saved Bitcoin source","wdk","bitcoin","bitcoin","live","8","saved"'
    )
    expect(csv).toContain(
      'Database-wide records without a valid profile relationship or assignment excluded: 2'
    )
    expect(csv).toContain('No EUR conversion or tax liability calculated')
    expect(csv).not.toContain('Client foreign')
    expect(csv).not.toContain('Client unassigned')
    expect(csv).not.toContain('"Invoice issued in year","prior"')
  })

  it('can review saved records for other countries without claiming supported tax calculations', () => {
    const { scope, snapshot } = fixture()
    scope.taxpayers[0].profile.country = 'other'
    const report = buildTaxReport(scope, snapshot)!
    expect(report.rows.length).toBeGreaterThan(0)
    expect(taxReportCsv(report)).toContain('country: other')
    expect(taxReportCsv(report)).toContain('Not a tax calculation')
  })

  it('keeps an empty selected profile empty and never fills it with another owner’s records', () => {
    const { scope, snapshot } = fixture()
    scope.assignments = scope.assignments.filter((assignment) => assignment.accountId !== 'mine')
    const report = buildTaxReport(scope, snapshot)!
    expect(report.rows).toEqual([])
    expect(report.summary.groups).toEqual([])
    expect(report.summary.invoiceCount).toBe(0)
    expect(taxReportCsv(report)).not.toContain('Client foreign')
  })

  it('reads frozen saved declarations and records without modifying them or any external data', () => {
    const { scope, snapshot } = fixture()
    const before = structuredClone({ scope, snapshot })
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
      }
    }
    freeze(scope)
    freeze(snapshot)
    expect(taxReportCsv(buildTaxReport(scope, snapshot)!)).toContain('My personal profile')
    expect({ scope, snapshot }).toEqual(before)
  })

  it('shows profile-linked BTC, token and unknown-source records without inventing account or asset declarations', () => {
    const { scope, snapshot } = fixture()
    const token: LedgerSource = {
      ...bitcoin,
      id: 'saved-token',
      asset: { ...bitcoin.asset, symbol: 'USDT', canonicalId: 'usdt', decimals: 6 }
    }
    scope.accounts = []
    scope.assets = []
    scope.assignments = []
    scope.recordProfiles = ['invoice:own', 'payment:1', 'payment:4', 'payment:7'].map(
      (recordKey) => ({ recordKey, taxpayerId: 'personal' })
    )
    snapshot.payments[3].source = undefined
    snapshot.payments.push({ ...payment(7, null), source: token, receivedRaw: 1234567 })
    const before = structuredClone({ scope, snapshot })
    const report = buildTaxReport(scope, snapshot)!
    expect(report.profileOnly).toBe(4)
    expect(report.review.payments.map((entry) => entry.nodeIdx)).toEqual([1, 4, 7])
    expect(report.summary.groups.map((group) => group.incoming.amount)).toEqual([
      '1.00000000',
      null,
      '1.234567'
    ])
    expect(report.rows.find((row) => row.id === '4')).toMatchObject({
      amount: '1.000000',
      unit: 'recorded app units',
      amountRaw: '100000000',
      decimals: '',
      sourceStatus: 'unknown'
    })
    expect(taxReportCsv(report)).toContain('still need account, asset and ownership review: 4')
    expect({ scope, snapshot }).toEqual(before)
  })

  it('isolates explicit profile links and lets existing assignment ownership prevail without duplicate rows', () => {
    const { scope, snapshot } = fixture()
    scope.recordProfiles = [
      { recordKey: 'invoice:own', taxpayerId: 'personal' },
      { recordKey: 'invoice:unassigned', taxpayerId: 'personal' },
      { recordKey: 'payment:3', taxpayerId: 'personal' },
      { recordKey: 'payment:4', taxpayerId: 'business' }
    ]
    const report = buildTaxReport(scope, snapshot)!
    expect(report.review.invoices.map((entry) => entry.id)).toEqual(['own', 'unassigned'])
    expect(report.review.payments.map((entry) => entry.nodeIdx)).toEqual([1, 2])
    expect(report.profileOnly).toBe(1)
    expect(report.unassigned).toBe(0)
    const other = buildTaxReport({ ...scope, activeTaxpayerId: 'business' }, snapshot)!
    expect(other.review.payments.map((entry) => entry.nodeIdx)).toEqual([3, 4])
    expect(other.profileOnly).toBe(1)
    expect(taxReportCsv(report)).not.toContain('Client foreign')
  })

  it('filters profile-linked dates by the saved year and keeps undated records separate', () => {
    const { scope, snapshot } = fixture()
    scope.assignments = []
    scope.recordProfiles = [
      'invoice:own',
      'invoice:prior',
      'invoice:undated',
      'payment:1',
      'payment:5',
      'payment:6'
    ].map((recordKey) => ({ recordKey, taxpayerId: 'personal' }))
    const report = buildTaxReport(scope, snapshot)!
    expect(report.review).toMatchObject({ excludedInvoices: 1, excludedPayments: 1 })
    expect(report.review.invoices.map((entry) => entry.id)).toEqual(['own'])
    expect(report.review.payments.map((entry) => entry.nodeIdx)).toEqual([1])
    expect(report.review.undatedPayments.map((entry) => entry.nodeIdx)).toEqual([5])
    expect(report.profileOnly).toBe(4)
    expect(report.summary.groups[0].incoming.amount).toBe('1.00000000')
    scope.taxpayers[0].profile.taxYear = 2025
    const prior = buildTaxReport(scope, snapshot)!
    expect(prior.review.payments.map((entry) => entry.nodeIdx)).toEqual([6])
    expect(prior.review.invoices.map((entry) => entry.id)).toEqual(['prior'])
  })

  it('counts only valid profile relationships and deduplicates orphan references against assignments', () => {
    const { scope, snapshot } = fixture()
    scope.assignments.push(
      { recordKey: 'payment:absent', accountId: 'mine', assetId: 'btc' },
      { recordKey: 'payment:4', accountId: 'theirs', assetId: 'missing' }
    )
    scope.recordProfiles = [
      { recordKey: 'invoice:unassigned', taxpayerId: 'missing' },
      { recordKey: 'payment:4', taxpayerId: 'personal' },
      { recordKey: 'payment:absent', taxpayerId: 'personal' },
      { recordKey: 'invoice:absent-linked', taxpayerId: 'personal' },
      { recordKey: 'invoice:absent-other', taxpayerId: 'business' }
    ]
    const report = buildTaxReport(scope, snapshot)!
    expect(report.unassigned).toBe(2)
    expect(report.orphaned).toBe(2)
    expect(report.profileOnly).toBe(0)
    expect(report.rows.some((row) => row.id === '4' || row.id === 'unassigned')).toBe(false)
  })
})
