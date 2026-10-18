import type { KasaInvoice, KasaPayment, KasaSnapshot } from '../preload/index.d'
import { readLedgerSource, type LedgerSource } from './ledger-source'
import { changeTaxScope, type TaxAssignment, type TaxAsset, type TaxScope } from './tax-scope'
import { recordTaxpayerMap } from './tax-record-profile'

export type ObservedLedgerSource = {
  source: LedgerSource
  recordKeys: string[]
  invoiceCount: number
  paymentCount: number
  conflict: boolean
}

function sourceIdentity(source: LedgerSource): string {
  return JSON.stringify([source.backend, source.asset])
}

// Only metadata actually saved with a record can establish its source. A changed
// configuration must never retroactively supply an identity to legacy records.
export function observedSources(snapshot: KasaSnapshot): ObservedLedgerSource[] {
  const sources = new Map<string, ObservedLedgerSource>()
  const seen = new Map<string, Set<string>>()
  const records = [
    ...snapshot.invoices.map((invoice) => ({
      key: `invoice:${invoice.id}`,
      source: invoice.source,
      invoice: true
    })),
    ...snapshot.payments.map((payment) => ({
      key: `payment:${payment.nodeIdx}`,
      source: payment.source,
      invoice: false
    }))
  ]
  for (const record of records) {
    const source = readLedgerSource(record.source)
    if (!source) continue
    let observed = sources.get(source.id)
    if (!observed) {
      observed = { source, recordKeys: [], invoiceCount: 0, paymentCount: 0, conflict: false }
      sources.set(source.id, observed)
      seen.set(source.id, new Set())
    } else if (sourceIdentity(source) !== sourceIdentity(observed.source)) observed.conflict = true
    const keys = seen.get(source.id)!
    if (keys.has(record.key)) continue
    keys.add(record.key)
    observed.recordKeys.push(record.key)
    if (record.invoice) observed.invoiceCount++
    else observed.paymentCount++
  }
  return [...sources.values()]
}

function matchingAsset(scope: TaxScope, source: LedgerSource): TaxAsset | undefined {
  return scope.assets.find(
    (asset) =>
      asset.canonicalId === source.asset.canonicalId &&
      asset.network === source.asset.network &&
      asset.environment === source.asset.environment
  )
}

export function bindLedgerSource(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  input: unknown,
  id: string
): TaxScope {
  if (!input || typeof input !== 'object') throw new Error('Invalid source binding.')
  const command = input as Record<string, unknown>
  const observed = observedSources(snapshot).find((item) => item.source.id === command.sourceId)
  if (!observed || observed.conflict)
    throw new Error(
      'This saved source is missing or has conflicting metadata. Review its records first.'
    )
  if (!scope.taxpayers.some((taxpayer) => taxpayer.id === command.taxpayerId))
    throw new Error('Select an existing profile.')
  const existingBinding = scope.accounts.find((account) => account.sourceId === command.sourceId)
  if (existingBinding && existingBinding.id !== command.accountId)
    throw new Error(
      'This source is already linked to an account. Stop that link before changing ownership.'
    )
  let next = structuredClone(scope)
  let account = next.accounts.find((candidate) => candidate.id === command.accountId)
  if (command.accountId !== undefined) {
    if (!account || account.taxpayerId !== command.taxpayerId)
      throw new Error('Select an account owned by this profile.')
    if (account.ownershipBps === null)
      throw new Error('Confirm account ownership before linking this source.')
    if (account.sourceId && account.sourceId !== command.sourceId)
      throw new Error('This account already has a different source link.')
  } else {
    if (!Number.isInteger(command.ownershipBps))
      throw new Error('Confirm account ownership before linking this source.')
    next = changeTaxScope(
      next,
      {
        kind: 'account',
        taxpayerId: command.taxpayerId,
        label: command.label ?? observed.source.label,
        ownershipBps: command.ownershipBps,
        accountKind: command.accountKind ?? 'unknown'
      },
      null,
      new Set(),
      id
    )
    account = next.accounts[next.accounts.length - 1]
  }
  const asset = matchingAsset(next, observed.source)
  if (
    asset &&
    (asset.decimals !== observed.source.asset.decimals ||
      asset.symbol !== observed.source.asset.symbol)
  )
    throw new Error(
      'Saved asset metadata conflicts with an existing asset. Review its precision and symbol first.'
    )
  if (!asset)
    next = changeTaxScope(
      next,
      { kind: 'asset', ...observed.source.asset },
      null,
      new Set(),
      `${id}-asset`
    )
  // changeTaxScope clones the state; select the final account before binding it.
  next.accounts.find((candidate) => candidate.id === account!.id)!.sourceId = observed.source.id
  return organiseTaxActivity(next, snapshot)
}

