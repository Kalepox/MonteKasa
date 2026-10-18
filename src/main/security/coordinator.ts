import { createHash, randomUUID } from 'node:crypto'
import type {
  PaymentIntent,
  SecurityFinding,
  SecurityOperation,
  SecurityReview,
  SecuritySnapshot
} from '../../shared/security'
import type { SecurityBackend, SecurityPolicy, SecurityStore, StoredOperation } from './types'
import { requireCheck, SecurityViolation, validateInvoice, validateNetwork } from './rules'
import { toRaw } from '../core/units'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const detailsHash = (o: SecurityOperation): string =>
  hash(
    JSON.stringify([
      o.invoice,
      o.recipientId,
      o.assetId,
      o.network,
      o.amountRaw,
      o.feeRate,
      o.proposalId ?? null
    ])
  )
const publicOperation = (o: StoredOperation): SecurityOperation => {
  // Tokens and integrity fields never cross IPC.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tokenHash: _token, detailsHash: _details, ...rest } = o
  return rest
}

export class SecurityCoordinator {
  private busy = false
  private monitoring?: Promise<void>
  private monitorState: SecuritySnapshot['monitoring'] = {}
  constructor(
    private backend: SecurityBackend,
    private store: SecurityStore,
    private policy: SecurityPolicy,
    private verifyRefund: (id: string, raw: number) => Promise<void>,
    private changed: () => void = () => {},
    private now: () => number = () => Math.floor(Date.now() / 1000),
    private operationChanged: (operation: SecurityOperation) => void = () => {}
  ) {
    // A process may have died after broadcast and before saving the returned txid.
    for (const operation of store.operations()) {
      if (operation.state === 'submitting')
        this.transition(
          operation,
          'uncertain',
          'Restarted during submission. Do not resend; checking the node.'
        )
    }
  }

