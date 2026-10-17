import { getDb } from './index'

export interface InvoiceRow {
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
  state, created_at AS createdAt`

const PAYMENT_COLS = `node_idx AS nodeIdx, direction, invoice_id AS invoiceId, recipient_id AS recipientId,
  requested_raw AS requestedRaw, received_raw AS receivedRaw, status, txid,
  block_time AS blockTime, receive_utxo AS receiveUtxo, updated_at AS updatedAt`

// ---- invoices ----

export function insertInvoice(inv: InvoiceRow): void {
  getDb()
    .prepare(
      `INSERT INTO invoices (id, client, amount_raw, received_raw, rgb_invoice, recipient_id, expires_at, state, created_at)
       VALUES (@id, @client, @amountRaw, @receivedRaw, @rgbInvoice, @recipientId, @expiresAt, @state, @createdAt)`
    )
    .run(inv)
}

export function updateInvoiceState(id: string, state: string, receivedRaw: number): void {
  getDb()
    .prepare('UPDATE invoices SET state = ?, received_raw = ? WHERE id = ?')
    .run(state, receivedRaw, id)
}

export function listInvoices(): InvoiceRow[] {
  return getDb()
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices ORDER BY created_at DESC`)
    .all() as InvoiceRow[]
}

export function getInvoiceByRecipient(recipientId: string): InvoiceRow | undefined {
  return getDb()
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE recipient_id = ?`)
    .get(recipientId) as InvoiceRow | undefined
}

// ---- payments ----

// insert the first time we see a transfer, update its status/amount afterwards
export function upsertPayment(p: Omit<PaymentRow, 'blockTime'>): boolean {
  return (
    getDb()
      .prepare(
        `INSERT INTO payments (node_idx, direction, invoice_id, recipient_id, requested_raw, received_raw, status, txid, receive_utxo, updated_at)
       VALUES (@nodeIdx, @direction, @invoiceId, @recipientId, @requestedRaw, @receivedRaw, @status, @txid, @receiveUtxo, @updatedAt)

       ON CONFLICT(node_idx) DO UPDATE SET
         received_raw = excluded.received_raw,
         status       = excluded.status,
         txid         = excluded.txid,
         updated_at   = excluded.updated_at,
         invoice_id = excluded.invoice_id,
         block_time = CASE WHEN excluded.status != 'settled' OR payments.txid IS NOT excluded.txid THEN NULL ELSE payments.block_time END
       WHERE payments.received_raw != excluded.received_raw OR payments.status != excluded.status
         OR payments.txid IS NOT excluded.txid OR payments.invoice_id IS NOT excluded.invoice_id`
      )
      .run(p).changes > 0
  )
}

export function setBlockTime(nodeIdx: number, blockTime: number): void {
  getDb().prepare('UPDATE payments SET block_time = ? WHERE node_idx = ?').run(blockTime, nodeIdx)
}

export function listPayments(): PaymentRow[] {
  return getDb()
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments ORDER BY node_idx DESC`)
    .all() as PaymentRow[]
}

export function paymentsForInvoice(invoiceId: string): PaymentRow[] {
  return getDb()
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE invoice_id = ? AND direction = 'in'`)
    .all(invoiceId) as PaymentRow[]
}

export function paymentsMissingBlockTime(): PaymentRow[] {
  return getDb()
    .prepare(
      `SELECT ${PAYMENT_COLS} FROM payments WHERE status = 'settled' AND txid IS NOT NULL AND block_time IS NULL`
    )
    .all() as PaymentRow[]
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
  return getDb().prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`).get(id) as
    InvoiceRow | undefined
}
export function reconciliationCandidates(changed: string[]): InvoiceRow[] {
  const placeholders = changed.map(() => '?').join(',')
  return getDb()
    .prepare(
      `SELECT ${INVOICE_COLS} FROM invoices WHERE state IN ('Issued', 'Pending') ${changed.length ? `OR id IN (${placeholders})` : ''}`
    )
    .all(...changed) as InvoiceRow[]
}
export function refreshOpenProposal(invoiceId: string, amountRaw: number, reason: string): void {
  getDb()
    .prepare(
      "UPDATE proposals SET amount_raw = ?, reason = ? WHERE invoice_id = ? AND status = 'open'"
    )
    .run(amountRaw, reason, invoiceId)
}

export function getPayment(nodeIdx: number): PaymentRow | undefined {
  return getDb().prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE node_idx = ?`).get(nodeIdx) as
    PaymentRow | undefined
}
