import type { KasaSnapshot } from '../../preload/index.d'
import { readLedgerSource, type LedgerSource } from '../../shared/ledger-source'
import { observedSources } from '../../shared/tax-activity'
import { csvCell } from './invoice-csv'
import { formatLedgerRaw, rawLedgerAmount, savedLedgerAmount, ledgerDate } from './ledger-amount'

const date = (seconds: number): string => ledgerDate(seconds) || 'Date unavailable'
const amount = (value: number): string => value.toFixed(6)

export type LedgerTotal = { amount: string | null; records: number; unavailable: number }
export type LedgerSummaryGroup = {
  source?: LedgerSource
  conflict: boolean
  invoiceCount: number
  paymentCount: number
  unsettled: number
  requested: LedgerTotal
  received: LedgerTotal
  incoming: LedgerTotal
  outgoing: LedgerTotal
}
type SourceRecords = {
  source?: LedgerSource
  invoices: KasaSnapshot['invoices']
  payments: KasaSnapshot['payments']
}

function sourceKey(source: LedgerSource | undefined): string {
  return source ? JSON.stringify([source.id, source.backend, source.asset]) : 'unknown'
}

function conflicts(snapshot: KasaSnapshot): Set<string> {
  return new Set(
    observedSources(snapshot)
      .filter((item) => item.conflict)
      .map((item) => item.source.id)
  )
}

function total(
  values: unknown[],
  source: LedgerSource | undefined,
  conflict: boolean
): LedgerTotal {
  const raw = values.map(rawLedgerAmount)
  const unavailable =
    !source || conflict ? values.length : raw.filter((value) => value === null).length
  return {
    amount:
      !source || unavailable || !values.length
        ? null
        : formatLedgerRaw(
            raw.reduce<bigint>((sum, value) => sum + value!, 0n),
            source.asset.decimals
          ),
    records: values.length,
    unavailable
  }
}

// Each source/asset is separate. Invoice receipts and payment observations overlap;
// these columns are evidence from different records and must never be added together.
export function taxLedgerSummary(
  snapshot: KasaSnapshot,
  context: {
    conflictingSourceIds?: ReadonlySet<string>
    linkedInvoices?: KasaSnapshot['invoices']
  } = {}
): {
  invoiceCount: number
  underpaid: number
  overpaid: number
  unsettled: number
  unlinked: number
  undated: number
  groups: LedgerSummaryGroup[]
} {
  const conflicting = new Set([...conflicts(snapshot), ...(context.conflictingSourceIds ?? [])])
  const grouped = new Map<string, SourceRecords>()
  const groupFor = (value: unknown): SourceRecords => {
    const source = readLedgerSource(value)
    const key = sourceKey(source)
    let group = grouped.get(key)
    if (!group) {
      group = { source, invoices: [], payments: [] }
      grouped.set(key, group)
    }
    return group
  }
  for (const invoice of snapshot.invoices) groupFor(invoice.source).invoices.push(invoice)
  for (const payment of snapshot.payments) groupFor(payment.source).payments.push(payment)
  const invoiceIds = new Set(
    (context.linkedInvoices ?? snapshot.invoices).map((invoice) => invoice.id)
  )
  return {
    invoiceCount: snapshot.invoices.length,
    underpaid: snapshot.invoices.filter((invoice) => invoice.state === 'Underpaid').length,
    overpaid: snapshot.invoices.filter((invoice) => invoice.state === 'Overpaid').length,
    unsettled: snapshot.payments.filter((payment) => payment.status !== 'settled').length,
    unlinked: snapshot.payments.filter(
      (payment) => !payment.invoiceId || !invoiceIds.has(payment.invoiceId)
    ).length,
    undated: snapshot.payments.filter((payment) => !ledgerDate(payment.blockTime)).length,
    groups: [...grouped.values()].map(({ source, invoices, payments }) => {
      const conflict = !!source && conflicting.has(source.id)
      const settled = payments.filter((payment) => payment.status === 'settled')
      return {
        source,
        conflict,
        invoiceCount: invoices.length,
        paymentCount: payments.length,
        unsettled: payments.length - settled.length,
        requested: total(
          invoices.map((invoice) => invoice.amountRaw),
          source,
          conflict
        ),
        received: total(
          invoices.map((invoice) => invoice.receivedRaw),
          source,
          conflict
        ),
        incoming: total(
          settled
            .filter((payment) => payment.direction === 'in')
            .map((payment) => payment.receivedRaw),
          source,
          conflict
        ),
        outgoing: total(
          settled
            .filter((payment) => payment.direction === 'out')
            .map((payment) => payment.receivedRaw),
          source,
          conflict
        )
      }
    })
  }
}

