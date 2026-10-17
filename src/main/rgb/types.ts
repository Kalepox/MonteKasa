import type { SecurityBackend } from '../security/types'
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

export interface IncomingTransfer {
  idx: number // node transfer id, used to avoid double-processing
  recipientId: string
  requestedRaw: number | null // null = any amount
  receivedRaw: number
  status: TransferStatus
  txid?: string
  receiveUtxo?: string
  updatedAt: number
}

export interface RgbBackend extends SecurityBackend {
  status(): Promise<NodeStatus>
  createInvoice(amountRaw: number | null, expiresAt: number): Promise<RgbInvoice>
  listIncoming(): Promise<IncomingTransfer[]>
  send(recipientInvoice: string, amountRaw: number): Promise<{ txid: string }>
}
