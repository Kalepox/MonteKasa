import type { KasaSnapshot } from '../../preload/index.d'
import { readLedgerSource } from '../../shared/ledger-source'
import { enrichmentGaps, feeGaps, type TaxEnrichment } from '../../shared/tax-enrichment'
import { taxScopeKey } from '../../shared/tax-selection'
import type { TaxScope } from '../../shared/tax-scope'
import { formatLedgerRaw, rawLedgerAmount } from './ledger-amount'
import type { TaxReport } from './tax-report'

export type DashboardVisuals = {
  scopeKey: string
  year: number
  reviewed: { documented: number; total: number; needsDetails: number }
  activity: {
    mode: 'eur' | 'count'
    months: {
      month: number
      label: string
      incoming: string | null
      outgoing: string | null
      incomingRatio: number
      outgoingRatio: number
      incomingCount: number
      outgoingCount: number
    }[]
    incoming: string | null
    outgoing: string | null
    eligiblePayments: number
    totalPayments: number
    scaleMaximum: string | null
  }
  coverage: {
    datedSettled: number
    notSettled: number
    undated: number
    otherYear: number
    testOrDemo: number
    unknownSource: number
    conflictingSource: number
    duplicatePayments: number
    unvaluedPayments: number
    invalidPaymentDetails: number
  }
  limitations: string[]
}

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
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

function savedDate(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return null
  const parts = dateFormat.formatToParts(date)
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-')
}

// Same eight-decimal evidence precision as saved tax enrichment. Floating-point
// numbers are used only for the final bounded bar ratio, never EUR arithmetic.
function eurUnits(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))
}

function evidencedValue(enrichment: TaxEnrichment | undefined, date: string | null): bigint | null {
  if (
    !enrichment ||
    !date ||
    enrichment.valuation.date !== date ||
    !enrichment.valuation.source.trim() ||
    !enrichment.valuation.reference.trim()
  )
    return null
  return eurUnits(enrichment.valuation.eur)
}

function counts<T>(entries: T[], key: (entry: T) => string | null): Map<string, number> {
  const result = new Map<string, number>()
  for (const entry of entries) {
    const value = key(entry)
    if (value) result.set(value, (result.get(value) ?? 0) + 1)
  }
  return result
}

