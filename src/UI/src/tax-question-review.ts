import type { KasaSnapshot } from '../../preload/index.d'
import { valuationComplete, type TaxEnrichment } from '../../shared/tax-enrichment'
import {
  calculationQuestions,
  type TaxCalculationId,
  type TaxPreparationAnswer
} from '../../shared/tax-questions'
import { recordKeys, scopedRecords, type TaxScope } from '../../shared/tax-scope'
import { relatedRecordCandidates } from './tax-enrichment-flow'
import type { TaxReport } from './tax-report'
import { taxYearReview } from './tax-year-ledger'

type PreparationQuestion = ReturnType<typeof calculationQuestions>[number]['questions'][number]
export type TaxRecordQuestion = {
  kind: 'classification' | 'valuation' | 'fees' | 'links'
  title: string
  question: string
  help: string
  recordKeys: string[]
  section: 'purpose' | 'value' | 'fees' | 'related'
}
export type TaxQuestionReview = {
  taxpayerId: string
  taxYear: number
  scopeKey: string
  calculation: { id: TaxCalculationId; label: string }
  preparationQuestions: (PreparationQuestion & { answer: TaxPreparationAnswer | undefined })[]
  missingPreparation: number
  recordQuestions: TaxRecordQuestion[]
  warnings: string[]
}

const recordQuestions: Omit<TaxRecordQuestion, 'recordKeys'>[] = [
  {
    kind: 'classification',
    title: 'Explain what happened',
    question: 'What was this activity for?',
    help: 'The app already has the recorded payment or invoice amount. Choose its purpose so we can ask only the relevant follow-up questions.',
    section: 'purpose'
  },
  {
    kind: 'valuation',
    title: 'Add the euro value and its evidence',
    question: 'What was this activity worth in euros at the relevant date?',
    help: 'Use a statement, invoice or valuation record to add the EUR value, date, source and evidence reference. Do not enter the saved crypto amount again. This does not calculate a gain or establish tax due.',
    section: 'value'
  },
  {
    kind: 'fees',
    title: 'Confirm fees',
    question: 'Was a separate fee charged for this activity?',
    help: 'Confirm no fee, or complete the recorded fee and its purpose, euro value and evidence. A fee declaration does not establish that it is tax deductible.',
    section: 'fees'
  },
  {
    kind: 'links',
    title: 'Connect the related activity',
    question:
      'Which saved record is the other side of this transfer or the original refunded activity?',
    help: 'Choose an existing record assigned to this taxpayer, including earlier years. A link helps reconciliation; it does not prove settlement or tax exemption.',
    section: 'related'
  }
]

function feeMissing(entry: TaxEnrichment): boolean {
  return (
    entry.fee.status === 'unknown' ||
    (entry.fee.status === 'recorded' &&
      (!entry.fee.amount ||
        !entry.fee.assetId ||
        !entry.fee.purpose ||
        !entry.fee.reference ||
        !valuationComplete(entry.fee.valuation)))
  )
}