  finding(
    rule: string,
    subject: string,
    message: string,
    severity: SecurityFinding['severity'],
    evidence: SecurityFinding['evidence'] = {}
  ): void {
    const id = hash(`${rule}:${subject}`)
    const old = this.store.getFinding(id)
    const same =
      old &&
      !old.resolvedAt &&
      old.message === message &&
      JSON.stringify(old.evidence) === JSON.stringify(evidence)
    this.store.saveFinding({
      id,
      rule,
      version: 1,
      subject,
      severity,
      message,
      evidence,
      history: same
        ? old?.history
        : [
            ...(old?.history ?? []),
            ...(old
              ? [
                  {
                    at: old.lastSeen,
                    check: typeof old.evidence.check === 'string' ? old.evidence.check : undefined,
                    resolvedAt: old.resolvedAt
                  }
                ]
              : [])
          ].slice(-50),
      firstSeen: old?.firstSeen ?? this.now(),
      lastSeen: this.now(),
      acknowledgedAt: same ? old.acknowledgedAt : undefined
    })
  }
  resolve(rule: string, subject: string): void {
    const finding = this.store.getFinding(hash(`${rule}:${subject}`))
    if (finding && !finding.resolvedAt)
      this.store.saveFinding({ ...finding, resolvedAt: this.now() })
  }
  acknowledge(id: unknown): void {
    requireCheck(typeof id === 'string', 'input', 'Invalid finding ID.')
    const finding = this.store.getFinding(id)
    requireCheck(finding, 'input', 'Finding not found.')
    this.store.saveFinding({ ...finding, acknowledgedAt: this.now() })
    this.changed()
  }
  snapshot(): SecuritySnapshot {
    return {
      requiredConfirmations: this.policy.confirmations,
      operations: this.store.operations(200).map(publicOperation),
      findings: this.store.findings(200),
      monitoring: this.monitorState
    }
  }
  private transition(o: StoredOperation, state: SecurityOperation['state'], detail: string): void {
    if (o.state !== state || o.history.at(-1)?.detail !== detail) {
      o.history.push({ at: this.now(), state, detail })
      o.history = o.history.slice(-100)
    }
    if (state === 'completed' && o.state !== 'completed') o.completedAt = this.now()
    if (state !== 'completed') o.completedAt = undefined
    o.state = state
    o.updatedAt = this.now()
    this.store.save(o)
    this.operationChanged(publicOperation(o))
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    requireCheck(!this.busy, 'busy', 'Another payment review or submission is in progress.')
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
      this.changed()
    }
  }
  private async checks(
    invoice: string,
    raw: number,
    proposalId?: string
  ): Promise<{
    decoded: Awaited<ReturnType<SecurityBackend['decodeInvoice']>>
    warnings: string[]
  }> {
    const decoded = await this.backend.decodeInvoice(invoice)
    const warnings = validateInvoice(decoded, raw, this.policy, this.now())
    const network = await this.backend.networkEvidence()
    warnings.push(...validateNetwork(network, raw, this.policy, this.now()))
    if (network.source.startsWith('MOCK'))
      warnings.push(
        'MOCK MODE: simulated network and settlement evidence; no real payment is made.'
      )
    if (!network.recommendedFeeRate)
      warnings.push(
        'Live fee estimate unavailable. The configured fee rate and minimum BTC reserve are checked, but total fee and confirmation time are not guaranteed.'
      )
    if (proposalId) {
      await this.verifyRefund(proposalId, raw)
      warnings.push(
        'Verify this refund destination with the customer through an independently trusted channel. A fresh RGB recipient does not establish identity.'
      )
    }
    validateInvoice(decoded, raw, this.policy, this.now())
    validateNetwork(network, raw, this.policy, this.now())
    return { decoded, warnings }
  }
  async review(input: PaymentIntent): Promise<SecurityReview> {
    return this.exclusive(async () => {
      let subject = 'payment-review'
      try {
        requireCheck(
          input &&
            typeof input.invoice === 'string' &&
            input.invoice.startsWith('rgb:') &&
            input.invoice.length <= 16000,
          'input',
          'Provide an RGB invoice (maximum 16,000 characters).'
        )
        requireCheck(
          input.proposalId === undefined ||
            (typeof input.proposalId === 'string' && input.proposalId.length <= 100),
          'input',
          'Invalid refund proposal.'
        )
        subject = hash(input.invoice)
        const raw = toRaw(input.amount)
        const { decoded, warnings } = await this.checks(input.invoice, raw, input.proposalId)
        const intentKey = hash(
          JSON.stringify([this.policy.network, this.policy.assetId, decoded.recipientId])
        )
        const matching = this.store.matching(intentKey, input.proposalId)
        requireCheck(
          matching.length <= 1 && matching.every((o) => o.state === 'review'),
          'duplicate',
          'This recipient or refund already has a submitted operation. Review its status; do not resend.',
          'block',
          {
            relatedOperationId:
              (matching.find((o) => o.state !== 'review') ?? matching[0])?.id ?? ''
          }
        )
        const existing = matching[0]
        const token = randomUUID()
        const o: StoredOperation = {
          id: existing?.id ?? randomUUID(),
          intentKey,
          invoice: input.invoice,
          recipientId: decoded.recipientId,
          assetId: this.policy.assetId,
          network: this.policy.network,
          amountRaw: raw,
          feeRate: this.policy.feeRate,
          proposalId: input.proposalId,
          state: 'review',
          createdAt: existing?.createdAt ?? this.now(),
          updatedAt: this.now(),
          approvalExpiresAt: this.now() + this.policy.approvalSeconds,
          confirmations: 0,
          rgbStatus: 'not-submitted',
          tokenHash: hash(token),
          detailsHash: '',
          history: [
            ...(existing?.history ?? []),
            {
              at: this.now(),
              state: 'review' as const,
              detail: 'Fresh checks passed; awaiting approval of these exact details.'
            }
          ].slice(-100)
        }
        o.detailsHash = detailsHash(o)
        this.store.save(o)
        this.resolve('review-failed', subject)
        if (input.proposalId) this.finding('refund-destination', o.id, warnings.at(-1)!, 'review')
        return { operation: publicOperation(o), approvalToken: token, warnings }
      } catch (error) {
        this.finding(
          'review-failed',
          subject,
          error instanceof Error ? error.message : String(error),
          error instanceof SecurityViolation ? error.severity : 'unavailable',
          {
            ...(error instanceof SecurityViolation ? error.evidence : {}),
            check: error instanceof SecurityViolation ? error.rule : 'backend'
          }
        )
        throw error
      }
    })
  }
  async execute(
    id: unknown,
    token: unknown,
    destinationVerified: unknown
  ): Promise<SecurityOperation> {
    return this.exclusive(async () => {
      requireCheck(
        typeof id === 'string' && typeof token === 'string',
        'input',
        'Invalid approval.'
      )
      const o = this.store.get(id)
      requireCheck(
        o && o.state === 'review',
        'duplicate',
        'Operation is not awaiting approval. Do not resend.'
      )
      try {
        requireCheck(
          hash(token) === o.tokenHash && detailsHash(o) === o.detailsHash,
          'approval',
          'Approval does not match the reviewed transaction.'
        )
        requireCheck(
          this.now() < o.approvalExpiresAt,
          'approval-expiry',
          'Approval expired. Review the transaction again.'
        )
        requireCheck(
          !o.proposalId || destinationVerified === true,
          'refund-destination',
          'Independently verify the refund destination before approval.'
        )
        requireCheck(
          o.feeRate === this.policy.feeRate,
          'fee-change',
          'Fee policy changed; review again.'
        )
        const { decoded } = await this.checks(o.invoice, o.amountRaw, o.proposalId)
        requireCheck(
          decoded.recipientId === o.recipientId &&
            o.network === this.policy.network &&
            o.assetId === this.policy.assetId,
          'approval-change',
          'Transaction details changed.'
        )
        requireCheck(
          this.now() < o.approvalExpiresAt,
          'approval-expiry',
          'Approval expired during verification. Review again.'
        )
        requireCheck(this.store.claim(id), 'duplicate', 'Operation already claimed.')
      } catch (error) {
        // Any failed approval attempt requires a fresh review/token.
        if (this.store.get(o.id)?.state === 'review') {
          o.tokenHash = ''
          this.store.save(o)
        }
        this.finding(
          'execution-blocked',
          o.id,
          String((error as Error).message ?? error),
          error instanceof SecurityViolation ? error.severity : 'unavailable',
          {
            ...(error instanceof SecurityViolation ? error.evidence : {}),
            check: error instanceof SecurityViolation ? error.rule : 'backend'
          }
        )
        throw error
      }
      this.transition(o, 'submitting', 'Submission recorded before calling the node.')
      try {
        const result = await this.backend.send(o.invoice, o.amountRaw)
        requireCheck(
          typeof result.txid === 'string' && result.txid.length > 0,
          'submission-result',
          'Node returned no transaction ID.'
        )
        o.txid = result.txid
        this.transition(
          o,
          'submitted',
          'Node accepted the request; settlement is not yet verified.'
        )
        this.resolve('execution-blocked', o.id)
        if (o.proposalId) this.resolve('refund-destination', o.id)
      } catch (error) {
        o.error = String((error as Error).message ?? error)
        this.transition(
          o,
          'uncertain',
          'Submission outcome is unknown. Automatic retries are disabled.'
        )
        this.finding(
          'uncertain-submission',
          o.id,
          'The node may have accepted this payment. Do not resend while its outcome is unknown.',
          'unavailable'
        )
      }
      return publicOperation(o)
    })
  }
  monitor(): Promise<void> {
    if (this.monitoring) return this.monitoring
    if (this.busy) return Promise.reject(new Error('Payment review or submission is in progress.'))
    this.monitoring = this.runMonitor().finally(() => {
      this.monitoring = undefined
    })
    return this.monitoring
  }

  private async runMonitor(): Promise<void> {
    try {
      const operations = this.store.pending(this.now())
      if (!operations.length) {
        this.monitorState = { lastSuccess: this.now() }
        return
      }
      const outgoing = await this.backend.outgoingTransfers()
      const startedAt = Date.now()
      for (const old of operations) {
        if (Date.now() - startedAt > 10000) break
        const o = this.store.get(old.id)!
        o.checkedAt = this.now()
        this.store.save(o)
        if (o.network !== this.policy.network || o.assetId !== this.policy.assetId) {
          this.finding(
            'monitor-configuration',
            o.id,
            'Payment belongs to a different network or asset configuration. Restore its original configuration to verify settlement.',
            'unavailable'
          )
          if (o.state === 'completed')
            this.transition(o, 'uncertain', 'Original network configuration is unavailable.')
          continue
        }
        this.resolve('monitor-configuration', o.id)
        const matches = outgoing.filter(
          (t) =>
            t.recipientId === o.recipientId &&
            t.amountRaw === o.amountRaw &&
            (!o.txid || t.txid === o.txid)
        )
        if (matches.length !== 1) {
          this.finding(
            'transfer-evidence',
            o.id,
            'A unique matching outgoing RGB transfer is not available. Settlement cannot be verified.',
            'unavailable'
          )
          if (o.state === 'completed')
            this.transition(o, 'uncertain', 'Previously settled transfer cannot be verified.')
          continue
        }
        const transfer = matches[0]
        o.txid ??= transfer.txid
        o.rgbStatus = transfer.status
        o.checkedAt = this.now()
        this.resolve('transfer-evidence', o.id)
        if (transfer.status === 'Failed') {
          this.transition(
            o,
            'failed',
            'RGB node reports failure. Review manually; no automatic resend.'
          )
          this.finding(
            'rgb-failed',
            o.id,
            'RGB transfer failed. Check the node before taking further action.',
            'review'
          )
          continue
        }
        if (!o.txid) {
          this.transition(
            o,
            'submitted',
            `RGB status: ${transfer.status}; no broadcast transaction observed.`
          )
          continue
        }
        try {
          const chain = await this.backend.chainEvidence(o.txid)
          requireCheck(
            chain.checkedAt <= this.now() + 5 &&
              this.now() - chain.checkedAt <= this.policy.evidenceMaxAge,
            'stale-chain',
            'Chain evidence is stale.',
            'unavailable'
          )
          o.confirmations = chain.inBestChain && chain.confirmed ? chain.confirmations : 0
          const complete =
            transfer.status === 'Settled' &&
            Number.isSafeInteger(o.confirmations) &&
            o.confirmations >= this.policy.confirmations
          if (old.state === 'completed' && !complete)
            this.finding(
              'settlement-regression',
              o.id,
              'Previously completed payment no longer meets settlement policy. Review possible reorganization or RGB status change.',
              'review',
              {
                confirmations: o.confirmations,
                requiredConfirmations: this.policy.confirmations,
                rgbStatus: transfer.status,
                checkedAt: chain.checkedAt
              }
            )
          this.transition(
            o,
            complete ? 'completed' : 'confirming',
            complete
              ? 'Matching RGB transfer settled and Bitcoin confirmation policy met.'
              : `RGB: ${transfer.status}; Bitcoin confirmations: ${o.confirmations}/${this.policy.confirmations}.`
          )
          this.resolve('chain-unavailable', o.id)
          if (complete) {
            this.resolve('settlement-regression', o.id)
            this.resolve('uncertain-submission', o.id)
          }
        } catch (error) {
          this.finding(
            'chain-unavailable',
            o.id,
            `Confirmation verification unavailable: ${String((error as Error).message ?? error)}`,
            'unavailable'
          )
          if (o.state === 'completed')
            this.transition(o, 'uncertain', 'Current settlement verification unavailable.')
          else this.store.save(o)
        }
      }
      this.monitorState = { lastSuccess: this.now() }
      this.resolve('monitor-unavailable', 'network')
    } catch (error) {
      this.monitorState = { ...this.monitorState, error: String((error as Error).message ?? error) }
      this.finding(
        'monitor-unavailable',
        'network',
        'Outgoing transfer refresh failed. Last known statuses may be stale.',
        'unavailable'
      )
    } finally {
      this.changed()
    }
  }
}
