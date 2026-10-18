import { getDb } from './index'
import { readLedgerSource, type LedgerSource } from '../../shared/ledger-source'

export interface InvoiceRow {
  source?: LedgerSource
  id: string
  client: string
  amountRaw: number
  receivedRaw: number
  rgbInvoice: string
  recipientId: string
  expiresAt: number
  state: string
  createdAt: number
}

export interface PaymentRow {
  source?: LedgerSource
  nodeIdx: number
  direction: 'in' | 'out' // in: received, out: sent (receivedRaw = amount moved)
  invoiceId: string | null
  recipientId: string
  requestedRaw: number | null
  receivedRaw: number
  status: string
  txid: string | null
  blockTime: number | null
  receiveUtxo: string | null
  updatedAt: number
}

const INVOICE_COLS = `id, client, amount_raw AS amountRaw, received_raw AS receivedRaw,
  rgb_invoice AS rgbInvoice, recipient_id AS recipientId, expires_at AS expiresAt,
  state, created_at AS createdAt, source_json AS sourceJson`

const PAYMENT_COLS = `node_idx AS nodeIdx, direction, invoice_id AS invoiceId, recipient_id AS recipientId,
  requested_raw AS requestedRaw, received_raw AS receivedRaw, status, txid,
  block_time AS blockTime, receive_utxo AS receiveUtxo, updated_at AS updatedAt, source_json AS sourceJson`

function sourceRow<T extends InvoiceRow | PaymentRow>(row: unknown): T {
  const { sourceJson, ...record } = row as T & { sourceJson: string | null }
  let source: LedgerSource | undefined
  try {
    source = readLedgerSource(JSON.parse(sourceJson ?? 'null'))
  } catch {
    /* Unknown provenance. */
  }
  return { ...record, ...(source ? { source } : {}) } as unknown as T
}

// ---- invoices ----

export function insertInvoice(inv: InvoiceRow): void {
  getDb()
    .prepare(
      `INSERT INTO invoices (id, client, amount_raw, received_raw, rgb_invoice, recipient_id, expires_at, state, created_at, source_json)
       VALUES (@id, @client, @amountRaw, @receivedRaw, @rgbInvoice, @recipientId, @expiresAt, @state, @createdAt, @sourceJson)`
    )
    .run({ ...inv, sourceJson: inv.source ? JSON.stringify(inv.source) : null })
}

export function updateInvoiceState(id: string, state: string, receivedRaw: number): void {
  getDb()
    .prepare('UPDATE invoices SET state = ?, received_raw = ? WHERE id = ?')
    .run(state, receivedRaw, id)
}

export function listInvoices(): InvoiceRow[] {
  return getDb()
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices ORDER BY created_at DESC`)
    .all()
    .map((row) => sourceRow<InvoiceRow>(row))
}

export function getInvoiceByRecipient(recipientId: string): InvoiceRow | undefined {
  const row = getDb()
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE recipient_id = ?`)
    .get(recipientId)
  return row ? sourceRow<InvoiceRow>(row) : undefined
}

// ---- payments ----

// insert the first time we see a transfer, update its status/amount afterwards
export function upsertPayment(p: Omit<PaymentRow, 'blockTime'>): boolean {
  const existing = getPayment(p.nodeIdx)
  if (existing?.source && p.source && existing.source.id !== p.source.id)
    throw new Error(
      'This transfer number belongs to another saved app ledger stream. Existing activity was preserved; use a separate ledger for the changed configuration.'
    )
  return (
    getDb()
      .prepare(
        `INSERT INTO payments (node_idx, direction, invoice_id, recipient_id, requested_raw, received_raw, status, txid, receive_utxo, updated_at, source_json)
       VALUES (@nodeIdx, @direction, @invoiceId, @recipientId, @requestedRaw, @receivedRaw, @status, @txid, @receiveUtxo, @updatedAt, @sourceJson)

       ON CONFLICT(node_idx) DO UPDATE SET
         direction    = excluded.direction,
         recipient_id = excluded.recipient_id,
         requested_raw = excluded.requested_raw,
         receive_utxo = excluded.receive_utxo,
         received_raw = excluded.received_raw,
         status       = excluded.status,
         txid         = excluded.txid,
         updated_at   = excluded.updated_at,
         invoice_id = excluded.invoice_id,
         block_time = CASE WHEN excluded.status != 'settled' OR payments.txid IS NOT excluded.txid THEN NULL ELSE payments.block_time END
       WHERE payments.received_raw != excluded.received_raw OR payments.status != excluded.status
         OR payments.txid IS NOT excluded.txid OR payments.invoice_id IS NOT excluded.invoice_id
         OR payments.direction != excluded.direction OR payments.recipient_id != excluded.recipient_id
         OR payments.requested_raw IS NOT excluded.requested_raw OR payments.receive_utxo IS NOT excluded.receive_utxo`
      )
      .run({ ...p, sourceJson: p.source ? JSON.stringify(p.source) : null }).changes > 0
  )
}

