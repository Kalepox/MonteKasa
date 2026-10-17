import { ElectronAPI } from '@electron-toolkit/preload'

export interface KasaStatus {
  state: 'online' | 'syncing' | 'locked' | 'offline'
  mock: boolean
  pubkey?: string
  balance: number
  btcSats: number
}

export interface KasaInvoice {
  id: string
  client: string
  amount: number
  received: number
  rgbInvoice: string
  recipientId: string
  expiresAt: number
  state: string
  createdAt: number
}

export interface KasaProposal {
  id: string
  invoiceId: string
  kind: string
  amount: number
  reason: string
  status: string
  txid: string | null
  error: string | null
}

export interface KasaPayment {
  nodeIdx: number
  direction: 'in' | 'out'
  invoiceId: string | null
  received: number
  status: string
  txid: string | null
  blockTime: number | null
}

export interface KasaSnapshot {
  invoices: KasaInvoice[]
  proposals: KasaProposal[]
  payments: KasaPayment[]
}

declare global {
  interface Window {
    electron: ElectronAPI
    kasa: {
      status(): Promise<KasaStatus>
      snapshot(): Promise<KasaSnapshot>
      createInvoice(client: string, amount: number): Promise<KasaInvoice>
      receive(): Promise<{ invoice: string; expiresAt: number }>
      send(invoice: string, amount: number): Promise<{ txid: string }>
      approve(id: string, refundInvoice: string): Promise<void>
      dismiss(id: string): Promise<void>
      mockPay(recipientId: string, amount: number): Promise<void>
      onChanged(cb: () => void): () => void
    }
  }
}
