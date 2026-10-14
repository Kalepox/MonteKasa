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

const PAYMENT_COLS = `node_idx AS nodeIdx, invoice_id AS invoiceId, recipient_id AS recipientId,
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
  getDb().prepare('UPDATE invoices SET state = ?, received_raw = ? WHERE id = ?').run(state, receivedRaw, id)
}

export function listInvoices(): InvoiceRow[] {
  return getDb().prepare(`SELECT ${INVOICE_COLS} FROM invoices ORDER BY created_at DESC`).all() as InvoiceRow[]
}

export function getInvoiceByRecipient(recipientId: string): InvoiceRow | undefined {
  return getDb().prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE recipient_id = ?`).get(recipientId) as
    | InvoiceRow
    | undefined
}

// ---- payments ----

// insert the first time we see a transfer, update its status/amount afterwards
export function upsertPayment(p: Omit<PaymentRow, 'blockTime'>): void {
  getDb()
    .prepare(
      `INSERT INTO payments (node_idx, invoice_id, recipient_id, requested_raw, received_raw, status, txid, receive_utxo, updated_at)
       VALUES (@nodeIdx, @invoiceId, @recipientId, @requestedRaw, @receivedRaw, @status, @txid, @receiveUtxo, @updatedAt)
       ON CONFLICT(node_idx) DO UPDATE SET
         received_raw = excluded.received_raw,
         status       = excluded.status,
         txid         = excluded.txid,
         updated_at   = excluded.updated_at`
    )
    .run(p)
}

export function setBlockTime(nodeIdx: number, blockTime: number): void {
  getDb().prepare('UPDATE payments SET block_time = ? WHERE node_idx = ?').run(blockTime, nodeIdx)
}

export function listPayments(): PaymentRow[] {
  return getDb().prepare(`SELECT ${PAYMENT_COLS} FROM payments ORDER BY node_idx DESC`).all() as PaymentRow[]
}

export function paymentsForInvoice(invoiceId: string): PaymentRow[] {
  return getDb().prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE invoice_id = ?`).all(invoiceId) as PaymentRow[]
}