export function setBlockTime(nodeIdx: number, blockTime: number): boolean {
  return (
    getDb()
      .prepare('UPDATE payments SET block_time = ? WHERE node_idx = ? AND block_time IS NOT ?')
      .run(blockTime, nodeIdx, blockTime).changes > 0
  )
}

export function listPayments(): PaymentRow[] {
  return getDb()
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments ORDER BY node_idx DESC`)
    .all()
    .map((row) => sourceRow<PaymentRow>(row))
}

export function paymentsForInvoice(invoiceId: string): PaymentRow[] {
  return getDb()
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE invoice_id = ? AND direction = 'in'`)
    .all(invoiceId)
    .map((row) => sourceRow<PaymentRow>(row))
}

export function paymentsMissingBlockTime(): PaymentRow[] {
  return getDb()
    .prepare(
      `SELECT ${PAYMENT_COLS} FROM payments WHERE status = 'settled' AND txid IS NOT NULL AND block_time IS NULL`
    )
    .all()
    .map((row) => sourceRow<PaymentRow>(row))
}

// ---- proposals ----

export interface ProposalRow {
  id: string
  invoiceId: string
  kind: string
  amountRaw: number
  reason: string
  status: string
  refundInvoice: string | null
  txid: string | null
  error: string | null
  createdAt: number
}

const PROPOSAL_COLS = `id, invoice_id AS invoiceId, kind, amount_raw AS amountRaw, reason, status,
  refund_invoice AS refundInvoice, txid, error, created_at AS createdAt`

// OR IGNORE: a second refund for the same invoice is silently skipped
export function insertProposal(p: Omit<ProposalRow, 'refundInvoice' | 'txid' | 'error'>): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO proposals (id, invoice_id, kind, amount_raw, reason, status, created_at)
       VALUES (@id, @invoiceId, @kind, @amountRaw, @reason, @status, @createdAt)`
    )
    .run(p)
}

export function getProposal(id: string): ProposalRow | undefined {
  return getDb().prepare(`SELECT ${PROPOSAL_COLS} FROM proposals WHERE id = ?`).get(id) as
    ProposalRow | undefined
}

export function listProposals(): ProposalRow[] {
  return getDb()
    .prepare(`SELECT ${PROPOSAL_COLS} FROM proposals ORDER BY created_at DESC`)
    .all() as ProposalRow[]
}

export function updateProposal(
  id: string,
  f: { status: string; refundInvoice?: string; txid?: string; error?: string }
): void {
  getDb()
    .prepare(
      `UPDATE proposals SET status = @status,
         refund_invoice = COALESCE(@refundInvoice, refund_invoice),
         txid = COALESCE(@txid, txid),
         error = COALESCE(@error, error)
       WHERE id = @id`
    )
    .run({ id, refundInvoice: null, txid: null, error: null, ...f })
}

export function getInvoice(id: string): InvoiceRow | undefined {
  const row = getDb().prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`).get(id)
  return row ? sourceRow<InvoiceRow>(row) : undefined
}
export function reconciliationCandidates(changed: string[]): InvoiceRow[] {
  const placeholders = changed.map(() => '?').join(',')
  return getDb()
    .prepare(
      `SELECT ${INVOICE_COLS} FROM invoices WHERE state IN ('Issued', 'Pending') ${changed.length ? `OR id IN (${placeholders})` : ''}`
    )
    .all(...changed)
    .map((row) => sourceRow<InvoiceRow>(row))
}
export function refreshOpenProposal(invoiceId: string, amountRaw: number, reason: string): void {
  getDb()
    .prepare(
      "UPDATE proposals SET amount_raw = ?, reason = ? WHERE invoice_id = ? AND status = 'open'"
    )
    .run(amountRaw, reason, invoiceId)
}

export function getPayment(nodeIdx: number): PaymentRow | undefined {
  const row = getDb()
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE node_idx = ?`)
    .get(nodeIdx)
  return row ? sourceRow<PaymentRow>(row) : undefined
}