// Fills gaps only. This deliberately never uses the manual reassignment command,
// which may clear tax enrichment and links when a user explicitly changes scope.
export function organiseTaxActivity(scope: TaxScope, snapshot: KasaSnapshot): TaxScope {
  const assigned = new Set(scope.assignments.map((assignment) => assignment.recordKey))
  const excluded = new Set(scope.autoAssignmentExclusions ?? [])
  const owners = recordTaxpayerMap(scope)
  const additions: TaxAssignment[] = []
  for (const observed of observedSources(snapshot)) {
    if (observed.conflict) continue
    const account = scope.accounts.find((candidate) => candidate.sourceId === observed.source.id)
    const asset = matchingAsset(scope, observed.source)
    if (
      !account ||
      account.ownershipBps === null ||
      !asset ||
      asset.decimals !== observed.source.asset.decimals ||
      asset.symbol !== observed.source.asset.symbol
    )
      continue
    for (const recordKey of observed.recordKeys) {
      if (assigned.has(recordKey) || excluded.has(recordKey)) continue
      const taxpayerId = owners.get(recordKey)
      if (taxpayerId && taxpayerId !== account.taxpayerId) continue
      additions.push({ recordKey, accountId: account.id, assetId: asset.id })
      assigned.add(recordKey)
    }
  }
  return additions.length ? { ...scope, assignments: [...scope.assignments, ...additions] } : scope
}

export type TaxActivityRow = {
  recordKey: string
  kind: 'payment' | 'request'
  payment?: KasaPayment
  invoice?: KasaInvoice
  assignment?: TaxAssignment
  taxpayerId?: string
  environment: 'live' | 'test' | 'unknown'
  status: 'settled' | 'pending' | 'failed' | 'unknown' | 'request'
}

export function activityRows(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  taxpayerId?: string,
  includeUnassigned = false
): TaxActivityRow[] {
  const assignments = new Map(
    scope.assignments.map((assignment) => [assignment.recordKey, assignment])
  )
  const owners = recordTaxpayerMap(scope)
  const owner = (key: string): string | undefined => owners.get(key)
  const includes = (key: string): boolean =>
    taxpayerId === undefined || owner(key) === taxpayerId || (includeUnassigned && !owner(key))
  // Apply visibility before reconciliation: a hidden payment must not consume
  // an unassigned request that remains visible in the selected profile's review.
  const payments = snapshot.payments.filter((payment) => includes(`payment:${payment.nodeIdx}`))
  const visibleInvoices = snapshot.invoices.filter((invoice) => includes(`invoice:${invoice.id}`))
  const invoices = new Map(visibleInvoices.map((invoice) => [invoice.id, invoice]))
  const coveredInvoices = new Set<string>()
  const seenPayments = new Set<number>()
  const rows: TaxActivityRow[] = []
  for (const payment of payments) {
    const recordKey = `payment:${payment.nodeIdx}`
    if (seenPayments.has(payment.nodeIdx)) continue
    seenPayments.add(payment.nodeIdx)
    const linked =
      payment.direction === 'in' && payment.invoiceId ? invoices.get(payment.invoiceId) : undefined
    // A linked request is evidence, not a second payment. Keep another
    // taxpayer's request separate even when a caller later filters all rows.
    const invoiceOwner = linked ? owner(`invoice:${linked.id}`) : undefined
    const paymentSource = readLedgerSource(payment.source)
    const invoiceSource = readLedgerSource(linked?.source)
    const compatibleSource =
      !paymentSource ||
      !invoiceSource ||
      (paymentSource.id === invoiceSource.id &&
        sourceIdentity(paymentSource) === sourceIdentity(invoiceSource))
    const invoice =
      linked && compatibleSource && (!invoiceOwner || invoiceOwner === owner(recordKey))
        ? linked
        : undefined
    if (invoice) coveredInvoices.add(invoice.id)
    const status =
      payment.status === 'settled'
        ? 'settled'
        : payment.status === 'failed'
          ? 'failed'
          : ['waiting', 'confirming', 'pending'].includes(payment.status)
            ? 'pending'
            : 'unknown'
    rows.push({
      recordKey,
      kind: 'payment',
      payment,
      invoice,
      assignment: assignments.get(recordKey),
      taxpayerId: owner(recordKey),
      environment: readLedgerSource(payment.source)?.asset.environment ?? 'unknown',
      status
    })
  }
  const seenInvoices = new Set<string>()
  for (const invoice of visibleInvoices) {
    const recordKey = `invoice:${invoice.id}`
    if (seenInvoices.has(invoice.id) || coveredInvoices.has(invoice.id)) continue
    seenInvoices.add(invoice.id)
    rows.push({
      recordKey,
      kind: 'request',
      invoice,
      assignment: assignments.get(recordKey),
      taxpayerId: owner(recordKey),
      environment: readLedgerSource(invoice.source)?.asset.environment ?? 'unknown',
      status: 'request'
    })
  }
  return rows
}

export function formatLedgerAmount(row: TaxActivityRow): string {
  const record = row.payment ?? row.invoice
  const source = readLedgerSource(record?.source)
  const raw = row.payment ? row.payment.receivedRaw : row.invoice?.amountRaw
  if (source && typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    const digits = String(raw).padStart(source.asset.decimals + 1, '0')
    const value = source.asset.decimals
      ? `${digits.slice(0, -source.asset.decimals)}.${digits.slice(-source.asset.decimals)}`.replace(
          /\.?0+$/,
          ''
        )
      : digits
    return `${value} ${source.asset.symbol}`
  }
  if (source) return 'Amount unavailable (raw amount missing or unsafe)'
  const legacyAmount = row.payment?.received ?? row.invoice?.amount
  return typeof legacyAmount === 'number' && Number.isFinite(legacyAmount)
    ? `${legacyAmount} recorded app units`
    : 'Amount unavailable'
}
