import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { rgbConfig, type RgbBackend } from '../rgb'
import * as db from '../db'
import { reconcile } from './reconcile'
import { toRaw, toUsdt } from './units'
import { FINAL_STATES, type InvoiceState } from './types'

const now = (): number => Math.floor(Date.now() / 1000)

async function fetchBlockTime(txid: string): Promise<number | null> {
  try {
    const res = await fetch(`${rgbConfig.explorerApi}/tx/${txid}`)
    if (!res.ok) return null
    const tx = (await res.json()) as { status?: { block_time?: number } }
    return tx.status?.block_time ?? null
  } catch {
    return null
  }
}

export class Kasa extends EventEmitter {
  private busy = false

  constructor(private rgb: RgbBackend) {
    super()
  }

  // a tick can take longer than the interval (refresh is slow), so never run two at once
  start(intervalMs = 5000): void {
    const loop = async (): Promise<void> => {
      if (this.busy) return
      this.busy = true
      try {
        await this.tick()
      } catch (e) {
        console.error('[kasa] tick failed', e)
      } finally {
        this.busy = false
      }
    }
    void loop()
    setInterval(loop, intervalMs)
  }

  async createInvoice(client: string, amountUsdt: number): Promise<db.InvoiceRow> {
    const amountRaw = toRaw(amountUsdt)
    const rgb = await this.rgb.createInvoice(amountRaw, now() + rgbConfig.invoiceTtlSec)
    const inv: db.InvoiceRow = {
      id: randomUUID(),
      client,
      amountRaw,
      receivedRaw: 0,
      rgbInvoice: rgb.invoice,
      recipientId: rgb.recipientId,
      expiresAt: rgb.expiresAt,
      state: 'Issued',
      createdAt: now()
    }
    db.insertInvoice(inv)
    this.emit('changed')
    return inv
  }

  private async tick(): Promise<void> {
    // 1. copy the node's view (received and sent) into our own DB
    for (const t of await this.rgb.listTransfers()) {
      db.upsertPayment({
        nodeIdx: t.idx,
        direction: t.direction,
        // only incoming transfers pay our invoices
        invoiceId: t.direction === 'in' ? (db.getInvoiceByRecipient(t.recipientId)?.id ?? null) : null,
        recipientId: t.recipientId,
        requestedRaw: t.requestedRaw,
        receivedRaw: t.receivedRaw,
        status: t.status,
        txid: t.txid ?? null,
        receiveUtxo: t.receiveUtxo ?? null,
        updatedAt: t.updatedAt
      })
    }

    // 2. legal receipt date = block time of the Bitcoin transaction
    for (const p of db.paymentsMissingBlockTime()) {
      const bt = rgbConfig.mock ? p.updatedAt : await fetchBlockTime(p.txid!)
      if (bt) db.setBlockTime(p.nodeIdx, bt)
    }

    // 3. reconcile every open invoice
    let changed = false
    for (const inv of db.listInvoices()) {
      if (FINAL_STATES.includes(inv.state as InvoiceState)) continue
      const r = reconcile(inv, db.paymentsForInvoice(inv.id), now())
      if (r.state === inv.state && r.receivedRaw === inv.receivedRaw) continue
      db.updateInvoiceState(inv.id, r.state, r.receivedRaw)
      changed = true
      if (r.state === 'Overpaid') this.proposeRefund(inv, r.receivedRaw)
    }
    if (changed) this.emit('changed')
  }

  // numbers come from code; Fraud Controller's agent will only rewrite the reason text later
  private proposeRefund(inv: db.InvoiceRow, receivedRaw: number): void {
    const extra = receivedRaw - inv.amountRaw
    db.insertProposal({
      id: randomUUID(),
      invoiceId: inv.id,
      kind: 'refund',
      amountRaw: extra,
      reason: `${inv.client} paid ${toUsdt(receivedRaw)} USDT on a ${toUsdt(inv.amountRaw)} USDT invoice: refund ${toUsdt(extra)} USDT`,
      status: 'open',
      createdAt: now()
    })
  }

  // the only path that moves funds: an open proposal + the merchant's approval
  async approve(id: string, refundInvoice: string): Promise<void> {
    const p = db.getProposal(id)
    if (!p || p.status !== 'open') return
    db.updateProposal(id, { status: 'executing', refundInvoice })
    this.emit('changed')
    try {
      const { txid } = await this.rgb.send(refundInvoice, p.amountRaw)
      db.updateProposal(id, { status: 'executed', txid })
    } catch (e) {
      db.updateProposal(id, { status: 'failed', error: String(e) })
    }
    this.emit('changed')
  }

  dismiss(id: string): void {
    const p = db.getProposal(id)
    if (!p || p.status !== 'open') return
    db.updateProposal(id, { status: 'dismissed' })
    this.emit('changed')
  }


  // wallet "Receive": a plain USDT invoice, not tied to a client invoice.
  // Reused for a few minutes, because every invoice reserves a UTXO.
  private receiveCache?: { invoice: string; expiresAt: number }
  async receiveInvoice(): Promise<{ invoice: string; expiresAt: number }> {
    if (this.receiveCache && this.receiveCache.expiresAt - now() > 300) return this.receiveCache
    const r = await this.rgb.createInvoice(null, now() + rgbConfig.invoiceTtlSec)
    this.receiveCache = { invoice: r.invoice, expiresAt: r.expiresAt }
    return this.receiveCache
  }

  // wallet "Send": the merchant's own action; same asset/network/proxy checks as refunds
  async send(invoice: string, amountUsdt: number): Promise<{ txid: string }> {
    const r = await this.rgb.send(invoice, toRaw(amountUsdt))
    this.emit('changed')
    return r
  }


  // what the UI gets: amounts already converted to USDT
  snapshot() {
    return {
      invoices: db.listInvoices().map((i) => ({ ...i, amount: toUsdt(i.amountRaw), received: toUsdt(i.receivedRaw) })),
      proposals: db.listProposals().map((p) => ({ ...p, amount: toUsdt(p.amountRaw) })),
      payments: db.listPayments().map((p) => ({ ...p, received: toUsdt(p.receivedRaw) }))
    }
  }
}
