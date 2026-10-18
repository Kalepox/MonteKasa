import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RgbTransfer, RgbBackend } from '../rgb/types'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
// these tests exercise the confirmation logic against a 3-block policy (the app default is 1 on Mutinynet)
process.env.RGB_CONFIRMATIONS = '3'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
  vi.unstubAllEnvs()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture() {
  vi.resetModules()
  const dir = mkdtempSync(join(tmpdir(), 'kasa-reconcile-'))
  vi.stubEnv('KASA_DB', join(dir, 'test.db'))
  vi.stubEnv('RGB_MOCK', '1')
  const { Kasa } = await import('../core/kasa')
  const db = await import('../db')
  const { rgbConfig } = await import('../rgb/config')
  let transfers: RgbTransfer[] = []
  let confirmations = 3
  const backend: RgbBackend = {
    status: async () => ({ state: 'online', mock: true, balanceRaw: 100000000, btcSats: 10000 }),
    createInvoice: async (raw, expiresAt) => ({
      recipientId: 'incoming',
      invoice: `rgb:${raw}`,
      expiresAt
    }),
    listTransfers: async () => structuredClone(transfers),
    decodeInvoice: async () => ({
      recipientId: 'refund-recipient',
      assetId: rgbConfig.assetId,
      network: rgbConfig.network,
      amountRaw: null,
      expiresAt: null,
      endpoints: [rgbConfig.proxy]
    }),
    networkEvidence: async () => ({
      network: rgbConfig.network,
      height: 100,
      referenceHeight: 100,
      identityVerified: true,
      online: true,
      balanceRaw: 100000000,
      btcSats: 10000,
      checkedAt: Math.floor(Date.now() / 1000),
      source: 'test'
    }),
    outgoingTransfers: async () => [],
    chainEvidence: async () => ({
      confirmed: true,
      inBestChain: true,
      confirmations,
      checkedAt: Math.floor(Date.now() / 1000)
    }),
    send: vi.fn(async () => ({ txid: 'tx' }))
  }
  const kasa = new Kasa(backend)
  cleanups.push(() => {
    db.getDb().close()
    rmSync(dir, { recursive: true, force: true })
  })
  const invoice = await kasa.createInvoice('Client', '10')
  const payment = (
    idx: number,
    raw: number,
    status: RgbTransfer['status'] = 'settled'
  ): RgbTransfer => ({
    idx,
    direction: 'in',
    recipientId: 'incoming',
    requestedRaw: 10000000,
    receivedRaw: raw,
    status,
    txid: `tx${idx}`,
    updatedAt: Math.floor(Date.now() / 1000)
  })
  return {
    kasa,
    db,
    invoice,
    backend,
    payment,
    setTransfers: (t: RgbTransfer[]): void => {
      transfers = t
    },
    setConfirmations: (n: number): void => {
      confirmations = n
    }
  }
}
describe('Kasa security integration', () => {
  it('reconciles late payments even after Paid and deduplicates evidence', async () => {
    const f = await fixture()
    f.setTransfers([f.payment(1, 10000000)])
    await f.kasa.refresh()
    expect(f.db.getInvoice(f.invoice.id)?.state).toBe('Paid')
    f.setTransfers([f.payment(1, 10000000), f.payment(2, 2000000)])
    await f.kasa.refresh()
    await f.kasa.refresh()
    expect(f.db.getInvoice(f.invoice.id)?.state).toBe('Flagged')
    expect(f.db.getInvoice(f.invoice.id)?.receivedRaw).toBe(12000000)
    expect(
      f.kasa.security.snapshot().findings.filter((x) => x.rule === 'late-payment-change')
    ).toHaveLength(1)
  })
  it('does not mark an incoming payment paid below confirmation policy', async () => {
    const f = await fixture()
    f.setConfirmations(1)
    f.setTransfers([f.payment(1, 10000000)])
    await f.kasa.refresh()
    expect(f.db.getInvoice(f.invoice.id)?.state).toBe('Pending')
  })
  it('reopens a paid invoice when node settlement regresses', async () => {
    const f = await fixture()
    f.setTransfers([f.payment(1, 10000000)])
    await f.kasa.refresh()
    f.setTransfers([f.payment(1, 10000000, 'confirming')])
    await f.kasa.refresh()
    expect(f.db.getInvoice(f.invoice.id)?.state).toBe('Pending')
    expect(f.db.paymentsForInvoice(f.invoice.id)[0].blockTime).toBeNull()
  })
  it('rejects a stale refund after payment amount changes before execution', async () => {
    const f = await fixture()
    f.setTransfers([f.payment(1, 12000000)])
    await f.kasa.refresh()
    const proposal = f.db.listProposals()[0]
    const review = await f.kasa.reviewPayment({
      invoice: 'rgb:refund',
      amount: '2',
      proposalId: proposal.id
    })
    f.setTransfers([f.payment(1, 11000000)])
    await expect(
      f.kasa.executePayment(review.operation.id, review.approvalToken, true)
    ).rejects.toThrow('amount')
    expect(f.backend.send).not.toHaveBeenCalled()
    expect(f.db.getProposal(proposal.id)?.amountRaw).toBe(1000000)
  })
  it('does not execute a refund after confirmation regression', async () => {
    const f = await fixture()
    f.setTransfers([f.payment(1, 12000000)])
    await f.kasa.refresh()
    const proposal = f.db.listProposals()[0]
    const review = await f.kasa.reviewPayment({
      invoice: 'rgb:refund',
      amount: '2',
      proposalId: proposal.id
    })
    f.setConfirmations(1)
    await expect(
      f.kasa.executePayment(review.operation.id, review.approvalToken, true)
    ).rejects.toThrow('confirmation')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('disables both legacy money-moving entry points', async () => {
    const f = await fixture()
    await expect(f.kasa.send()).rejects.toThrow('gate')
    await expect(f.kasa.approve()).rejects.toThrow('gate')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
})

describe('successful refund flow', () => {
  it('moves a verified refund through submitted to completed and refuses repeat approval', async () => {
    const f = await fixture()
    f.setTransfers([f.payment(1, 12000000)])
    await f.kasa.refresh()
    const proposal = f.db.listProposals()[0]
    const review = await f.kasa.reviewPayment({
      invoice: 'rgb:refund',
      amount: '2',
      proposalId: proposal.id
    })
    const result = await f.kasa.executePayment(review.operation.id, review.approvalToken, true)
    expect(result.state).toBe('submitted')
    expect(f.db.getProposal(proposal.id)?.status).toBe('submitted')
    f.backend.outgoingTransfers = async () => [
      { recipientId: 'refund-recipient', amountRaw: 2000000, txid: 'tx', status: 'Settled' }
    ]
    await f.kasa.security.monitor()
    expect(f.db.getProposal(proposal.id)?.status).toBe('completed')
    await expect(
      f.kasa.executePayment(review.operation.id, review.approvalToken, true)
    ).rejects.toThrow()
    expect(f.backend.send).toHaveBeenCalledTimes(1)
  })
})

describe('saved ledger change notifications', () => {
  it.each(['in', 'out'] as const)(
    'refreshes unlinked %s payments once for real changes',
    async (direction) => {
      const f = await fixture()
      const changed = vi.fn()
      f.kasa.on('changed', changed)
      const transfer = { ...f.payment(9, 1000000, 'waiting'), direction, recipientId: 'unlinked' }
      f.setTransfers([transfer])
      await f.kasa.refresh()
      expect(changed).toHaveBeenCalledTimes(1)
      const saved = f.kasa.snapshot().payments[0]
      expect(saved).toMatchObject({
        receivedRaw: 1000000,
        invoiceId: null,
        source: { backend: 'mock', asset: { environment: 'test' } }
      })
      await f.kasa.refresh()
      expect(changed).toHaveBeenCalledTimes(1)
      f.setTransfers([{ ...transfer, status: 'confirming' }])
      await f.kasa.refresh()
      expect(changed).toHaveBeenCalledTimes(2)
      f.setTransfers([{ ...transfer, status: 'failed' }])
      await f.kasa.refresh()
      expect(changed).toHaveBeenCalledTimes(3)
      expect(f.kasa.snapshot().payments).toHaveLength(1)
    }
  )

  it('refreshes a saved block time even when transfers and invoices have not changed', async () => {
    const f = await fixture()
    const transfer = {
      ...f.payment(9, 1000000),
      direction: 'out' as const,
      recipientId: 'unlinked'
    }
    f.setTransfers([transfer])
    await f.kasa.refresh()
    f.db.getDb().prepare('UPDATE payments SET block_time = NULL').run()
    const changed = vi.fn()
    f.kasa.on('changed', changed)
    await f.kasa.refresh()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(f.db.getPayment(9)?.blockTime).toBe(transfer.updatedAt)
    await f.kasa.refresh()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('notifies after a persisted row even if a later row in the refresh fails', async () => {
    const f = await fixture()
    const changed = vi.fn()
    f.kasa.on('changed', changed)
    f.setTransfers([
      { ...f.payment(9, 1000000, 'waiting'), direction: 'out', recipientId: 'unlinked' },
      { ...f.payment(10, -1, 'waiting'), direction: 'out', recipientId: 'invalid' }
    ])
    await expect(f.kasa.refresh()).rejects.toThrow('invalid payment amount')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(f.db.listPayments()).toHaveLength(1)
  })
})
