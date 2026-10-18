export type OperationState =
  | 'review'
  | 'submitting'
  | 'submitted'
  | 'confirming'
  | 'completed'
  | 'uncertain'
  | 'failed'
  | 'cancelled'
export interface PaymentIntent {
  invoice: string
  amount: string
  proposalId?: string
}
export interface SecurityOperation {
  id: string
  intentKey: string
  invoice: string
  recipientId: string
  assetId: string
  network: string
  amountRaw: number
  feeRate: number
  proposalId?: string
  state: OperationState
  createdAt: number
  updatedAt: number
  approvalExpiresAt: number
  txid?: string
  confirmations: number
  rgbStatus: string
  checkedAt?: number
  completedAt?: number
  error?: string
  history: { at: number; state: OperationState; detail: string }[]
}
export interface SecurityReview {
  operation: SecurityOperation
  approvalToken: string
  warnings: string[]
}
export interface SecurityFinding {
  id: string
  rule: string
  version: number
  subject: string
  severity: 'block' | 'review' | 'unavailable'
  message: string
  evidence: Record<string, string | number | boolean>
  history?: { at: number; check?: string; resolvedAt?: number }[]
  firstSeen: number
  lastSeen: number
  resolvedAt?: number
  acknowledgedAt?: number
}
export interface SecuritySnapshot {
  requiredConfirmations?: number
  operations: SecurityOperation[]
  findings: SecurityFinding[]
  monitoring: { lastSuccess?: number; error?: string }
}
export interface SecurityAPI {
  review(intent: PaymentIntent): Promise<SecurityReview>
  execute(
    id: string,
    approvalToken: string,
    destinationVerified: boolean
  ): Promise<SecurityOperation>
  snapshot(): Promise<SecuritySnapshot>
  acknowledge(id: string): Promise<void>
}
