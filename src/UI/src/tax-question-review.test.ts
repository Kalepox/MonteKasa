import { describe, expect, it } from 'vitest'
import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'
import { emptyValuation, type TaxEnrichment } from '../../shared/tax-enrichment'
import type { TaxProfile } from '../../shared/tax-profile'
import { calculationQuestions, type TaxCalculationId } from '../../shared/tax-questions'
import type { TaxScope } from '../../shared/tax-scope'
import { buildTaxQuestionReview, type TaxQuestionReview } from './tax-question-review'
import { buildTaxReport } from './tax-report'

const current = Date.parse('2026-06-01T12:00:00Z') / 1000
const previous = Date.parse('2025-06-01T12:00:00Z') / 1000
const bitcoin: LedgerSource = {
  id: 'saved-bitcoin',
  label: 'Saved source',
  backend: 'wdk',
  asset: {
    symbol: 'BTC',
    canonicalId: 'bitcoin',
    network: 'bitcoin',
    decimals: 8,
    environment: 'live'
  }
}
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
const business: TaxProfile = {
  ...personal,
  userType: 'business',
  personalRegime: null,
  businessType: 'sole-trader',
  businessRegime: 'ordinary'
}
const completeValue = {
  eur: '100.00',
  date: '2026-06-01',
  source: 'Saved statement',
  reference: 'Document reference'
}
function invoice(id: string, createdAt = current): KasaInvoice {
  return {
    id,
    client: `Client ${id}`,
    amount: 1,
    amountRaw: 100000000,
    received: 1,
    receivedRaw: 100000000,
    state: 'Paid',
    createdAt,
    expiresAt: createdAt + 86400,
    rgbInvoice: 'fixture invoice',
    recipientId: 'fixture recipient',
    source: bitcoin
  }
}
function payment(nodeIdx: number, blockTime: number | null = current): KasaPayment {
  return {
    nodeIdx,
    invoiceId: null,
    direction: 'in',
    received: 1,
    receivedRaw: 100000000,
    status: 'settled',
    txid: `fixture-${nodeIdx}`,
    blockTime,
    source: bitcoin
  }
}
function fixture(): { scope: TaxScope; snapshot: KasaSnapshot } {
  return {
    scope: {
      version: 1,
      databaseId: 'fixture-database',
      activeTaxpayerId: 'personal',
      taxpayers: [
        { id: 'personal', label: 'Personal profile', profile: { ...personal } },
        { id: 'business', label: 'Business profile', profile: { ...business } }
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
          id: 'other-mine',
          taxpayerId: 'personal',
          label: 'Also mine',
          ownershipBps: 10000,
          kind: 'provider'
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
        { recordKey: 'invoice:own', accountId: 'mine', assetId: 'btc' },
        { recordKey: 'invoice:prior', accountId: 'mine', assetId: 'btc' },
        ...[1, 2, 3].map((id) => ({
          recordKey: `payment:${id}`,
          accountId: 'mine',
          assetId: 'btc'
        })),
        { recordKey: 'payment:4', accountId: 'other-mine', assetId: 'btc' },
        { recordKey: 'payment:5', accountId: 'theirs', assetId: 'btc' },
        { recordKey: 'invoice:foreign', accountId: 'theirs', assetId: 'btc' }
      ]
    },
    snapshot: {
      invoices: [invoice('own'), invoice('prior', previous), invoice('foreign')],
      payments: [
        payment(1),
        payment(2),
        payment(3, null),
        payment(4, previous),
        payment(5),
        payment(6)
      ],
      proposals: []
    }
  }
}
function enrich(
  scope: TaxScope,
  key: string,
  classification: TaxEnrichment['classification']
): TaxEnrichment {
  const assignment = scope.assignments.find((entry) => entry.recordKey === key)!
  const result: TaxEnrichment = {
    ...assignment,
    classification,
    valuation: emptyValuation(),
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
  scope.enrichments = [
    ...(scope.enrichments ?? []).filter((entry) => entry.recordKey !== key),
    result
  ]
  return result
}
function review(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  calculation: TaxCalculationId = 'personal-gains'
): TaxQuestionReview {
  return buildTaxQuestionReview(scope, snapshot, buildTaxReport(scope, snapshot)!, calculation)!
}
function keys(result: TaxQuestionReview, kind: string): string[] {
  return result.recordQuestions.find((question) => question.kind === kind)?.recordKeys ?? []
}

describe('focused missing-tax-information questions', () => {
  it('asks only about assigned records in the selected year and assigned undated records', () => {
    const { scope, snapshot } = fixture()
    const result = review(scope, snapshot)
    expect(result).toMatchObject({
      taxpayerId: 'personal',
      taxYear: 2026,
      scopeKey: JSON.stringify(['fixture-database', 'personal', 2026])
    })
    expect(keys(result, 'classification')).toEqual([
      'invoice:own',
      'payment:1',
      'payment:2',
      'payment:3'
    ])
    expect(result.recordQuestions).toHaveLength(1)
    expect(result.recordQuestions[0].section).toBe('purpose')
    expect(JSON.stringify(result)).not.toContain('Client foreign')
    expect(result.warnings.join(' ')).toContain('Undated records need date review')
  })

  it('rejects missing selections, unsupported countries, unavailable calculations and stale report identities', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    for (const activeTaxpayerId of [undefined, 'absent', 'business'])
      expect(
        buildTaxQuestionReview({ ...scope, activeTaxpayerId }, snapshot, report, 'personal-gains')
      ).toBeNull()
    for (const calculation of ['business-income', 'vat', 'forfettario'] as const)
      expect(buildTaxQuestionReview(scope, snapshot, report, calculation)).toBeNull()
    expect(
      buildTaxQuestionReview(
        { ...scope, databaseId: 'different' },
        snapshot,
        report,
        'personal-gains'
      )
    ).toBeNull()
    scope.taxpayers[0].profile.taxYear = 2025
    expect(buildTaxQuestionReview(scope, snapshot, report, 'personal-gains')).toBeNull()
    scope.taxpayers[0].profile.taxYear = 2026
    scope.taxpayers[0].profile.country = 'other'
    expect(review(scope, snapshot)).toBeNull()
  })

  it('asks what happened first, then shows questions appropriate to the saved classification', () => {
    const { scope, snapshot } = fixture()
    const sale = enrich(scope, 'payment:1', 'sale')
    let result = review(scope, snapshot)
    expect(keys(result, 'classification')).not.toContain('payment:1')
    expect(keys(result, 'valuation')).toEqual(['payment:1'])
    expect(keys(result, 'fees')).toEqual(['payment:1'])
    expect(keys(result, 'links')).toEqual([])
    sale.classification = 'own-transfer'
    result = review(scope, snapshot)
    expect(keys(result, 'valuation')).toEqual([])
    expect(keys(result, 'fees')).toEqual(['payment:1'])
    expect(keys(result, 'links')).toEqual(['payment:1'])
    sale.classification = 'unknown'
    result = review(scope, snapshot)
    expect(keys(result, 'classification')).toContain('payment:1')
    expect(keys(result, 'fees')).toEqual([])
    expect(keys(result, 'links')).toEqual([])
  })

  it('removes completed record follow-ups while keeping unverified preparation warnings', () => {
    const { scope, snapshot } = fixture()
    const sale = enrich(scope, 'payment:1', 'sale')
    sale.valuation = { ...completeValue }
    sale.fee.status = 'none'
    const result = review(scope, snapshot)
    expect(result.recordQuestions.flatMap((question) => question.recordKeys)).not.toContain(
      'payment:1'
    )
    expect(result.warnings.join(' ')).toContain('user supplied and unverified')
    expect(result.warnings.join(' ')).toContain('do not add their amounts together')
  })

  it('retains EUR questions until all valuation evidence fields are present', () => {
    const { scope, snapshot } = fixture()
    const sale = enrich(scope, 'payment:1', 'sale')
    for (const missing of ['eur', 'date', 'source', 'reference'] as const) {
      sale.valuation = { ...completeValue, [missing]: '' }
      expect(keys(review(scope, snapshot), 'valuation')).toContain('payment:1')
    }
    sale.valuation = { ...completeValue, eur: '0' }
    expect(keys(review(scope, snapshot), 'valuation')).not.toContain('payment:1')
  })

  it('requires recorded fee evidence but respects an explicit no-fee declaration', () => {
    const { scope, snapshot } = fixture()
    const sale = enrich(scope, 'payment:1', 'sale')
    sale.fee = {
      status: 'recorded',
      amount: '0.0001',
      assetId: 'btc',
      purpose: 'network fee',
      reference: 'Fee statement',
      valuation: { ...completeValue }
    }
    expect(keys(review(scope, snapshot), 'fees')).toEqual([])
    for (const missing of ['amount', 'assetId', 'purpose', 'reference'] as const) {
      const original = sale.fee[missing]
      sale.fee[missing] = ''
      expect(keys(review(scope, snapshot), 'fees')).toEqual(['payment:1'])
      sale.fee[missing] = original
    }
    sale.fee.valuation.reference = ''
    expect(keys(review(scope, snapshot), 'fees')).toEqual(['payment:1'])
    sale.fee.status = 'none'
    expect(keys(review(scope, snapshot), 'fees')).toEqual([])
  })

  it('does not use enrichment attached to an obsolete account or asset assignment', () => {
    const { scope, snapshot } = fixture()
    const sale = enrich(scope, 'payment:1', 'sale')
    sale.valuation = { ...completeValue }
    sale.fee.status = 'none'
    for (const field of ['accountId', 'assetId'] as const) {
      const original = sale[field]
      sale[field] = 'obsolete'
      expect(keys(review(scope, snapshot), 'classification')).toContain('payment:1')
      sale[field] = original
    }
  })

  it('accepts a valid same-taxpayer transfer link from a prior year without adding that record to this year', () => {
    const { scope, snapshot } = fixture()
    const transfer = enrich(scope, 'payment:1', 'own-transfer')
    transfer.relatedRecordKey = 'payment:4'
    transfer.fee.status = 'none'
    const result = review(scope, snapshot)
    expect(keys(result, 'links')).toEqual([])
    expect(result.recordQuestions.flatMap((question) => question.recordKeys)).not.toContain(
      'payment:4'
    )
    expect(keys(result, 'valuation')).toEqual([])
  })

  it('reopens links when the target disappears, belongs to another taxpayer or is no longer a valid own transfer', () => {
    const { scope, snapshot } = fixture()
    const transfer = enrich(scope, 'payment:1', 'own-transfer')
    for (const target of ['payment:99', 'payment:5', 'payment:2', 'invoice:own', 'payment:1']) {
      transfer.relatedRecordKey = target
      expect(keys(review(scope, snapshot), 'links')).toEqual(['payment:1'])
    }
    transfer.relatedRecordKey = 'payment:4'
    snapshot.payments = snapshot.payments.filter((entry) => entry.nodeIdx !== 4)
    expect(keys(review(scope, snapshot), 'links')).toEqual(['payment:1'])
  })

  it('accepts a prior-year refund reference only when its saved assignment is valid and has the same owner', () => {
    const { scope, snapshot } = fixture()
    const refund = enrich(scope, 'payment:1', 'refund')
    refund.relatedRecordKey = 'invoice:prior'
    expect(keys(review(scope, snapshot), 'links')).toEqual([])
    expect(keys(review(scope, snapshot), 'valuation')).toEqual(['payment:1'])
    scope.assignments.find((entry) => entry.recordKey === 'invoice:prior')!.assetId = 'missing'
    expect(keys(review(scope, snapshot), 'links')).toEqual(['payment:1'])
  })

  it('scopes supporting answers to both taxpayer and saved tax year', () => {
    const { scope, snapshot } = fixture()
    const question = calculationQuestions(personal)[0].questions[0]
    scope.preparationAnswers = [
      {
        taxpayerId: 'business',
        taxYear: 2026,
        questionId: question.id,
        status: 'available',
        reference: 'Foreign private reference',
        notes: 'Foreign notes'
      },
      {
        taxpayerId: 'personal',
        taxYear: 2025,
        questionId: question.id,
        status: 'available',
        reference: 'Prior private reference',
        notes: 'Prior notes'
      },
      {
        taxpayerId: 'personal',
        taxYear: 2026,
        questionId: question.id,
        status: 'partial',
        reference: 'Selected reference',
        notes: 'Selected notes'
      }
    ]
    const result = review(scope, snapshot)
    expect(result.preparationQuestions[0].answer).toMatchObject({
      status: 'partial',
      reference: 'Selected reference'
    })
    expect(result.missingPreparation).toBe(result.preparationQuestions.length)
    expect(JSON.stringify(result)).not.toContain('Foreign private')
    expect(JSON.stringify(result)).not.toContain('Prior private')
  })

  it('never treats all available supporting references as numerical readiness', () => {
    const { scope, snapshot } = fixture()
    scope.preparationAnswers = calculationQuestions(personal)[0].questions.map((question) => ({
      taxpayerId: 'personal',
      taxYear: 2026,
      questionId: question.id,
      status: 'available',
      reference: 'User supplied evidence',
      notes: ''
    }))
    const result = review(scope, snapshot)
    expect(result.missingPreparation).toBe(0)
    expect(result.recordQuestions).not.toEqual([])
    expect(result.warnings.join(' ')).toContain(
      'does not provide validated numerical inputs or make a tax estimate ready'
    )
    expect(result).not.toHaveProperty('ready')
    expect(result).not.toHaveProperty('score')
    expect(result).not.toHaveProperty('estimate')
  })

  it('asks holding questions without per-record EUR values or fees', () => {
    const { scope, snapshot } = fixture()
    enrich(scope, 'payment:1', 'sale')
    enrich(scope, 'payment:2', 'own-transfer')
    const result = review(scope, snapshot, 'holding-tax')
    expect(result.calculation.id).toBe('holding-tax')
    expect(keys(result, 'valuation')).toEqual([])
    expect(keys(result, 'fees')).toEqual([])
    expect(keys(result, 'links')).toEqual(['payment:2'])
    expect(result.preparationQuestions.map((question) => question.id)).toEqual([
      'holding-history',
      'stamp-duty'
    ])
  })

  it('offers business-specific questions and omits fee questions for VAT and forfettario', () => {
    const { scope, snapshot } = fixture()
    scope.activeTaxpayerId = 'business'
    enrich(scope, 'payment:5', 'goods-services')
    const income = review(scope, snapshot, 'business-income')
    expect(keys(income, 'valuation')).toEqual(['payment:5'])
    expect(keys(income, 'fees')).toEqual(['payment:5'])
    const vat = review(scope, snapshot, 'vat')
    expect(keys(vat, 'valuation')).toEqual(['payment:5'])
    expect(keys(vat, 'fees')).toEqual([])
    expect(review(scope, snapshot, 'personal-gains')).toBeNull()
    expect(review(scope, snapshot, 'forfettario')).toBeNull()
    scope.taxpayers[1].profile.businessRegime = 'forfettario'
    const flat = review(scope, snapshot, 'forfettario')
    expect(keys(flat, 'fees')).toEqual([])
    expect(flat.preparationQuestions.map((question) => question.id)).toContain(
      'forfettario-eligibility'
    )
    expect(JSON.stringify(flat.recordQuestions)).not.toContain('payment:1')
  })

  it('keeps source, date, status, ownership and history concerns separate from record questions', () => {
    const { scope, snapshot } = fixture()
    snapshot.payments[0].status = 'pending'
    scope.accounts[0].ownershipBps = 5000
    scope.assignments.push({ recordKey: 'payment:absent', accountId: 'mine', assetId: 'btc' })
    snapshot.invoices[2].source = { ...bitcoin, asset: { ...bitcoin.asset, decimals: 6 } }
    const result = review(scope, snapshot)
    const warnings = result.warnings.join(' ')
    expect(warnings).toContain('unsettled saved status')
    expect(warnings).toContain('Undated records')
    expect(warnings).toContain('Conflicting saved source metadata')
    expect(warnings).toContain('shared ownership')
    expect(warnings).toContain('without a current saved record')
    expect(warnings).toContain('without a valid profile assignment')
    expect(warnings).toContain('History coverage is incomplete or unknown')
    expect(result.recordQuestions.map((question) => question.kind)).toEqual(['classification'])
  })

  it('warns about test, unknown and unsafe source amounts without presenting them as tax evidence', () => {
    const { scope, snapshot } = fixture()
    snapshot.invoices[0].source = undefined
    snapshot.payments[0].source = {
      ...bitcoin,
      id: 'test-source',
      asset: { ...bitcoin.asset, environment: 'test' }
    }
    snapshot.payments[1].receivedRaw = Number.MAX_SAFE_INTEGER + 1
    scope.taxpayers[0].profile.recordsCoverage = 'complete'
    const warnings = review(scope, snapshot).warnings.join(' ')
    expect(warnings).toContain('source or asset information is unknown')
    expect(warnings).toContain('Test or demo records are not evidence of real funds')
    expect(warnings).toContain('saved amounts cannot be safely interpreted')
    expect(warnings).toContain('History is declared complete, but still needs reconciliation')
  })

  it('does not reuse stale report records after current assignments, dates or database rows change', () => {
    const { scope, snapshot } = fixture()
    const report = buildTaxReport(scope, snapshot)!
    scope.assignments.find((entry) => entry.recordKey === 'payment:1')!.accountId = 'theirs'
    snapshot.payments[1].blockTime = previous
    snapshot.payments = snapshot.payments.filter((entry) => entry.nodeIdx !== 3)
    const result = buildTaxQuestionReview(scope, snapshot, report, 'personal-gains')!
    expect(keys(result, 'classification')).toEqual(['invoice:own'])
  })

  it('shows no-activity and profile warnings without fabricating record amounts or questions', () => {
    const { scope, snapshot } = fixture()
    scope.assignments = []
    scope.taxpayers[0].profile.personalRegime = 'unknown'
    const result = review(scope, snapshot)
    expect(result.recordQuestions).toEqual([])
    expect(result.warnings.join(' ')).toContain('No saved activity is assigned')
    expect(result.warnings.join(' ')).toContain('Confirm the applicable tax regime')
    expect(result.preparationQuestions.length).toBeGreaterThan(0)
  })

  it('keeps profile-only records visible without inventing account-based enrichment questions', () => {
    const { scope, snapshot } = fixture()
    scope.assignments = []
    scope.recordProfiles = [{ recordKey: 'payment:1', taxpayerId: 'personal' }]
    snapshot.payments[0].source = undefined
    const result = review(scope, snapshot)
    expect(result.recordQuestions).toEqual([])
    expect(result.warnings.join(' ')).toContain('1 record(s) are linked to this profile')
    expect(result.warnings.join(' ')).toContain('ownership and asset identity are not inferred')
    expect(scope.accounts).toHaveLength(3)
  })

  it('reads frozen snapshots, scope and report without changing saved data', () => {
    const { scope, snapshot } = fixture()
    enrich(scope, 'payment:1', 'sale')
    const report = buildTaxReport(scope, snapshot)!
    const before = structuredClone({ scope, snapshot, report })
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
      }
    }
    freeze(scope)
    freeze(snapshot)
    freeze(report)
    expect(
      buildTaxQuestionReview(scope, snapshot, report, 'personal-gains')?.recordQuestions.length
    ).toBeGreaterThan(0)
    expect({ scope, snapshot, report }).toEqual(before)
  })
})
