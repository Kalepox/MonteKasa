import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { rgbConfig, type RgbBackend } from '../rgb'
import * as db from '../db'
import { reconcile } from './reconcile'
import { toRaw, toUsdt } from './units'
import { SecurityCoordinator } from '../security/coordinator'
import { SqliteSecurityStore } from '../security/store'
import { requireCheck } from '../security/rules'
import type { PaymentIntent, SecurityReview, SecurityOperation } from '../../shared/security'

const now = (): number => Math.floor(Date.now() / 1000)

async function fetchBlockTime(txid: string): Promise<number | null> {
  try {
    const res = await fetch(`${rgbConfig.explorerApi}/tx/${txid}`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const tx = (await res.json()) as { status?: { block_time?: number } }
    return tx.status?.block_time ?? null
  } catch {
    return null
  }
}

export class Kasa extends EventEmitter {
  private busy = false
  private refreshing?: Promise<void>
  private chainCache = new Map<
    string,
    { checkedAt: number; valid: boolean; confirmations?: number }
  >()
  readonly security: SecurityCoordinator

  constructor(private rgb: RgbBackend) {
    super()
    this.security = new SecurityCoordinator(
      rgb,
      new SqliteSecurityStore(db.getDb()),
      {
        assetId: rgbConfig.assetId,
        network: rgbConfig.network,
        feeRate: rgbConfig.feeRate,
        maxFeeRate: rgbConfig.maxFeeRate,
        minBtcSats: rgbConfig.minBtcSats,
        confirmations: rgbConfig.confirmations,
        maxHeightLag: 2,
        evidenceMaxAge: 30,
        approvalSeconds: 120,
        allowedTransportHosts: [new URL(rgbConfig.proxy).host]
      },
      (id, raw) => this.verifyRefund(id, raw),
      () => this.emit('changed'),
      undefined,
      (o) => {
        if (o.proposalId)
          db.updateProposal(o.proposalId, { status: o.state, txid: o.txid, error: o.error })
      }
    )
  }

  // a tick can take longer than the interval (refresh is slow), so never run two at once
  start(intervalMs = 5000): void {
    const loop = async (): Promise<void> => {
      if (this.busy) return
      this.busy = true
      try {
        try {
          await this.refresh()
          this.security.resolve('incoming-refresh', 'node')
        } catch (error) {
          this.security.finding(
            'incoming-refresh',
            'node',
            `Incoming payment refresh unavailable: ${String((error as Error).message ?? error)}`,
            'unavailable'
          )
        }
        await this.security.monitor()
      } catch (e) {
        console.error('[kasa] tick failed', e)
      } finally {
        this.busy = false
      }
    }
    void loop()
    setInterval(loop, intervalMs).unref()
  }

  async createInvoice(client: string, amountUsdt: number | string): Promise<db.InvoiceRow> {
    requireCheck(
      typeof client === 'string' && client.trim().length > 0 && client.length <= 200,
      'client',
      'Client name must be between 1 and 200 characters.'
    )
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

  async refresh(): Promise<void> {
    if (!this.refreshing)
      this.refreshing = this.tick().finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }

  private async tick(): Promise<void> {
    const changedIds = new Set<string>()
    const newlySettled: { amount: number; client?: string; invoiceId?: string }[] = []
    let chainRequests = 0
    // 1. copy the node's view (received and sent) into our own DB
    for (const t of await this.rgb.listTransfers()) {
      // only incoming transfers pay our invoices
      const invoice = t.direction === 'in' ? db.getInvoiceByRecipient(t.recipientId) : undefined
      const previous = db.getPayment(t.idx)
      if (t.direction === 'in' && t.status === 'settled') {
        // Recent settlements get checked again; old settlements still follow node status changes.
        const oldStable =
          previous?.status === 'settled' &&
          previous.txid === (t.txid ?? null) &&
          previous.receivedRaw === t.receivedRaw &&
          now() - t.updatedAt > 86400
        if (!oldStable) {
          const key = t.txid ?? `missing-${t.idx}`
          let observation = this.chainCache.get(key)
          if (!observation || now() - observation.checkedAt >= 30) {
            if (chainRequests >= 5) {
              t.status = 'confirming'
              observation = { checkedAt: now(), valid: false }
            } else {
              chainRequests++
              try {
                requireCheck(
                  Boolean(t.txid),
                  'incoming-txid',
                  'Settled payment has no transaction ID.',
                  'unavailable'
                )
                const evidence = await this.rgb.chainEvidence(t.txid!)
                observation = {
                  checkedAt: now(),
                  confirmations: evidence.confirmations,
                  valid:
                    evidence.confirmed &&
                    evidence.inBestChain &&
                    Number.isSafeInteger(evidence.confirmations) &&
                    evidence.confirmations >= rgbConfig.confirmations &&
                    now() - evidence.checkedAt <= 30 &&
                    evidence.checkedAt <= now() + 5
                }
              } catch {
                observation = { checkedAt: now(), valid: false }
              }
              if (this.chainCache.size >= 500)
                this.chainCache.delete(this.chainCache.keys().next().value!)
              this.chainCache.set(key, observation)
            }
          }
          if (!observation.valid) {
            t.status = 'confirming'
            this.security.finding(
              'incoming-confirmations',
              invoice?.id ?? String(t.idx),
              'Incoming payment is not yet verified against the Bitcoin confirmation policy. No refund is available.',
              'unavailable',
              {
                requiredConfirmations: rgbConfig.confirmations,
                ...(Number.isSafeInteger(observation.confirmations) &&
                observation.confirmations! >= 0
                  ? { confirmations: observation.confirmations! }
                  : {})
              }
            )
          } else this.security.resolve('incoming-confirmations', invoice?.id ?? String(t.idx))
        }
      }
      requireCheck(
        Number.isSafeInteger(t.receivedRaw) && t.receivedRaw >= 0,
        'payment-amount',
        'Node reported an invalid payment amount.'
      )
      const changed = db.upsertPayment({
        nodeIdx: t.idx,
        direction: t.direction,
        invoiceId: invoice?.id ?? null,

        recipientId: t.recipientId,
        requestedRaw: t.requestedRaw,
        receivedRaw: t.receivedRaw,
        status: t.status,
        txid: t.txid ?? null,
        receiveUtxo: t.receiveUtxo ?? null,
        updatedAt: t.updatedAt
      })
      if (changed && invoice) changedIds.add(invoice.id)
      // notify once, exactly when a payment first settles (not on every re-poll of an old one)
      if (changed && t.direction === 'in' && t.status === 'settled' && previous?.status !== 'settled')
        newlySettled.push({ amount: toUsdt(t.receivedRaw), client: invoice?.client, invoiceId: invoice?.id })
    }

    // 2. legal receipt date = block time of the Bitcoin transaction
    for (const p of db.paymentsMissingBlockTime().slice(0, 5)) {
      const bt = rgbConfig.mock ? p.updatedAt : await fetchBlockTime(p.txid!)
      if (bt) db.setBlockTime(p.nodeIdx, bt)
    }

    // 3. reconcile every open invoice
    let changed = false
    for (const inv of db.reconciliationCandidates([...changedIds])) {
      const r = reconcile(inv, db.paymentsForInvoice(inv.id), now())
      if (r.state === inv.state && r.receivedRaw === inv.receivedRaw) continue
      if (!['Issued', 'Pending'].includes(inv.state))
        this.security.finding(
          'late-payment-change',
          inv.id,
          'Payment evidence changed after this invoice reached a final state. Its totals have been recalculated.',
          'review',
          { previousState: inv.state, state: r.state, receivedRaw: r.receivedRaw }
        )
      db.updateInvoiceState(inv.id, r.state, r.receivedRaw)
      if (['Underpaid', 'Overpaid', 'Flagged'].includes(r.state))
        this.security.finding(
          'invoice-discrepancy',
          inv.id,
          `Invoice requires review: ${r.state}.`,
          'review',
          { expectedRaw: inv.amountRaw, receivedRaw: r.receivedRaw }
        )
      else this.security.resolve('invoice-discrepancy', inv.id)
      changed = true
      if (r.state === 'Overpaid') this.proposeRefund(inv, r.receivedRaw)
    }
    for (const p of newlySettled) this.emit('payment', p)
    if (changed) this.emit('changed')
  }

  // numbers come from code; Fraud Controller's agent will only rewrite the reason text later
  private proposeRefund(inv: db.InvoiceRow, receivedRaw: number): void {
    const extra = receivedRaw - inv.amountRaw
    const reason = `${inv.client} paid ${toUsdt(receivedRaw)} USDT on a ${toUsdt(inv.amountRaw)} USDT invoice: refund ${toUsdt(extra)} USDT`
    db.refreshOpenProposal(inv.id, extra, reason)
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

  private async verifyRefund(id: string, raw: number): Promise<void> {
    await this.refresh()
    const p = db.getProposal(id)
    requireCheck(p && p.status === 'open', 'refund-state', 'Refund proposal is not open.')
    const inv = db.getInvoice(p.invoiceId)
    requireCheck(
      inv && inv.state === 'Overpaid',
      'refund-evidence',
      'Invoice is no longer a verified overpayment.'
    )
    const payments = db.paymentsForInvoice(inv.id).filter((p) => p.status === 'settled')
    requireCheck(
      payments.length === 1 && Boolean(payments[0].txid),
      'refund-evidence',
      'Refund requires one unambiguous settled payment.'
    )
    const chain = await this.rgb.chainEvidence(payments[0].txid!)
    requireCheck(
      chain.confirmed &&
        chain.inBestChain &&
        chain.confirmations >= rgbConfig.confirmations &&
        now() - chain.checkedAt <= 30 &&
        chain.checkedAt <= now() + 5,
      'refund-confirmations',
      'Original payment does not meet fresh confirmation policy.',
      'unavailable'
    )
    const excess = payments[0].receivedRaw - inv.amountRaw
    requireCheck(
      Number.isSafeInteger(excess) && raw > 0 && raw === excess && raw === p.amountRaw,
      'refund-amount',
      'Refund amount changed or exceeds current settled excess. Review again.'
    )
  }

  reviewPayment(intent: PaymentIntent): Promise<SecurityReview> {
    return this.security.review(intent)
  }
  async executePayment(id: unknown, token: unknown, verified: unknown): Promise<SecurityOperation> {
    const result = await this.security.execute(id, token, verified)
    this.emit('changed')
    return result
  }
  async approve(): Promise<never> {
    throw new Error('Review the refund through the security payment gate before approval.')
  }

  dismiss(id: string): void {
    const p = db.getProposal(id)
    if (!p || p.status !== 'open') return
    db.updateProposal(id, { status: 'dismissed' })
    this.emit('changed')
  }

  // wallet "Request": a plain USDT invoice, not tied to a client invoice, optionally for
  // a specific amount. Reused for a few minutes, because every invoice reserves a UTXO —
  // but only when no specific amount is requested, since a cached invoice may ask for a
  // different (or no) amount than the one the merchant just typed.
  private receiveCache?: { invoice: string; expiresAt: number }
  async receiveInvoice(
    fresh = false,
    amount?: string | number
  ): Promise<{ invoice: string; expiresAt: number }> {
    const amountRaw = amount !== undefined && amount !== null && amount !== '' ? toRaw(amount) : null
    if (amountRaw === null && !fresh && this.receiveCache && this.receiveCache.expiresAt - now() > 300)
      return this.receiveCache
    const r = await this.rgb.createInvoice(amountRaw, now() + rgbConfig.invoiceTtlSec)
    const result = { invoice: r.invoice, expiresAt: r.expiresAt }
    if (amountRaw === null) this.receiveCache = result
    return result
  }

  // wallet "Send": the merchant's own action; same asset/network/proxy checks as refunds
  async send(): Promise<never> {
    throw new Error('Review the payment through the security payment gate before sending.')
  }

  // what the UI gets: amounts already converted to USDT
  snapshot(): {
    invoices: (db.InvoiceRow & { amount: number; received: number })[]
    proposals: (db.ProposalRow & { amount: number })[]
    payments: (db.PaymentRow & { received: number })[]
  } {
    return {
      invoices: db
        .listInvoices()
        .map((i) => ({ ...i, amount: toUsdt(i.amountRaw), received: toUsdt(i.receivedRaw) })),
      proposals: db.listProposals().map((p) => ({ ...p, amount: toUsdt(p.amountRaw) })),
      payments: db.listPayments().map((p) => ({ ...p, received: toUsdt(p.receivedRaw) }))
    }
  }
}
