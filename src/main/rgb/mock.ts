import { randomUUID } from 'node:crypto'
import { rgbConfig } from './config'
import type { OutgoingEvidence } from '../security/types'
import type { IncomingTransfer, RgbBackend } from './types'

export function createMockBackend(): {
  backend: RgbBackend
  pay: (recipientId: string, amountRaw: number) => void
} {
  const transfers: IncomingTransfer[] = []
  const requestedBy = new Map<string, number | null>()
  let n = 0
  const outgoing: OutgoingEvidence[] = []

  const backend: RgbBackend = {
    async decodeInvoice(invoice) {
      const match = /^rgb:mock\/(~|\d+)\/(mock:utxob:[^?]+)\?expiry=(\d+)$/.exec(invoice)
      if (!match) throw new Error('Mock mode requires an rgb:mock invoice.')
      return {
        recipientId: match[2],
        assetId: rgbConfig.assetId,
        network: rgbConfig.network,
        amountRaw: match[1] === '~' ? null : Number(match[1]),
        expiresAt: Number(match[3]),
        endpoints: [rgbConfig.proxy]
      }
    },
    async networkEvidence() {
      const state = await backend.status()
      return {
        network: rgbConfig.network,
        height: 100,
        referenceHeight: 100,
        identityVerified: true,
        online: true,
        balanceRaw: state.balanceRaw ?? 0,
        btcSats: state.btcSats ?? 0,
        checkedAt: Math.floor(Date.now() / 1000),
        source: 'MOCK — not a real network'
      }
    },
    async outgoingTransfers() {
      return outgoing.map((t) => ({ ...t }))
    },
    async chainEvidence() {
      return {
        confirmed: true,
        confirmations: 3,
        inBestChain: true,
        checkedAt: Math.floor(Date.now() / 1000)
      }
    },
    async status() {
      const balanceRaw =
        transfers.filter((t) => t.status === 'settled').reduce((s, t) => s + t.receivedRaw, 0) -
        outgoing.reduce((s, t) => s + t.amountRaw, 0)
      return { state: 'online', mock: true, pubkey: 'mock-node', balanceRaw, btcSats: 100_000 }
    },
    async createInvoice(amountRaw, expiresAt) {
      const recipientId = `mock:utxob:${++n}`
      requestedBy.set(recipientId, amountRaw)
      return {
        recipientId,
        invoice: `rgb:mock/${amountRaw ?? '~'}/${recipientId}?expiry=${expiresAt}`,
        expiresAt
      }
    },
    async listIncoming() {
      return transfers.map((t) => ({ ...t }))
    },
    async send(invoice, amountRaw) {
      const decoded = await backend.decodeInvoice(invoice)
      const txid = `mocktx-${randomUUID()}`
      outgoing.push({ recipientId: decoded.recipientId, amountRaw, txid, status: 'Settled' })
      return { txid }
    }
  }

  // simulates the client paying: waiting → confirming (2 s) → settled (5 s)
  function pay(recipientId: string, amountRaw: number): void {
    const t: IncomingTransfer = {
      idx: transfers.length + 1,
      recipientId,
      requestedRaw: requestedBy.get(recipientId) ?? null,
      receivedRaw: amountRaw,
      status: 'waiting',
      updatedAt: Math.floor(Date.now() / 1000)
    }
    transfers.push(t)
    setTimeout(() => (t.status = 'confirming'), 2000)
    setTimeout(() => {
      t.status = 'settled'
      t.txid = `mocktx-${t.idx}`
    }, 5000)
  }

  return { backend, pay }
}