export function searchLedger(snapshot: KasaSnapshot, query: string): string {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length)
    return 'Enter a client, invoice ID, transaction ID, amount, date (YYYY-MM-DD), or status.'
  const matches = (fields: string[]): boolean => {
    const text = fields.join(' ').toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  }
  const results: string[] = []
  for (const i of snapshot.invoices) {
    if (
      matches([
        i.client,
        i.id,
        `INV-${i.id.slice(0, 6)}`,
        i.state,
        amount(i.amount),
        amount(i.received),
        date(i.createdAt),
        date(i.expiresAt)
      ])
    )
      results.push(
        `Invoice ${i.id} | ${i.client} | ${i.state} | Amount ${amount(i.amount)} USDT | Recorded received ${amount(i.received)} USDT | Issued ${date(i.createdAt)} | Expires ${date(i.expiresAt)}`
      )
  }
  for (const p of snapshot.payments) {
    const invoice = snapshot.invoices.find((i) => i.id === p.invoiceId)
    const when = p.blockTime === null ? 'Date unavailable' : date(p.blockTime)
    if (
      matches([
        String(p.nodeIdx),
        p.invoiceId ?? '',
        invoice ? `INV-${invoice.id.slice(0, 6)}` : '',
        invoice?.client ?? '',
        p.txid ?? '',
        p.status,
        amount(p.received),
        when
      ])
    )
      results.push(
        `Payment ${p.nodeIdx} | ${invoice?.client ?? 'Unlinked payment'} | Invoice ${p.invoiceId ?? 'unlinked'} | ${p.status} | Observed ${amount(p.received)} USDT | Transaction ${p.txid ?? 'unavailable'} | ${when}`
      )
  }
  if (!results.length) return 'No matching recorded invoices or payments.'
  return `${results.length} matching records${results.length > 100 ? ' (showing first 100)' : ''}. Invoice and payment rows may describe the same funds; do not add them together.\n\n${results.slice(0, 100).join('\n\n')}`
}

const csvColumns = [
  'Record_Type',
  'Record_ID',
  'Invoice_ID',
  'Client',
  'Direction',
  'Requested_Amount',
  'Invoice_Received_Amount',
  'Payment_Observed_Amount',
  'Amount_Unit',
  'Requested_Raw',
  'Invoice_Received_Raw',
  'Payment_Observed_Raw',
  'Status',
  'Date_UTC',
  'Transaction_ID',
  'Source_ID',
  'Source_Label',
  'Backend',
  'Asset_ID',
  'Network',
  'Environment',
  'Decimals',
  'Notes'
] as const
type CsvRow = Partial<Record<(typeof csvColumns)[number], string>>

function csvSource(source: LedgerSource | undefined): CsvRow {
  return {
    Source_ID: source?.id ?? '',
    Source_Label: source?.label ?? '',
    Backend: source?.backend ?? '',
    Asset_ID: source?.asset.canonicalId ?? '',
    Network: source?.asset.network ?? '',
    Environment: source?.asset.environment ?? 'unknown',
    Decimals: source ? String(source.asset.decimals) : '',
    Amount_Unit: source?.asset.symbol ?? 'recorded app units'
  }
}

const rawCell = (value: unknown): string => (typeof value === 'number' ? String(value) : '')
function sourceNote(source: LedgerSource | undefined, conflict: boolean): string {
  if (!source)
    return 'Saved asset/source metadata missing or invalid. Recorded app units are unverified and are not totalled.'
  if (conflict)
    return 'Conflicting saved source metadata. Interpreted amounts and totals withheld; raw values retained for review.'
  return 'Asset identity and precision use saved metadata only; no wallet or network verification.'
}

function totalNote(total: LedgerTotal): string {
  return `${total.records} records; ${total.unavailable} unavailable. Any unavailable amount withholds the entire total.`
}

