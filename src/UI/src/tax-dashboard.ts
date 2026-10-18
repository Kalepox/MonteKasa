import type { KasaSnapshot } from '../../preload/index.d'
import { enrichmentGaps, feeGaps } from '../../shared/tax-enrichment'
import { calculationCompleteness, type Completeness, type TaxScope } from '../../shared/tax-scope'
import { taxScopeKey } from '../../shared/tax-selection'
import type { TaxReport } from './tax-report'
import type { PersonalDisposalEstimate } from './personal-disposal'
import { buildDashboardVisuals, type DashboardVisuals } from './tax-dashboard-visuals'

export type TaxDashboard = {
  visuals: DashboardVisuals
  personalDisposal?: PersonalDisposalEstimate
  scopeKey: string
  taxpayerLabel: string
  year: number
  groups: {
    source: TaxReport['summary']['groups'][number]['source']
    conflict: boolean
    paymentCount: number
    notSettled: number
    incoming: TaxReport['summary']['groups'][number]['incoming']
    outgoing: TaxReport['summary']['groups'][number]['outgoing']
  }[]
  counts: {
    invoices: number
    payments: number
    settledIncoming: number
    settledOutgoing: number
    notSettled: number
  }
  months: { month: number; label: string; incoming: number; outgoing: number; notSettled: number }[]
  coverage: {
    undatedInvoices: number
    undatedPayments: number
    otherYearInvoices: number
    otherYearPayments: number
    unassigned: number
    orphaned: number
    profileOnly: number
    partialOwnership: number
    unknownOwnership: number
    history: TaxScope['taxpayers'][number]['profile']['recordsCoverage']
    historyNote: string
  }
  estimates: (Completeness & { label: string; explanation: string })[]
  nextSteps: {
    title: string
    description: string
    target:
      | 'scope-history-form'
      | 'tax-activity-title'
      | 'scope-accounts-title'
      | 'enrichment-title'
      | 'scope-checklist-title'
    recordKey?: string
  }[]
}

const monthFormat = new Intl.DateTimeFormat('en', {
  month: 'numeric',
  timeZone: 'Europe/Rome'
})
const monthLabels = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

const explanations: Record<string, string> = {
  'Personal gains and losses':
    'Payment activity does not determine a gain. Acquisition costs, disposals and the applicable regime need review.',
  'Annual holding tax':
    'Payment records do not describe holdings throughout the year. Historical balances, valuations and amounts already paid are still needed.',
  'Business income':
    'Incoming payments are not automatically taxable income. Accounting periods, costs and the business treatment need review.',
  VAT: 'VAT depends on the underlying supply and fiscal documents. A crypto payment amount alone does not establish VAT due.',
  Forfettario:
    'The declared regime is not verified eligibility. Total business receipts and the other required inputs still need review.'
}

