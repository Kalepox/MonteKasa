import type { IncomingTransfer, RgbBackend } from './types'

export function createMockBackend() {
  const transfers: IncomingTransfer[] = []
  const requestedBy = new Map<string, number | null>()
  let n = 0

  const backend: RgbBackend = {
    async status() {
      const balanceRaw = transfers.filter((t) => t.status === 'settled').reduce((s, t) => s + t.receivedRaw, 0)
      return { state: 'online', mock: true, pubkey: 'mock-node', balanceRaw, btcSats: 100_000 }

    },
    async createInvoice(amountRaw, expiresAt) {
      const recipientId = `mock:utxob:${++n}`
      requestedBy.set(recipientId, amountRaw)
      return { recipientId, invoice: `rgb:mock/${amountRaw ?? '~'}/${recipientId}?expiry=${expiresAt}`, expiresAt }
    },
    async listIncoming() {
      return transfers.map((t) => ({ ...t }))
    },
    async send() {
      return { txid: `mocktx-${Date.now()}` }
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