// Saved declarations guide the next question. They never prove numerical readiness,
// settle a transaction or replace evidence needed for a tax calculation.
export function buildTaxQuestionReview(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  report: TaxReport,
  calculationId: TaxCalculationId
): TaxQuestionReview | null {
  const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
  if (!taxpayer || taxpayer.profile.country !== 'IT') return null
  const year = taxpayer.profile.taxYear
  const scopeKey = JSON.stringify([scope.databaseId, taxpayer.id, year])
  if (report.scopeKey !== scopeKey || report.taxpayer.id !== taxpayer.id || report.year !== year)
    return null
  const calculation = calculationQuestions(taxpayer.profile).find(
    (entry) => entry.id === calculationId
  )
  if (!calculation) return null

  const assetIds = new Set(scope.assets.map((asset) => asset.id))
  const accountIds = new Set(
    scope.accounts
      .filter((account) => account.taxpayerId === taxpayer.id)
      .map((account) => account.id)
  )
  const assignments = scope.assignments.filter(
    (assignment) => accountIds.has(assignment.accountId) && assetIds.has(assignment.assetId)
  )
  const selectedScope = { ...scope, assignments }
  const selected = scopedRecords(selectedScope, snapshot, taxpayer.id)
  const review = taxYearReview(selected, year)
  const reviewRecords = (value: typeof review): KasaSnapshot => ({
    invoices: [...value.invoices, ...value.undatedInvoices],
    payments: [...value.payments, ...value.undatedPayments],
    proposals: []
  })
  const reportKeys = recordKeys(reviewRecords(report.review))
  const keys = [...recordKeys(reviewRecords(review))].filter((key) => reportKeys.has(key))
  const allSavedKeys = recordKeys(snapshot)
  const missing: Record<TaxRecordQuestion['kind'], string[]> = {
    classification: [],
    valuation: [],
    fees: [],
    links: []
  }
  const asksValue = calculationId !== 'holding-tax'
  const asksFees = calculationId === 'personal-gains' || calculationId === 'business-income'
  let profileOnly = 0
  for (const key of keys) {
    const assignment = assignments.find((entry) => entry.recordKey === key)
    if (!assignment) {
      profileOnly++
      continue
    }
    const enrichment = scope.enrichments?.find(
      (entry) =>
        entry.recordKey === key &&
        entry.accountId === assignment.accountId &&
        entry.assetId === assignment.assetId
    )
    if (!enrichment || enrichment.classification === 'unknown') {
      missing.classification.push(key)
      continue
    }
    // Own-account movements need reconciliation, not sale proceeds.
    if (
      asksValue &&
      enrichment.classification !== 'own-transfer' &&
      !valuationComplete(enrichment.valuation)
    )
      missing.valuation.push(key)
    if (asksFees && feeMissing(enrichment)) missing.fees.push(key)
    if (
      ['own-transfer', 'refund'].includes(enrichment.classification) &&
      !relatedRecordCandidates(
        selectedScope,
        allSavedKeys,
        key,
        enrichment.classification
      ).includes(enrichment.relatedRecordKey)
    )
      missing.links.push(key)
  }

  const preparationQuestions = calculation.questions.map((question) => {
    const saved = scope.preparationAnswers?.find(
      (answer) =>
        answer.taxpayerId === taxpayer.id &&
        answer.taxYear === year &&
        answer.questionId === question.id
    )
    return { ...question, answer: saved ? { ...saved } : undefined }
  })
  const warnings = [
    'Supporting records and answers are user supplied and unverified. Marking evidence available does not provide validated numerical inputs or make a tax estimate ready.',
    'Invoice requests and payment observations can describe the same activity. Reconcile them before calculating; do not add their amounts together.'
  ]
  if (profileOnly)
    warnings.push(
      `${profileOnly} record(s) are linked to this profile without a reviewed account and asset assignment. Review these in Activity before adding tax details; ownership and asset identity are not inferred.`
    )
  if (!keys.length)
    warnings.push(
      'No saved activity is assigned to this profile in the selected year or awaiting a date.'
    )
  if (review.undatedInvoices.length || review.undatedPayments.length)
    warnings.push(
      'Undated records need date review. They remain outside year totals; a saved record date does not determine fiscal recognition.'
    )
  if (
    review.payments.some((payment) => payment.status !== 'settled') ||
    review.undatedPayments.some((payment) => payment.status !== 'settled')
  )
    warnings.push(
      'Some payments have an unsettled saved status. Review their evidence before using them for tax calculations; no live status is checked here.'
    )
  if (report.rows.some((row) => row.sourceStatus === 'conflict'))
    warnings.push(
      'Conflicting saved source metadata needs review before amounts can be interpreted.'
    )
  if (report.rows.some((row) => row.sourceStatus === 'unknown' || row.environment === 'unknown'))
    warnings.push(
      'Some saved source or asset information is unknown. Confirm identity, precision and whether activity represents real funds.'
    )
  if (report.rows.some((row) => row.environment === 'test' || row.backend === 'mock'))
    warnings.push(
      'Test or demo records are not evidence of real funds and cannot support monetary tax estimates.'
    )
  if (report.rows.some((row) => row.amount === 'Unavailable'))
    warnings.push(
      'Some saved amounts cannot be safely interpreted. Review raw values and source evidence before calculating.'
    )
  if (report.unknownOwnership || report.partialOwnership)
    warnings.push(
      'Confirm account ownership and any shared ownership. Displayed saved amounts have not been adjusted for ownership shares.'
    )
  if (report.unassigned)
    warnings.push(
      'The database contains records without a valid profile assignment. They are excluded from these questions; review their ownership separately.'
    )
  if (report.orphaned)
    warnings.push(
      'This profile has assignments without a current saved record. Reconcile the missing records before calculating.'
    )
  warnings.push(
    taxpayer.profile.recordsCoverage === 'complete'
      ? 'History is declared complete, but still needs reconciliation against supporting records, including earlier years and activity outside the app.'
      : 'History coverage is incomplete or unknown. Earlier acquisitions and activity outside the app may still be needed.'
  )
  if (
    taxpayer.profile.personalRegime === 'unknown' ||
    taxpayer.profile.businessRegime === 'unknown'
  )
    warnings.push('Confirm the applicable tax regime in the saved profile.')
  if (taxpayer.profile.businessType === 'unknown')
    warnings.push('Confirm the business type in the saved profile.')

  return {
    taxpayerId: taxpayer.id,
    taxYear: year,
    scopeKey,
    calculation: { id: calculation.id, label: calculation.label },
    preparationQuestions,
    missingPreparation: preparationQuestions.filter(
      (question) => question.answer?.status !== 'available'
    ).length,
    recordQuestions: recordQuestions
      .filter((question) => missing[question.kind].length)
      .map((question) => ({ ...question, recordKeys: missing[question.kind] })),
    warnings
  }
}