// Pure presentation data over saved records. Snapshot is optional only for older
// callers; supplying the already loaded database snapshot broadens duplicate
// detection without broadening the selected profile/year's displayed records.
export function buildDashboardVisuals(
  scope: TaxScope,
  report: TaxReport,
  snapshot?: KasaSnapshot
): DashboardVisuals {
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
  const payments = review.payments.filter((payment) => {
    const date = savedDate(payment.blockTime)
    return date !== null && Number(date.slice(0, 4)) === report.year
  })
  const settled = payments.filter((payment) => payment.status === 'settled')
  const allPayments = snapshot?.payments ?? [...review.payments, ...review.undatedPayments]
  const savedRecordKeys = new Set([
    ...allPayments.map((payment) => `payment:${payment.nodeIdx}`),
    ...(snapshot?.invoices ?? [...review.invoices, ...review.undatedInvoices]).map(
      (invoice) => `invoice:${invoice.id}`
    )
  ])
  const ids = counts(allPayments, (payment) => String(payment.nodeIdx))
  // Shared transaction IDs can represent multiple outputs or own transfers.
  // Without output identity we conservatively omit all such EUR observations.
  const txids = counts(allPayments, (payment) => payment.txid?.trim().toLowerCase() || null)
  const accounts = new Map(scope.accounts.map((entry) => [entry.id, entry]))
  const assets = new Map(scope.assets.map((entry) => [entry.id, entry]))
  const assignments = new Map(scope.assignments.map((entry) => [entry.recordKey, entry]))
  const enrichments = new Map(scope.enrichments?.map((entry) => [entry.recordKey, entry]))
  const conflictingSources = new Set(
    report.rows.filter((row) => row.sourceStatus === 'conflict').map((row) => row.sourceId)
  )
  const coverage: DashboardVisuals['coverage'] = {
    datedSettled: settled.length,
    notSettled: payments.length - settled.length,
    undated: review.undatedPayments.length,
    otherYear: review.excludedPayments,
    testOrDemo: 0,
    unknownSource: 0,
    conflictingSource: 0,
    duplicatePayments: 0,
    unvaluedPayments: 0,
    invalidPaymentDetails: 0
  }
  const months = monthLabels.map((label, index) => ({
    month: index + 1,
    label,
    incoming: 0n,
    outgoing: 0n,
    incomingCount: 0,
    outgoingCount: 0,
    incomingValued: 0,
    outgoingValued: 0
  }))
  let documented = 0
  let eligiblePayments = 0
  for (const payment of settled) {
    const date = savedDate(payment.blockTime)!
    const month = months[Number(date.slice(5, 7)) - 1]
    if (payment.direction === 'in') month.incomingCount++
    if (payment.direction === 'out') month.outgoingCount++
    const source = readLedgerSource(payment.source)
    const key = `payment:${payment.nodeIdx}`
    const assignment = assignments.get(key)
    const account = accounts.get(assignment?.accountId ?? '')
    const asset = assets.get(assignment?.assetId ?? '')
    const savedEnrichment = enrichments.get(key)
    const enrichment =
      assignment &&
      savedEnrichment?.accountId === assignment.accountId &&
      savedEnrichment.assetId === assignment.assetId
        ? savedEnrichment
        : undefined
    const value = evidencedValue(enrichment, date)
    const duplicate =
      (ids.get(String(payment.nodeIdx)) ?? 0) > 1 ||
      (txids.get(payment.txid?.trim().toLowerCase() ?? '') ?? 0) > 1
    const test = source?.backend === 'mock' || source?.asset.environment === 'test'
    const unknown = !source || source.asset.environment === 'unknown'
    const conflict = Boolean(source && conflictingSources.has(source.id))
    const raw = rawLedgerAmount(payment.receivedRaw)
    const validDetails = Boolean(
      assignment &&
      account?.taxpayerId === taxpayer.id &&
      source &&
      account.sourceId === source.id &&
      asset &&
      asset.canonicalId === source.asset.canonicalId &&
      asset.symbol === source.asset.symbol &&
      asset.network === source.asset.network &&
      asset.decimals === source.asset.decimals &&
      asset.environment === source.asset.environment &&
      raw !== null &&
      raw > 0n &&
      payment.txid?.trim() &&
      ['in', 'out'].includes(payment.direction)
    )
    if (test) coverage.testOrDemo++
    if (unknown) coverage.unknownSource++
    if (conflict) coverage.conflictingSource++
    if (duplicate) coverage.duplicatePayments++
    if (value === null) coverage.unvaluedPayments++
    if (!validDetails) coverage.invalidPaymentDetails++

    const related = enrichment?.relatedRecordKey
      ? assignments.get(enrichment.relatedRecordKey)
      : undefined
    const relatedValid =
      !enrichment ||
      !['own-transfer', 'refund'].includes(enrichment.classification) ||
      (related &&
        savedRecordKeys.has(enrichment.relatedRecordKey) &&
        accounts.get(related.accountId)?.taxpayerId === taxpayer.id &&
        enrichment.relatedRecordKey !== key)
    if (
      validDetails &&
      !duplicate &&
      !conflict &&
      value !== null &&
      relatedValid &&
      !enrichmentGaps([enrichment]).length &&
      !feeGaps([enrichment]).length
    )
      documented++

    if (!validDetails || test || unknown || conflict || duplicate || value === null) continue
    eligiblePayments++
    if (payment.direction === 'in') {
      month.incoming += value
      month.incomingValued++
    } else {
      month.outgoing += value
      month.outgoingValued++
    }
  }

  const mode = eligiblePayments ? 'eur' : 'count'
  const bars = months.map((month) => ({
    ...month,
    inValue: mode === 'eur' ? month.incoming : BigInt(month.incomingCount),
    outValue: mode === 'eur' ? month.outgoing : BigInt(month.outgoingCount)
  }))
  const maximum = bars.reduce(
    (max, month) => [month.inValue, month.outValue].reduce((a, b) => (a > b ? a : b), max),
    0n
  )
  const ratio = (value: bigint): number =>
    maximum === 0n ? 0 : Number((value * 1000000n) / maximum) / 1000000
  const amount = (value: bigint, count: number): string | null =>
    mode === 'eur' ? (count ? formatLedgerRaw(value, 8) : null) : value.toString()
  const incoming = bars.reduce((sum, month) => sum + month.inValue, 0n)
  const outgoing = bars.reduce((sum, month) => sum + month.outValue, 0n)
  return {
    scopeKey,
    year: report.year,
    reviewed: { documented, total: settled.length, needsDetails: settled.length - documented },
    activity: {
      mode,
      months: bars.map((month) => ({
        month: month.month,
        label: month.label,
        incoming: amount(month.inValue, month.incomingValued),
        outgoing: amount(month.outValue, month.outgoingValued),
        incomingRatio: ratio(month.inValue),
        outgoingRatio: ratio(month.outValue),
        incomingCount: month.incomingCount,
        outgoingCount: month.outgoingCount
      })),
      incoming: amount(
        incoming,
        bars.reduce((sum, month) => sum + month.incomingValued, 0)
      ),
      outgoing: amount(
        outgoing,
        bars.reduce((sum, month) => sum + month.outgoingValued, 0)
      ),
      eligiblePayments,
      totalPayments: settled.length,
      scaleMaximum: mode === 'eur' ? formatLedgerRaw(maximum, 8) : maximum.toString()
    },
    coverage,
    limitations: [
      'Saved payment status is not live network verification. Dates use Europe/Rome.',
      'Payment details documented means saved purpose, EUR evidence and fee details are present; it does not verify those declarations or establish tax readiness.',
      mode === 'eur'
        ? 'EUR values include only settled payments with matching saved account and asset details and same-day documented EUR evidence. Missing, test, unknown, conflicting and duplicate observations are excluded.'
        : 'Counts show dated settled payment records, including test/demo and unknown sources. They are not EUR amounts or a count of unique transactions.',
      'Received money is not taxable profit. Invoice requests are not added to payment observations. Full saved payment values are shown; ownership shares and fees are not deducted.',
      'Coverage counts can overlap. No exchange rates, wallet balances or live network data were fetched.',
      snapshot
        ? 'Repeated saved payment IDs or transaction IDs anywhere in the saved database are excluded from EUR values until reconciled.'
        : 'Duplicate checks cover the selected-year and undated report records only.'
    ]
  }
}
