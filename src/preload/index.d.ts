import type { TaxScopeAPI } from '../shared/tax-scope'
import type { TaxProfileAPI } from '../shared/tax-profile'
import type { AppProfilesAPI } from '../shared/app-profile'
import type { SecurityAPI } from '../shared/security'
import type { AgentAPI } from '../shared/agent'
import type { LedgerSource } from '../shared/ledger-source'

export interface KasaStatus {
  state: 'online' | 'syncing' | 'locked' | 'offline' | 'timeout' | 'error'
  error?: string
  configurationError?: string
  mock: boolean
  pubkey?: string
  balance: number // spendable (settled)
  future?: number // display: settled + incoming − outgoing still on their way
  btcSats: number
}

export interface KasaInvoice {
  source?: LedgerSource
  amountRaw?: number
  receivedRaw?: number
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
  source?: LedgerSource
  receivedRaw?: number
  requestedRaw?: number | null
  recipientId?: string
  updatedAt?: number
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
    appProfiles: AppProfilesAPI
    taxScope: TaxScopeAPI
    taxProfile: TaxProfileAPI
    agent: AgentAPI
    security: SecurityAPI
    kasa: {
      status(): Promise<KasaStatus>
      snapshot(): Promise<KasaSnapshot>
      invoicePdf(id: string): Promise<Uint8Array>
      createInvoice(client: string, amount: number | string): Promise<KasaInvoice>
      receive(
        fresh?: boolean,
        amount?: string | number
      ): Promise<{ invoice: string; expiresAt: number }>
      emailInvoice(to: string | undefined, subject: string, body: string): Promise<boolean>
      send(invoice: string, amount: number): Promise<{ txid: string }>
      approve(id: string, refundInvoice: string): Promise<void>
      dismiss(id: string): Promise<void>
      mockPay(recipientId: string, amount: number): Promise<void>
      wallet(method: string, params?: Record<string, unknown>): Promise<unknown>
      onChanged(cb: () => void): () => void
      onPayment(
        cb: (p: { amount: number; client?: string; invoiceId?: string }) => void
      ): () => void
    }
  }
}
