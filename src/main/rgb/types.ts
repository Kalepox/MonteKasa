export type NodeState = 'online' | 'syncing' | 'locked' | 'offline'

export interface NodeStatus {
  state: NodeState
  mock: boolean
  pubkey?: string
  balanceRaw?: number // spendable
  btcSats?: number // vanilla (fee) balance
}

export interface RgbInvoice {
  recipientId: string
  invoice: string
  expiresAt: number
}

export type TransferStatus = 'waiting' | 'confirming' | 'settled' | 'failed'

export interface RgbTransfer {
  idx: number // node transfer id, used to avoid double-processing
  direction: 'in' | 'out'
  recipientId: string // in: our invoice's recipient id; out: the receiver's
  requestedRaw: number | null // in: what the invoice asked (null = any amount); out: what we sent
  receivedRaw: number // amount moved: received (in) or sent (out)
  status: TransferStatus
  txid?: string
  receiveUtxo?: string
  updatedAt: number
}

export interface RgbBackend {
  status(): Promise<NodeStatus>
  createInvoice(amountRaw: number | null, expiresAt: number): Promise<RgbInvoice>
  listTransfers(): Promise<RgbTransfer[]> // incoming and outgoing USDT transfers
  send(recipientInvoice: string, amountRaw: number): Promise<{ txid: string }>
}