// This view reads the same selected-year report as Reports. It is a record overview,
// not an independent tax engine, balance lookup or verification of declarations.
export function buildTaxDashboard(
  scope: TaxScope,
  report: TaxReport,
  snapshot?: KasaSnapshot
): TaxDashboard {
  const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
  const scopeKey = taxScopeKey(scope)
  if (
    !taxpayer ||
    !scopeKey ||
    report.scopeKey !== scopeKey ||
    report.taxpayer.id !== taxpayer.id ||
    report.year !== taxpayer.profile.taxYear
  )
    throw new Error('Reload the report for the selected profile and tax year.')

  const { review } = report
  const selected: KasaSnapshot = {
    invoices: [...review.invoices, ...review.undatedInvoices],
    payments: [...review.payments, ...review.undatedPayments],
    proposals: []
  }
  const keys = [
    ...selected.invoices.map((invoice) => `invoice:${invoice.id}`),
    ...selected.payments.map((payment) => `payment:${payment.nodeIdx}`)
  ]
  const accounts = new Set(
    scope.accounts
      .filter((account) => account.taxpayerId === taxpayer.id)
      .map((account) => account.id)
  )
  const assets = new Set(scope.assets.map((asset) => asset.id))
  const keySet = new Set(keys)
  const assignments = scope.assignments.filter(
    (assignment) =>
      keySet.has(assignment.recordKey) &&
      accounts.has(assignment.accountId) &&
      assets.has(assignment.assetId)
  )
  const assignmentByKey = new Map(assignments.map((entry) => [entry.recordKey, entry]))
  const enrichmentByKey = new Map(
    (scope.enrichments ?? [])
      .filter((entry) => {
        const assignment = assignmentByKey.get(entry.recordKey)
        return assignment?.accountId === entry.accountId && assignment.assetId === entry.assetId
      })
      .map((entry) => [entry.recordKey, entry])
  )
  const requirements = calculationCompleteness(
    { ...scope, assignments, enrichments: [...enrichmentByKey.values()] },
    selected,
    taxpayer.id
  ).filter(
    (entry) => !['Transaction fees', 'EU provider and transfer checks'].includes(entry.calculation)
  )
  const taxRequirements: Completeness[] =
    taxpayer.profile.country === 'IT'
      ? requirements
      : [
          {
            calculation: 'Tax estimates',
            status: 'unsupported',
            missing: ['Only Italian taxpayer review is supported.']
          }
        ]
  const months: TaxDashboard['months'] = monthLabels.map((label, index) => ({
    month: index + 1,
    label,
    incoming: 0,
    outgoing: 0,
    notSettled: 0
  }))
  for (const payment of review.payments) {
    const month = months[Number(monthFormat.format(new Date(payment.blockTime! * 1000))) - 1]
    if (payment.status !== 'settled') month.notSettled++
    else if (payment.direction === 'in') month.incoming++
    else month.outgoing++
  }
  const groups: TaxDashboard['groups'] = report.summary.groups
    .filter((group) => group.paymentCount > 0)
    .map((group) => ({
      source: group.source,
      conflict: group.conflict,
      paymentCount: group.paymentCount,
      notSettled: group.unsettled,
      incoming: { ...group.incoming },
      outgoing: { ...group.outgoing }
    }))
  const profile = taxpayer.profile
  const nextSteps: TaxDashboard['nextSteps'] = []
  if (
    profile.recordsCoverage !== 'complete' ||
    profile.country !== 'IT' ||
    profile.personalRegime === 'unknown' ||
    profile.businessRegime === 'unknown' ||
    profile.businessType === 'unknown'
  )
    nextSteps.push({
      title: 'Confirm your profile and history',
      description:
        profile.country !== 'IT'
          ? 'This country is not supported for tax estimates. Saved records remain available; arrange a review of the applicable rules.'
          : 'Review the saved regime and history coverage. Earlier years and activity outside this app may be needed for calculations.',
      target: 'scope-history-form'
    })
  if (report.unassigned || report.orphaned || report.profileOnly)
    nextSteps.push({
      title: report.profileOnly ? 'Review linked records' : 'Review record assignments',
      description: [
        report.profileOnly
          ? `${report.profileOnly} record(s) are linked to this profile; account, asset and ownership still need review. These records appear in the overview but are not ready for tax calculations.`
          : '',
        report.unassigned || report.orphaned
          ? `${report.unassigned} database record(s) have no valid profile relationship or assignment; they may belong to another profile. ${report.orphaned} relationship(s) for this profile have no saved record. These are excluded from this overview.`
          : ''
      ]
        .filter(Boolean)
        .join(' '),
      target: 'tax-activity-title'
    })
  else if (report.partialOwnership || report.unknownOwnership)
    nextSteps.push({
      title: 'Review account ownership',
      description:
        'Some accounts have partial or unknown ownership. This overview shows full saved amounts; ownership shares are not applied.',
      target: 'scope-accounts-title'
    })

  const assignedKeys = keys.filter((key) => assignmentByKey.has(key))
  const incompleteKey = assignedKeys.find((key) => {
    const entries = [enrichmentByKey.get(key)]
    return enrichmentGaps(entries).length || feeGaps(entries).length
  })
  const undatedKey = [
    ...review.undatedInvoices.map((invoice) => `invoice:${invoice.id}`),
    ...review.undatedPayments.map((payment) => `payment:${payment.nodeIdx}`)
  ].find((key) => assignmentByKey.has(key))
  const notSettled = review.payments.find(
    (payment) => payment.status !== 'settled' && assignmentByKey.has(`payment:${payment.nodeIdx}`)
  )
  const rowKey = (row: TaxReport['rows'][number]): string =>
    `${row.type.toLowerCase().includes('invoice') ? 'invoice' : 'payment'}:${row.id}`
  const sourceReview = report.rows.find(
    (row) =>
      assignmentByKey.has(rowKey(row)) &&
      (row.sourceStatus !== 'saved' ||
        row.amount === 'Unavailable' ||
        row.environment !== 'live' ||
        row.backend === 'mock')
  )
  const reviewKey =
    undatedKey ??
    incompleteKey ??
    (notSettled ? `payment:${notSettled.nodeIdx}` : undefined) ??
    (sourceReview ? rowKey(sourceReview) : undefined)
  if (reviewKey)
    nextSteps.push({
      title: 'Review record details',
      description:
        'Check missing dates, transaction purpose, EUR evidence and fee details. Saved payment status and source metadata may also need reconciliation. Supplied details are not independently verified.',
      target: 'enrichment-title',
      recordKey: reviewKey
    })
  nextSteps.push({
    title: 'Review calculation requirements',
    description:
      'See the information still needed for your declared profile. Completing record details alone does not produce a tax estimate.',
    target: 'scope-checklist-title'
  })

  return {
    visuals: buildDashboardVisuals(scope, report, snapshot),
    scopeKey: report.scopeKey,
    taxpayerLabel: taxpayer.label,
    year: report.year,
    groups,
    counts: {
      invoices: review.invoices.length,
      payments: review.payments.length,
      settledIncoming: months.reduce((sum, month) => sum + month.incoming, 0),
      settledOutgoing: months.reduce((sum, month) => sum + month.outgoing, 0),
      notSettled: months.reduce((sum, month) => sum + month.notSettled, 0)
    },
    months,
    coverage: {
      undatedInvoices: review.undatedInvoices.length,
      undatedPayments: review.undatedPayments.length,
      otherYearInvoices: review.excludedInvoices,
      otherYearPayments: review.excludedPayments,
      unassigned: report.unassigned,
      orphaned: report.orphaned,
      profileOnly: report.profileOnly,
      partialOwnership: report.partialOwnership,
      unknownOwnership: report.unknownOwnership,
      history: profile.recordsCoverage,
      historyNote:
        profile.recordsCoverage === 'complete'
          ? 'You declared history complete; it has not been independently verified. Earlier-year costs and records outside this app may still require reconciliation.'
          : 'History is declared incomplete or uncertain. Earlier-year acquisition costs and records outside this app may be needed; the selected-year activity cannot establish complete history.'
    },
    estimates: taxRequirements.map((requirement) => ({
      ...requirement,
      label:
        requirement.status === 'unsupported'
          ? 'Unsupported country'
          : requirement.status === 'not-applicable'
            ? 'Not applicable to this profile'
            : 'Not yet estimable',
      explanation:
        requirement.status === 'unsupported'
          ? 'Saved records can be reviewed, but tax estimates for this country are not supported.'
          : requirement.status === 'not-applicable'
            ? 'Not enabled for the saved profile classification. Recheck this if the profile changes.'
            : explanations[requirement.calculation]
    })),
    nextSteps
  }
}
