import type { KasaPayment, KasaSnapshot } from '../../preload/index.d'
import { readLedgerSource } from '../../shared/ledger-source'
import { personalBtcRules } from '../../shared/personal-btc-rules'
import { observedSources } from '../../shared/tax-activity'
import type { TaxEnrichment } from '../../shared/tax-enrichment'
import type {
  TaxAccount,
  TaxAsset,
  TaxAssignment,
  Taxpayer,
  TaxScope
} from '../../shared/tax-scope'
import { rawLedgerAmount } from './ledger-amount'
import type { TaxReport } from './tax-report'

export type PersonalDisposalRow = {
  recordKey: string
  label: string
  proceedsEur: string | null
  costBasisEur: string | null
  gainEur: string | null
  reasons: string[]
}
export type PersonalDisposalEstimate = {
  scopeKey: string
  status: 'unsupported' | 'blocked' | 'estimate'
  reasons: string[]
  rows: PersonalDisposalRow[]
  netGainEur: string | null
  taxEur: string | null
  ratePercent: 26 | 33 | null
  excluded: { count: number; details: string[] }
  limitations: string[]
}

const scale = 100000000n
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
function decimal(value: string, maxDigits = 30): bigint | null {
  if (!new RegExp(`^(0|[1-9][0-9]{0,${maxDigits - 1}})(\\.[0-9]{1,8})?$`).test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * scale + BigInt(fraction.padEnd(8, '0'))
}
function format(value: bigint, precision = 8): string {
  const digits = (value < 0n ? -value : value).toString().padStart(precision + 1, '0')
  return `${value < 0n ? '-' : ''}${digits.slice(0, -precision)}.${digits.slice(-precision)}`
}
function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

type DisposalFactsContext = {
  databaseId: string
  taxpayer: Taxpayer | undefined
  assignment: TaxAssignment | undefined
  account: TaxAccount | undefined
  asset: TaxAsset | undefined
  payment: KasaPayment | undefined
  enrichment: TaxEnrichment | undefined
}
function savedFacts(context: DisposalFactsContext): string {
  const { databaseId, taxpayer, assignment, account, asset, payment, enrichment } = context
  return stable({
    version: 1,
    databaseId,
    taxpayer: taxpayer ? { id: taxpayer.id, profile: taxpayer.profile } : null,
    assignment,
    account,
    asset,
    payment: payment
      ? {
          nodeIdx: payment.nodeIdx,
          direction: payment.direction,
          source: payment.source,
          receivedRaw: payment.receivedRaw,
          status: payment.status,
          txid: payment.txid,
          blockTime: payment.blockTime
        }
      : null,
    enrichment
  })
}

// A saved allocation belongs to these exact facts. Answers, cost allocations and
// unrelated records are deliberately absent so saving evidence cannot change its key.
export function createDisposalFacts(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  recordKey: string
): string {
  const assignment = scope.assignments.find((entry) => entry.recordKey === recordKey)
  const account = scope.accounts.find((entry) => entry.id === assignment?.accountId)
  const asset = scope.assets.find((entry) => entry.id === assignment?.assetId)
  const taxpayer = scope.taxpayers.find((entry) => entry.id === account?.taxpayerId)
  const payment = snapshot.payments.find((entry) => `payment:${entry.nodeIdx}` === recordKey)
  const enrichment = scope.enrichments?.find((entry) => entry.recordKey === recordKey)
  return savedFacts({
    databaseId: scope.databaseId,
    taxpayer,
    assignment,
    account,
    asset,
    payment,
    enrichment
  })
}

// This is arithmetic over saved observations and documented user allocations.
// It neither matches acquisition lots nor establishes an annual tax liability.
export function buildPersonalDisposalEstimate(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  report: TaxReport | null
): PersonalDisposalEstimate {
  const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
  const profile = taxpayer?.profile
  const result: PersonalDisposalEstimate = {
    scopeKey: JSON.stringify([scope.databaseId, taxpayer?.id ?? null, profile?.taxYear ?? null]),
    status: 'unsupported',
    reasons: [],
    rows: [],
    netGainEur: null,
    taxEur: null,
    ratePercent: null,
    excluded: { count: 0, details: [] },
    limitations: [...personalBtcRules.limitations]
  }
  if (
    !taxpayer ||
    !profile ||
    profile.country !== 'IT' ||
    profile.userType !== 'personal' ||
    profile.personalRegime !== 'dichiarativo' ||
    ![2025, 2026].includes(profile.taxYear)
  ) {
    result.reasons.push(
      'This subtotal supports Italian personal dichiarativo profiles for 2025 and 2026 only.'
    )
    return result
  }
  result.status = 'blocked'
  result.ratePercent = personalBtcRules.rates[profile.taxYear as 2025 | 2026]
  if (
    !report ||
    report.scopeKey !== result.scopeKey ||
    report.taxpayer.id !== taxpayer.id ||
    report.year !== profile.taxYear
  ) {
    result.reasons.push('Reload the saved report for the selected profile and tax year.')
    return result
  }
  if (profile.recordsCoverage !== 'complete')
    result.reasons.push(
      'Confirm complete transaction history, including external accounts, before using documented LIFO allocations.'
    )

  const accounts = new Map(scope.accounts.map((entry) => [entry.id, entry]))
  const assets = new Map(scope.assets.map((entry) => [entry.id, entry]))
  const assignments = new Map(scope.assignments.map((entry) => [entry.recordKey, entry]))
  const enrichments = new Map(scope.enrichments?.map((entry) => [entry.recordKey, entry]))
  const bases = new Map(
    scope.disposalBases
      ?.filter((entry) => entry.taxpayerId === taxpayer.id && entry.taxYear === profile.taxYear)
      .map((entry) => [entry.recordKey, entry])
  )
  const payments = new Map(snapshot.payments.map((entry) => [`payment:${entry.nodeIdx}`, entry]))
  const conflicts = new Set(
    observedSources(snapshot)
      .filter((entry) => entry.conflict)
      .map((entry) => entry.source.id)
  )
  const owned = (payment: KasaPayment): boolean =>
    accounts.get(assignments.get(`payment:${payment.nodeIdx}`)?.accountId ?? '')?.taxpayerId ===
    taxpayer.id
  const txids = new Map<string, number>()
  const paymentIds = new Map<string, number>()
  for (const payment of snapshot.payments) {
    const key = `payment:${payment.nodeIdx}`
    paymentIds.set(key, (paymentIds.get(key) ?? 0) + 1)
    if (owned(payment) && payment.txid?.trim()) {
      const txid = payment.txid.trim().toLowerCase()
      txids.set(txid, (txids.get(txid) ?? 0) + 1)
    }
  }
  const exclusions = new Map<string, number>()
  const exclude = (reason: string, count = 1): void => {
    if (!count) return
    result.excluded.count += count
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + count)
  }
  exclude('Invoice requests are not disposal payments', snapshot.invoices.length)
  for (const payment of snapshot.payments) {
    const recordKey = `payment:${payment.nodeIdx}`
    const assignment = assignments.get(recordKey)
    const account = accounts.get(assignment?.accountId ?? '')
    if (!assignment || !account || account.taxpayerId !== taxpayer.id) {
      exclude('Payments without this taxpayer’s assignment')
      continue
    }
    const date = savedDate(payment.blockTime)
    if (date && Number(date.slice(0, 4)) !== profile.taxYear) {
      exclude('Payments dated outside the selected year')
      continue
    }
    if (payment.direction === 'in') {
      exclude('Incoming payments are not disposals')
      continue
    }
    const source = readLedgerSource(payment.source)
    const conflicting = source !== undefined && conflicts.has(source.id)
    if (!conflicting && (source?.backend === 'mock' || source?.asset.environment === 'test')) {
      exclude('Test or demo payments')
      continue
    }
    if (source && !conflicting && source.asset.canonicalId !== 'bitcoin') {
      exclude('Assets without the supported bitcoin canonical identity')
      continue
    }
    const row: PersonalDisposalRow = {
      recordKey,
      label: `Payment ${payment.nodeIdx}`,
      proceedsEur: null,
      costBasisEur: null,
      gainEur: null,
      reasons: []
    }
    const asset = assets.get(assignment.assetId)
    const enrichment = enrichments.get(recordKey)
    if (payment.direction !== 'out') row.reasons.push('Payment direction is unknown.')
    if (!date)
      row.reasons.push('The saved payment date is missing or invalid; its year is unknown.')
    if (payment.status !== 'settled') row.reasons.push('The saved payment is not settled.')
    if (!payment.txid?.trim()) row.reasons.push('A saved transaction ID is required.')
    if ((paymentIds.get(recordKey) ?? 0) > 1)
      row.reasons.push('Duplicate saved payment identifiers make this record ambiguous.')
    if (!source) row.reasons.push('Saved source and asset information is missing or invalid.')
    else {
      if (
        source.asset.canonicalId !== 'bitcoin' ||
        source.asset.network !== 'bitcoin' ||
        source.asset.environment !== 'live' ||
        source.asset.decimals !== 8
      )
        row.reasons.push('Only live Bitcoin network records with 8 decimal places are supported.')
      if (conflicting) row.reasons.push('Conflicting saved source metadata needs review.')
      if (account.sourceId !== source.id)
        row.reasons.push('The assigned account must match the saved source.')
      if (
        !asset ||
        asset.canonicalId !== source.asset.canonicalId ||
        asset.network !== source.asset.network ||
        asset.environment !== source.asset.environment ||
        asset.decimals !== source.asset.decimals ||
        asset.symbol !== source.asset.symbol
      )
        row.reasons.push('The assigned asset does not match the saved source metadata.')
    }
    if (account.ownershipBps !== 10000)
      row.reasons.push(
        'Full declared ownership is required; partial or unknown shares are unsupported.'
      )
    const raw = rawLedgerAmount(payment.receivedRaw)
    if (raw === null || raw <= 0n)
      row.reasons.push('The saved raw Bitcoin amount must be a positive safe integer.')
    const matched =
      enrichment?.accountId === assignment.accountId && enrichment.assetId === assignment.assetId
    if (!matched)
      row.reasons.push('Save tax details matching this payment’s current account and asset.')
    if (matched && enrichment.classification === 'own-transfer') {
      const related = payments.get(enrichment.relatedRecordKey)
      const relatedAssignment = assignments.get(enrichment.relatedRecordKey)
      const relatedAccount = accounts.get(relatedAssignment?.accountId ?? '')
      const relatedSource = readLedgerSource(related?.source)
      const relatedEnrichment = enrichments.get(enrichment.relatedRecordKey)
      if (
        !related ||
        !relatedAssignment ||
        relatedAccount?.taxpayerId !== taxpayer.id ||
        relatedAccount.ownershipBps !== 10000 ||
        relatedAccount.sourceId !== relatedSource?.id ||
        relatedAssignment.accountId === assignment.accountId ||
        relatedAssignment.assetId !== assignment.assetId ||
        related.direction !== 'in' ||
        related.status !== 'settled' ||
        related.receivedRaw !== payment.receivedRaw ||
        !relatedSource ||
        relatedSource.backend === 'mock' ||
        relatedSource.asset.canonicalId !== 'bitcoin' ||
        relatedSource.asset.network !== 'bitcoin' ||
        relatedSource.asset.environment !== 'live' ||
        relatedSource.asset.decimals !== 8 ||
        relatedSource.asset.symbol !== asset?.symbol ||
        conflicts.has(relatedSource.id) ||
        !related.txid?.trim() ||
        related.txid.trim().toLowerCase() !== payment.txid?.trim().toLowerCase() ||
        savedDate(related.blockTime) !== date ||
        relatedEnrichment?.accountId !== relatedAssignment.accountId ||
        relatedEnrichment.assetId !== relatedAssignment.assetId ||
        relatedEnrichment.classification !== 'own-transfer' ||
        relatedEnrichment.relatedRecordKey !== recordKey ||
        (txids.get(payment.txid?.trim().toLowerCase() ?? '') ?? 0) !== 2
      )
        row.reasons.push('Reconcile both sides of this own transfer before excluding it.')
      if (enrichment.fee.status !== 'none' || relatedEnrichment?.fee.status !== 'none')
        row.reasons.push(
          'Confirm no fees on both sides of this transfer; fees need separate tax treatment.'
        )
      if (!row.reasons.length) {
        exclude('Reconciled own transfers (disposal fees are outside this subtotal)')
        continue
      }
    } else {
      if ((txids.get(payment.txid?.trim().toLowerCase() ?? '') ?? 0) > 1)
        row.reasons.push(
          'The transaction ID appears in multiple taxpayer records; reconcile duplicates.'
        )
      if (!matched || !['sale', 'goods-services'].includes(enrichment.classification))
        row.reasons.push(
          'Only documented fiat sales or purchases of goods and services are supported.'
        )
    }
    if (matched) {
      const value = decimal(enrichment.valuation.eur)
      if (
        value === null ||
        !enrichment.valuation.source.trim() ||
        !enrichment.valuation.reference.trim() ||
        enrichment.valuation.date !== date
      )
        row.reasons.push(
          'Save the full EUR proceeds/value with evidence dated on the saved disposal day.'
        )
      else row.proceedsEur = format(value)
      if (enrichment.fee.status === 'unknown')
        row.reasons.push('Confirm whether this payment had a fee.')
      if (enrichment.fee.status === 'recorded') {
        const fee = decimal(enrichment.fee.amount)
        if (fee === null || fee > 0n)
          row.reasons.push(
            'Recorded positive fees need separate tax treatment; this version cannot include them.'
          )
        else if (
          !assets.has(enrichment.fee.assetId) ||
          !enrichment.fee.purpose.trim() ||
          !enrichment.fee.reference.trim() ||
          decimal(enrichment.fee.valuation.eur) !== 0n ||
          !enrichment.fee.valuation.date ||
          !enrichment.fee.valuation.source.trim() ||
          !enrichment.fee.valuation.reference.trim()
        )
          row.reasons.push(
            'A recorded zero fee still needs matching zero EUR value and complete evidence.'
          )
      }
    }
    const basis = bases.get(recordKey)
    const cost = basis ? decimal(basis.costBasisEur, 18) : null
    if (!basis || cost === null || !basis.reference.trim())
      row.reasons.push('Add a documented LIFO cost allocation for this disposal.')
    else {
      row.costBasisEur = format(cost)
      if (
        basis.facts !==
        savedFacts({
          databaseId: scope.databaseId,
          taxpayer,
          assignment,
          account,
          asset,
          payment,
          enrichment
        })
      )
        row.reasons.push(
          'The payment or its tax details changed; review and save its cost allocation again.'
        )
      if (!basis.reviewed)
        row.reasons.push(
          'Confirm review of the fiscal date, full acquisition history and ordinary LIFO allocation.'
        )
      if (
        !['fiat-sale', 'goods-services'].includes(basis.transactionKind) ||
        (basis.transactionKind === 'fiat-sale' && enrichment?.classification !== 'sale') ||
        (basis.transactionKind === 'goods-services' &&
          enrichment?.classification !== 'goods-services')
      )
        row.reasons.push('The documented disposal type does not match the saved payment purpose.')
    }
    if (!row.reasons.length && row.proceedsEur !== null && cost !== null)
      row.gainEur = format(decimal(row.proceedsEur)! - cost)
    result.rows.push(row)
  }
  result.excluded.details = [...exclusions].map(([reason, count]) => `${count}: ${reason}.`)
  if (!result.rows.length)
    result.reasons.push('No supported outgoing Bitcoin disposals are available for this year.')
  if (result.rows.some((row) => row.reasons.length))
    result.reasons.push('Resolve the listed payment issues before calculating this subtotal.')
  if (result.reasons.length) return result
  const net = result.rows.reduce((sum, row) => {
    const gain = row.gainEur!
    return sum + (gain.startsWith('-') ? -decimal(gain.slice(1))! : decimal(gain)!)
  }, 0n)
  result.status = 'estimate'
  result.netGainEur = format(net)
  // Aggregate signed gains first. Round only the resulting tax to the nearest cent.
  const taxCents = ((net > 0n ? net : 0n) * BigInt(result.ratePercent) + scale / 2n) / scale
  result.taxEur = format(taxCents, 2)
  return result
}
