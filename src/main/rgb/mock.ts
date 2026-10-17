import type { RgbTransfer, RgbBackend } from './types'

export function createMockBackend() {
  const transfers: RgbTransfer[] = []
  const requestedBy = new Map<string, number | null>()
  let n = 0

  // waiting → confirming (2 s) → settled (5 s), like a real transfer
  function progress(t: RgbTransfer): void {
    setTimeout(() => (t.status = 'confirming'), 2000)
    setTimeout(() => {
      t.status = 'settled'
      t.txid = `mocktx-${t.idx}`
    }, 5000)
  }

  const backend: RgbBackend = {
    async status() {
      const settled = transfers.filter((t) => t.status === 'settled')
      const balanceRaw = settled.reduce((s, t) => s + (t.direction === 'in' ? t.receivedRaw : -t.receivedRaw), 0)
      return { state: 'online', mock: true, pubkey: 'mock-node', balanceRaw, btcSats: 100_000 }
    },
    async createInvoice(amountRaw, expiresAt) {
      const recipientId = `mock:utxob:${++n}`
      requestedBy.set(recipientId, amountRaw)
      return { recipientId, invoice: `rgb:mock/${amountRaw ?? '~'}/${recipientId}?expiry=${expiresAt}`, expiresAt }
    },
    async listTransfers() {
      return transfers.map((t) => ({ ...t }))
    },
    async send(recipientInvoice, amountRaw) {
      const t: RgbTransfer = {
        idx: transfers.length + 1,
        direction: 'out',
        recipientId: recipientInvoice,
        requestedRaw: amountRaw,
        receivedRaw: amountRaw,
        status: 'waiting',
        updatedAt: Math.floor(Date.now() / 1000)
      }
      transfers.push(t)
      progress(t)
      return { txid: `mocktx-${t.idx}` }
    }
  }

  // simulates the client paying an invoice
  function pay(recipientId: string, amountRaw: number): void {
    const t: RgbTransfer = {
      idx: transfers.length + 1,
      direction: 'in',
      recipientId,
      requestedRaw: requestedBy.get(recipientId) ?? null,
      receivedRaw: amountRaw,
      status: 'waiting',
      updatedAt: Math.floor(Date.now() / 1000)
    }
    transfers.push(t)
    progress(t)
  }

  return { backend, pay }
}
