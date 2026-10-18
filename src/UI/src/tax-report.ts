import type { KasaSnapshot } from '../../preload/index.d'
import { observedSources } from '../../shared/tax-activity'
import { recordTaxpayerMap } from '../../shared/tax-record-profile'
import { taxScopeKey } from '../../shared/tax-selection'
import { recordKeys, scopedRecords, type Taxpayer, type TaxScope } from '../../shared/tax-scope'
import { taxLedgerSummary, type LedgerSummaryGroup } from './ledger'
import {
  taxYearReview,
  taxYearRows,
  taxYearRowsCsv,
  type TaxYearReview,
  type TaxYearRow
} from './tax-year-ledger'

export type TaxReportSummary = Omit<ReturnType<typeof taxLedgerSummary>, 'groups'> & {
  groups: Omit<LedgerSummaryGroup, 'received'>[]
}

export type TaxReport = {
  taxpayer: Taxpayer
  year: number
  scopeKey: string
  summary: TaxReportSummary
  rows: TaxYearRow[]
  review: TaxYearReview
  unassigned: number
  orphaned: number
  profileOnly: number
  partialOwnership: number
  unknownOwnership: number
}

// Reporting reads saved profile relationships, declarations and ledger records.
// A profile relationship does not establish an account, asset or ownership share.
export function buildTaxReport(scope: TaxScope, snapshot: KasaSnapshot): TaxReport | null {
  const scopeKey = taxScopeKey(scope)
  const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
  if (!scopeKey || !taxpayer) return null
  const year = taxpayer.profile.taxYear
  const taxpayers = new Set(scope.taxpayers.map((entry) => entry.id))
  const accounts = new Map(scope.accounts.map((account) => [account.id, account]))
  const assets = new Set(scope.assets.map((asset) => asset.id))
  const assignments = scope.assignments.filter((assignment) => {
    const account = accounts.get(assignment.accountId)
    return account && taxpayers.has(account.taxpayerId) && assets.has(assignment.assetId)
  })
  const owners = recordTaxpayerMap(scope)
  const recordProfiles = scope.recordProfiles?.filter(
    (entry) => owners.get(entry.recordKey) === entry.taxpayerId
  )
  const selected = scopedRecords({ ...scope, assignments, recordProfiles }, snapshot, taxpayer.id)
  const review = taxYearReview(selected, year)
  const conflictingSourceIds = new Set(
    observedSources(snapshot)
      .filter((source) => source.conflict)
      .map((source) => source.source.id)
  )
  const summary = taxLedgerSummary(
    { invoices: review.invoices, payments: review.payments, proposals: [] },
    { conflictingSourceIds, linkedInvoices: selected.invoices }
  )
  const keys = recordKeys(snapshot)
  const assigned = new Set(assignments.map((assignment) => assignment.recordKey))
  const related = new Set([...assigned, ...(recordProfiles ?? []).map((entry) => entry.recordKey)])
  const reviewedKeys = recordKeys({
    invoices: [...review.invoices, ...review.undatedInvoices],
    payments: [...review.payments, ...review.undatedPayments],
    proposals: []
  })
  const selectedAccounts = scope.accounts.filter((account) => account.taxpayerId === taxpayer.id)
  return {
    taxpayer,
    year,
    scopeKey,
    summary: {
      ...summary,
      // Invoice receipts are cumulative and cannot be attributed to the selected year.
      groups: summary.groups.map((group) => ({
        source: group.source,
        conflict: group.conflict,
        invoiceCount: group.invoiceCount,
        paymentCount: group.paymentCount,
        unsettled: group.unsettled,
        requested: group.requested,
        incoming: group.incoming,
        outgoing: group.outgoing
      }))
    },
    rows: taxYearRows(selected, review, conflictingSourceIds),
    review,
    unassigned: [...keys].filter((key) => !related.has(key)).length,
    orphaned: new Set(
      [
        ...scope.assignments
          .filter((assignment) => accounts.get(assignment.accountId)?.taxpayerId === taxpayer.id)
          .map((assignment) => assignment.recordKey),
        ...(recordProfiles ?? [])
          .filter((entry) => entry.taxpayerId === taxpayer.id)
          .map((entry) => entry.recordKey)
      ].filter((key) => !keys.has(key))
    ).size,
    profileOnly: [...reviewedKeys].filter((key) => !assigned.has(key)).length,
    partialOwnership: selectedAccounts.filter(
      (account) => account.ownershipBps !== null && account.ownershipBps < 10000
    ).length,
    unknownOwnership: selectedAccounts.filter((account) => account.ownershipBps === null).length
  }
}

export function taxReportCsv(report: TaxReport): string {
  const { taxpayer, year, review } = report
  return taxYearRowsCsv(report.rows, [
    {
      type: 'Scope',
      text: `Taxpayer: ${taxpayer.label}; ID: ${taxpayer.id}; type: ${taxpayer.profile.userType}; saved tax year: ${year}; country: ${taxpayer.profile.country}. Only records linked or assigned to this profile are included. Europe/Rome year boundaries; invoice issue dates and payment block dates are filtered separately. Linked undated records remain year-unassigned and are excluded from year totals.`
    },
    {
      type: 'Exclusions',
      text: `Other-year records for this profile excluded: ${review.excludedInvoices} invoices, ${review.excludedPayments} payments. Undated records included for review only: ${review.undatedInvoices.length} invoices, ${review.undatedPayments.length} payments. Database-wide records without a valid profile relationship or assignment excluded: ${report.unassigned}. Relationships for this profile without a saved record: ${report.orphaned}. Records belonging to other profiles are excluded.`
    },
    {
      type: 'Ownership',
      text: `Full saved amounts are shown; ownership shares are not applied. Records linked to this profile that still need account, asset and ownership review: ${report.profileOnly}. Accounts for this profile with partial ownership: ${report.partialOwnership}; unknown ownership: ${report.unknownOwnership}. Declared ownership is not independently verified.`
    },
    {
      type: 'Limitations',
      text: 'Not a tax calculation or audited report. No EUR conversion or tax liability calculated. Invoice requests and payment observations can describe the same funds; do not sum them. Cumulative invoice receipts are omitted because they may span years. Settled is a saved status, not current network verification. Saved source metadata is not live verification; conflicting, test and unknown sources require review.'
    }
  ])
}
