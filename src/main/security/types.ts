import type { SecurityOperation, SecurityFinding } from '../../shared/security'
export interface DecodedInvoice {
  recipientId: string
  assetId: string | null
  network: string
  amountRaw: number | null
  expiresAt: number | null
  endpoints: string[]
}
export interface NetworkEvidence {
  network: string
  height: number
  referenceHeight: number
  identityVerified: boolean
  online: boolean
  balanceRaw: number
  btcSats: number
  checkedAt: number
  source: string
  recommendedFeeRate?: number
}
export interface OutgoingEvidence {
  recipientId: string
  amountRaw: number
  txid?: string
  status: string
}
export interface ChainEvidence {
  confirmed: boolean
  confirmations: number
  inBestChain: boolean
  checkedAt: number
}
export interface SecurityBackend {
  decodeInvoice(invoice: string): Promise<DecodedInvoice>
  networkEvidence(): Promise<NetworkEvidence>
  outgoingTransfers(): Promise<OutgoingEvidence[]>
  chainEvidence(txid: string): Promise<ChainEvidence>
  send(invoice: string, amountRaw: number): Promise<{ txid: string }>
}
export interface SecurityPolicy {
  assetId: string
  network: string
  feeRate: number
  maxFeeRate: number
  minBtcSats: number
  confirmations: number
  maxHeightLag: number
  evidenceMaxAge: number
  approvalSeconds: number
  allowedTransportHosts: string[]
}
export interface StoredOperation extends SecurityOperation {
  tokenHash: string
  detailsHash: string
}
export interface SecurityStore {
  operations(limit?: number): StoredOperation[]
  matching(intentKey: string, proposalId?: string): StoredOperation[]
  pending(now: number): StoredOperation[]
  getFinding(id: string): SecurityFinding | undefined
  get(id: string): StoredOperation | undefined
  save(operation: StoredOperation): void
  claim(id: string): boolean
  findings(limit?: number): SecurityFinding[]
  saveFinding(finding: SecurityFinding): void
}