export function taxRecordsCsv(snapshot: KasaSnapshot): string {
  const conflicting = conflicts(snapshot)
  const invoices = new Map(snapshot.invoices.map((invoice) => [invoice.id, invoice]))
  const rows: CsvRow[] = [
    {
      Record_Type: 'Scope',
      Notes:
        'All recorded dates and all profiles in the app database. Amounts remain separate by saved asset, network, environment and source. Not a tax calculation or audited report.'
    },
    {
      Record_Type: 'Limitations',
      Notes:
        'No EUR conversion, tax basis or VAT calculation. Tax liability is not calculated. Invoice receipts and payment observations can describe the same funds; do not add them together. Settled is a saved status, not a current network check. Test/demo and unknown-environment records are separate from live records.'
    }
  ]
  for (const group of taxLedgerSummary(snapshot).groups) {
    const metadata = csvSource(group.source)
    const note = sourceNote(group.source, group.conflict)
    if (group.invoiceCount)
      rows.push({
        ...metadata,
        Record_Type: 'Invoice totals',
        Requested_Amount: group.requested.amount ?? 'Unavailable',
        Invoice_Received_Amount: group.received.amount ?? 'Unavailable',
        Notes: `${note} Requested: ${totalNote(group.requested)} Receipts: ${totalNote(group.received)} Invoice rows only; receipts are not taxable revenue.`
      })
    for (const [direction, total] of [
      ['in', group.incoming],
      ['out', group.outgoing]
    ] as const) {
      if (!total.records) continue
      rows.push({
        ...metadata,
        Record_Type: 'Settled payment observations',
        Direction: direction,
        Payment_Observed_Amount: total.amount ?? 'Unavailable',
        Status: 'settled',
        Notes: `${note} ${totalNote(total)} Observation rows only; exclude pending/failed/unknown statuses. Do not add to invoice totals or treat as a balance.`
      })
    }
  }
  for (const invoice of snapshot.invoices) {
    const source = readLedgerSource(invoice.source)
    const conflict = !!source && conflicting.has(source.id)
    const requested = savedLedgerAmount(source, invoice.amountRaw, invoice.amount)
    const received = savedLedgerAmount(source, invoice.receivedRaw, invoice.received)
    rows.push({
      ...csvSource(source),
      Record_Type: 'Invoice',
      Record_ID: invoice.id,
      Invoice_ID: invoice.id,
      Client: invoice.client,
      Requested_Amount: conflict ? 'Unavailable' : requested.amount,
      Invoice_Received_Amount: conflict ? 'Unavailable' : received.amount,
      Requested_Raw: rawCell(invoice.amountRaw),
      Invoice_Received_Raw: rawCell(invoice.receivedRaw),
      Status: invoice.state,
      Date_UTC: ledgerDate(invoice.createdAt),
      Notes: `${sourceNote(source, conflict)} Expires ${date(invoice.expiresAt)}. ${!ledgerDate(invoice.createdAt) ? 'Issue date unavailable. ' : ''}${requested.amount === 'Unavailable' || received.amount === 'Unavailable' ? 'Amount missing or unsafe; no converted fallback used for a known asset.' : ''}`
    })
  }
  for (const payment of snapshot.payments) {
    const source = readLedgerSource(payment.source)
    const conflict = !!source && conflicting.has(source.id)
    const observed = savedLedgerAmount(source, payment.receivedRaw, payment.received)
    rows.push({
      ...csvSource(source),
      Record_Type: 'Payment observation',
      Record_ID: String(payment.nodeIdx),
      Invoice_ID: payment.invoiceId ?? '',
      Client: invoices.get(payment.invoiceId ?? '')?.client ?? '',
      Direction: payment.direction,
      Payment_Observed_Amount: conflict ? 'Unavailable' : observed.amount,
      Payment_Observed_Raw: rawCell(payment.receivedRaw),
      Status: payment.status,
      Date_UTC: ledgerDate(payment.blockTime),
      Transaction_ID: payment.txid ?? '',
      Notes: `${sourceNote(source, conflict)} Observation only; may be pending or failed. Do not add to invoice totals. ${!ledgerDate(payment.blockTime) ? 'Date unavailable. ' : ''}${observed.amount === 'Unavailable' ? 'Amount missing or unsafe; no converted fallback used for a known asset.' : ''}`
    })
  }
  return (
    [csvColumns, ...rows.map((row) => csvColumns.map((column) => row[column] ?? ''))]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  )
}
