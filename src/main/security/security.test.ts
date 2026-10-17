import { describe, expect, it, vi } from 'vitest'
import { SecurityCoordinator } from './coordinator'
import { validateInvoice, validateNetwork } from './rules'
import { toRaw } from '../core/units'
import { ChainObserver } from './network'
import type {
  SecurityBackend,
  SecurityPolicy,
  SecurityStore,
  StoredOperation,
  NetworkEvidence,
  DecodedInvoice
} from './types'
import type { SecurityFinding } from '../../shared/security'

class MemoryStore implements SecurityStore {
  ops = new Map<string, StoredOperation>()
  fs = new Map<string, SecurityFinding>()
  operations(): StoredOperation[] {
    return structuredClone([...this.ops.values()])
  }
  matching(key: string, proposal?: string): StoredOperation[] {
    return this.operations().filter(
      (o) => o.intentKey === key || (proposal && o.proposalId === proposal)
    )
  }
  pending(now: number): StoredOperation[] {
    return this.operations()
      .filter(
        (o) =>
          !['review', 'cancelled', 'failed'].includes(o.state) &&
          (o.state !== 'completed' || now - (o.completedAt ?? o.updatedAt) < 86400)
      )
      .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
      .slice(0, 5)
  }
  getFinding(id: string): SecurityFinding | undefined {
    return structuredClone(this.fs.get(id))
  }
  get(id: string): StoredOperation | undefined {
    return structuredClone(this.ops.get(id))
  }
  save(o: StoredOperation): void {
    this.ops.set(o.id, structuredClone(o))
  }
  claim(id: string): boolean {
    const o = this.get(id)
    if (!o || o.state !== 'review') return false
    o.state = 'submitting'
    this.save(o)
    return true
  }
  findings(): SecurityFinding[] {
    return structuredClone([...this.fs.values()])
  }
  saveFinding(f: SecurityFinding): void {
    this.fs.set(f.id, structuredClone(f))
  }
}
const policy: SecurityPolicy = {
  assetId: 'asset',
  network: 'SignetCustom',
  feeRate: 2,
  maxFeeRate: 20,
  minBtcSats: 1000,
  confirmations: 3,
  maxHeightLag: 2,
  evidenceMaxAge: 30,
  approvalSeconds: 120,
  allowedTransportHosts: ['proxy.example']
}
const decoded: DecodedInvoice = {
  recipientId: 'recipient',
  assetId: 'asset',
  network: 'SignetCustom',
  amountRaw: 1000000,
  expiresAt: 2000,
  endpoints: ['rpcs://proxy.example/rpc']
}
const network: NetworkEvidence = {
  network: 'SignetCustom',
  height: 100,
  referenceHeight: 100,
  identityVerified: true,
  online: true,
  balanceRaw: 100000000,
  btcSats: 10000,
  checkedAt: 1000,
  source: 'test'
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const store = new MemoryStore()
  const backend = {
    decodeInvoice: vi.fn(async () => structuredClone(decoded)),
    networkEvidence: vi.fn(async () => structuredClone(network)),
    send: vi.fn(async () => ({ txid: 'a'.repeat(64) })),
    outgoingTransfers: vi.fn(async () => [
      { recipientId: 'recipient', amountRaw: 1000000, txid: 'a'.repeat(64), status: 'Settled' }
    ]),
    chainEvidence: vi.fn(async () => ({
      confirmed: true,
      confirmations: 3,
      inBestChain: true,
      checkedAt: 1000
    }))
  } satisfies SecurityBackend
  const refund = vi.fn(async () => {})
  let time = 1000
  const create = (): SecurityCoordinator =>
    new SecurityCoordinator(
      backend,
      store,
      policy,
      refund,
      () => {},
      () => time
    )
  return {
    store,
    backend,
    refund,
    create,
    agent: create(),
    setTime: (n: number): void => {
      time = n
    }
  }
}
const intent = { invoice: 'rgb:invoice', amount: '1' }

it('records the values that caused a payment review to fail', async () => {
  const f = fixture()
  f.backend.decodeInvoice.mockResolvedValueOnce({ ...decoded, amountRaw: 2000000 })
  await expect(f.agent.review(intent)).rejects.toThrow('fixed invoice amount')
  expect(f.agent.snapshot().findings[0].evidence).toEqual({
    check: 'invoice-amount',
    requestedRaw: 1000000,
    invoiceAmountRaw: 2000000
  })
  expect(f.backend.send).not.toHaveBeenCalled()
})

it('records balance and expiry evidence at the time of failure', async () => {
  const f = fixture()
  f.backend.networkEvidence.mockResolvedValueOnce({ ...network, balanceRaw: 500000 })
  await expect(f.agent.review(intent)).rejects.toThrow('spendable')
  expect(f.agent.snapshot().findings[0].evidence).toMatchObject({
    check: 'balance',
    requestedRaw: 1000000,
    availableRaw: 500000,
    checkedAt: 1000
  })
  f.backend.decodeInvoice.mockResolvedValueOnce({ ...decoded, expiresAt: 999 })
  await expect(f.agent.review(intent)).rejects.toThrow('expired')
  expect(f.agent.snapshot().findings[0].evidence).toEqual({
    check: 'expiry',
    expiresAt: 999,
    checkedAt: 1000
  })
})

it('shares an in-flight monitor and updates two confirmations to three without resending', async () => {
  const f = fixture()
  const review = await f.agent.review(intent)
  await f.agent.execute(review.operation.id, review.approvalToken, false)
  f.backend.chainEvidence.mockResolvedValueOnce({
    confirmed: true,
    confirmations: 2,
    inBestChain: true,
    checkedAt: 1000
  })
  await f.agent.monitor()
  expect(f.agent.snapshot().operations[0].state).toBe('confirming')
  let finish!: (value: Awaited<ReturnType<typeof f.backend.chainEvidence>>) => void
  f.backend.chainEvidence.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = f.agent.monitor()
  const second = f.agent.monitor()
  expect(first).toBe(second)
  await Promise.resolve()
  finish({ confirmed: true, confirmations: 3, inBestChain: true, checkedAt: 1000 })
  await second
  expect(f.agent.snapshot().operations[0].state).toBe('completed')
  expect(f.agent.snapshot().operations[0].confirmations).toBe(3)
  expect(f.backend.send).toHaveBeenCalledOnce()
})

describe('exact amount parsing', () => {
  it.each(['1', '0.000001', '1.100001', '9007199254.740991'])('parses %s exactly', (value) => {
    const [whole, fraction = ''] = value.split('.')
    expect(toRaw(value)).toBe(Number(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))))
  })
  it.each(['0', '-1', '1e6', '1.0000001', '9007199254.740992', '1x', '', 'NaN', 'Infinity'])(
    'rejects %s',
    (value) => expect(() => toRaw(value)).toThrow()
  )
})
describe('invoice and network controls', () => {
  it.each([
    { network: 'Mainnet' },
    { assetId: 'wrong' },
    { expiresAt: 1000 },
    { amountRaw: 999 },
    { endpoints: ['rpc://proxy.example'] },
    { endpoints: ['rpcs://evil.example'] },
    { endpoints: [] }
  ])('blocks invalid invoice %j', (patch) =>
    expect(() => validateInvoice({ ...decoded, ...patch }, 1000000, policy, 1000)).toThrow()
  )
  it('accepts explicit open amount and warns for unspecified asset/expiry', () => {
    expect(
      validateInvoice(
        { ...decoded, amountRaw: null, assetId: null, expiresAt: null },
        10,
        policy,
        1000
      )
    ).toHaveLength(3)
  })
  it.each([
    { online: false },
    { identityVerified: false },
    { network: 'Mainnet' },
    { checkedAt: 900 },
    { checkedAt: 1020 },
    { height: 90 },
    { balanceRaw: 0 },
    { btcSats: 10 },
    { height: NaN }
  ])('blocks invalid network %j', (patch) =>
    expect(() => validateNetwork({ ...network, ...patch }, 1000000, policy, 1000)).toThrow()
  )
  it('enforces the fee rate ceiling', () =>
    expect(() => validateNetwork(network, 1, { ...policy, feeRate: 21 }, 1000)).toThrow('fee rate'))
})
describe('execution gate', () => {
  it('requires review and exact token, without sending', async () => {
    const f = fixture()
    await expect(f.agent.execute('missing', 'bad', false)).rejects.toThrow()
    const r = await f.agent.review(intent)
    await expect(f.agent.execute(r.operation.id, 'bad', false)).rejects.toThrow('Approval')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('invalidates an earlier token when details are reviewed again', async () => {
    const f = fixture()
    const first = await f.agent.review(intent)
    await f.agent.review(intent)
    await expect(f.agent.execute(first.operation.id, first.approvalToken, false)).rejects.toThrow(
      'Approval'
    )
  })
  it('rejects stale approvals before and after slow preflight', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    f.backend.networkEvidence.mockImplementationOnce(async () => {
      f.setTime(1121)
      return { ...network, checkedAt: 1121 }
    })
    await expect(f.agent.execute(r.operation.id, r.approvalToken, false)).rejects.toThrow('expired')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('revalidates invoice and network immediately before submission', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    f.backend.decodeInvoice.mockResolvedValueOnce({ ...decoded, amountRaw: 2 })
    await expect(f.agent.execute(r.operation.id, r.approvalToken, false)).rejects.toThrow('Amount')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('records submission before network call, rejects duplicates and keeps token private', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    f.backend.send.mockImplementationOnce(async () => {
      expect(f.store.get(r.operation.id)?.state).toBe('submitting')
      return { txid: 'a'.repeat(64) }
    })
    expect((await f.agent.execute(r.operation.id, r.approvalToken, false)).state).toBe('submitted')
    await expect(f.agent.execute(r.operation.id, r.approvalToken, false)).rejects.toThrow(
      'not awaiting'
    )
    await expect(f.agent.review(intent)).rejects.toThrow('already')
    expect(f.backend.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.agent.snapshot())).not.toContain('tokenHash')
  })
  it('serializes concurrent approvals', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    const outcomes = await Promise.allSettled([
      f.agent.execute(r.operation.id, r.approvalToken, false),
      f.agent.execute(r.operation.id, r.approvalToken, false)
    ])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    expect(f.backend.send).toHaveBeenCalledTimes(1)
  })
  it('keeps a timeout uncertain and never blindly retries', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    f.backend.send.mockRejectedValueOnce(new Error('timeout'))
    expect((await f.agent.execute(r.operation.id, r.approvalToken, false)).state).toBe('uncertain')
    await expect(f.agent.review(intent)).rejects.toThrow('already')
    expect(f.backend.send).toHaveBeenCalledTimes(1)
  })
  it('requires refund verification and rechecks settled excess', async () => {
    const f = fixture()
    const r = await f.agent.review({ ...intent, proposalId: 'proposal' })
    await expect(f.agent.execute(r.operation.id, r.approvalToken, false)).rejects.toThrow('verify')
    const retry = await f.agent.review({ ...intent, proposalId: 'proposal' })
    f.refund.mockRejectedValueOnce(new Error('Excess changed'))
    await expect(f.agent.execute(retry.operation.id, retry.approvalToken, true)).rejects.toThrow(
      'Excess changed'
    )
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('acknowledgment does not bypass a failed check', async () => {
    const f = fixture()
    f.backend.networkEvidence.mockResolvedValue({ ...network, online: false })
    await expect(f.agent.review(intent)).rejects.toThrow()
    f.agent.acknowledge(f.agent.snapshot().findings[0].id)
    await expect(f.agent.review(intent)).rejects.toThrow()
    expect(f.agent.snapshot().findings).toHaveLength(1)
  })
})
describe('settlement and restart recovery', () => {
  it('recovers interrupted submissions without sending again', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    f.store.claim(r.operation.id)
    const restarted = f.create()
    expect(restarted.snapshot().operations[0].state).toBe('uncertain')
    await restarted.monitor()
    expect(restarted.snapshot().operations[0].state).toBe('completed')
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('requires RGB settlement AND sufficient best-chain confirmations', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    await f.agent.execute(r.operation.id, r.approvalToken, false)
    f.backend.outgoingTransfers.mockResolvedValueOnce([
      {
        recipientId: 'recipient',
        amountRaw: 1000000,
        txid: 'a'.repeat(64),
        status: 'WaitingCounterparty'
      }
    ])
    await f.agent.monitor()
    expect(f.agent.snapshot().operations[0].state).toBe('confirming')
    f.backend.chainEvidence.mockResolvedValueOnce({
      confirmed: true,
      confirmations: 1,
      inBestChain: true,
      checkedAt: 1000
    })
    await f.agent.monitor()
    expect(f.agent.snapshot().operations[0].state).toBe('confirming')
    await f.agent.monitor()
    expect(f.agent.snapshot().operations[0].state).toBe('completed')
    f.backend.chainEvidence.mockResolvedValueOnce({
      confirmed: true,
      confirmations: 0,
      inBestChain: false,
      checkedAt: 1000
    })
    await f.agent.monitor()
    expect(f.agent.snapshot().operations[0].state).toBe('confirming')
    expect(
      f.agent.snapshot().findings.some((f) => f.rule === 'settlement-regression' && !f.resolvedAt)
    ).toBe(true)
  })
  it('never treats explorer failure as a failed payment or safe retry', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    await f.agent.execute(r.operation.id, r.approvalToken, false)
    f.backend.chainEvidence.mockRejectedValueOnce(new Error('404'))
    await f.agent.monitor()
    expect(f.agent.snapshot().operations[0].state).toBe('submitted')
    expect(f.agent.snapshot().findings.some((f) => f.rule === 'chain-unavailable')).toBe(true)
  })
  it('refuses mismatched or ambiguous outgoing evidence', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    await f.agent.execute(r.operation.id, r.approvalToken, false)
    f.backend.outgoingTransfers.mockResolvedValueOnce([
      { recipientId: 'other', amountRaw: 1000000, txid: 'a'.repeat(64), status: 'Settled' }
    ])
    await f.agent.monitor()
    expect(f.backend.chainEvidence).not.toHaveBeenCalled()
    expect(f.agent.snapshot().operations[0].state).not.toBe('completed')
  })
})
describe('chain observer', () => {
  it('rejects missing checkpoint configuration', async () => {
    const observer = new ChainObserver('https://example.com', 0, '')
    await expect(observer.identity()).rejects.toThrow('Configure')
  })
  it('validates checkpoint and best-chain inclusion before counting confirmations', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.endsWith('/block-height/1')) return new Response('b'.repeat(64))
      if (path.includes('/tx/'))
        return Response.json({ confirmed: true, block_height: 10, block_hash: 'c'.repeat(64) })
      if (path.includes('/block/')) return Response.json({ in_best_chain: true })
      return new Response('12')
    }) as unknown as typeof fetch
    const observer = new ChainObserver('https://example.com', 1, 'b'.repeat(64), request)
    expect((await observer.transaction('a'.repeat(64))).confirmations).toBe(3)
  })
  it('rejects a wrong chain checkpoint and HTTP errors', async () => {
    const wrong = new ChainObserver(
      'https://example.com',
      1,
      'b'.repeat(64),
      vi.fn(async () => new Response('c'.repeat(64)))
    )
    await expect(wrong.identity()).rejects.toThrow('mismatch')
    const missing = new ChainObserver(
      'https://example.com',
      1,
      'b'.repeat(64),
      vi.fn(async () => new Response('', { status: 404 }))
    )
    await expect(missing.identity()).rejects.toThrow('404')
  })
})

describe('additional security boundaries', () => {
  it('rejects expiry reached during network verification', async () => {
    const f = fixture()
    f.backend.decodeInvoice.mockResolvedValueOnce({ ...decoded, expiresAt: 1001 })
    f.backend.networkEvidence.mockImplementationOnce(async () => {
      f.setTime(1002)
      return { ...network, checkedAt: 1002 }
    })
    await expect(f.agent.review(intent)).rejects.toThrow('expired')
  })
  it('detects tampering with stored transaction details', async () => {
    const f = fixture()
    const review = await f.agent.review(intent)
    const operation = f.store.get(review.operation.id)!
    operation.amountRaw = 2
    f.store.save(operation)
    await expect(f.agent.execute(operation.id, review.approvalToken, false)).rejects.toThrow(
      'Approval'
    )
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it('new refund recipient review invalidates the previous approval', async () => {
    const f = fixture()
    const first = await f.agent.review({ ...intent, proposalId: 'p' })
    f.backend.decodeInvoice.mockResolvedValueOnce({ ...decoded, recipientId: 'new-recipient' })
    const second = await f.agent.review({ ...intent, invoice: 'rgb:new', proposalId: 'p' })
    expect(second.operation.id).toBe(first.operation.id)
    await expect(f.agent.execute(first.operation.id, first.approvalToken, true)).rejects.toThrow(
      'Approval'
    )
    expect(f.backend.send).not.toHaveBeenCalled()
  })
  it.each(['network', 'assetId'] as const)(
    'does not settle a stored payment against a different %s configuration',
    async (field) => {
      const f = fixture()
      const r = await f.agent.review(intent)
      await f.agent.execute(r.operation.id, r.approvalToken, false)
      const operation = f.store.get(r.operation.id)!
      operation[field] = 'different'
      f.store.save(operation)
      await f.agent.monitor()
      expect(f.store.get(operation.id)!.state).toBe('submitted')
      expect(f.backend.chainEvidence).not.toHaveBeenCalled()
      expect(f.store.findings().some((finding) => finding.rule === 'monitor-configuration')).toBe(
        true
      )
    }
  )
  it('does not keep polling completed operations beyond the monitoring window', async () => {
    const f = fixture()
    const r = await f.agent.review(intent)
    await f.agent.execute(r.operation.id, r.approvalToken, false)
    await f.agent.monitor()
    f.setTime(1000 + 86401)
    f.backend.outgoingTransfers.mockClear()
    await f.agent.monitor()
    expect(f.backend.outgoingTransfers).not.toHaveBeenCalled()
  })
})

describe('freshness and balance execution regressions', () => {
  it.each(['expiry', 'balance', 'btc-reserve', 'stale-network'])(
    'blocks changed %s evidence after review, retains the check ID, and invalidates approval',
    async (check) => {
      const f = fixture()
      const r = await f.agent.review(intent)
      if (check === 'expiry')
        f.backend.decodeInvoice.mockResolvedValue({ ...decoded, expiresAt: 1000 })
      else
        f.backend.networkEvidence.mockResolvedValue({
          ...network,
          ...(check === 'balance'
            ? { balanceRaw: 999999 }
            : check === 'btc-reserve'
              ? { btcSats: 999 }
              : { checkedAt: 969 })
        })
      await expect(f.agent.execute(r.operation.id, r.approvalToken, true)).rejects.toThrow()
      const finding = f.agent.snapshot().findings.find((f) => f.rule === 'execution-blocked')!
      expect(finding.evidence.check).toBe(check)
      expect(finding.severity).toBe(check === 'stale-network' ? 'unavailable' : 'block')
      expect(f.store.get(r.operation.id)!.tokenHash).toBe('')
      f.agent.acknowledge(finding.id)
      await expect(f.agent.review(intent)).rejects.toThrow()
      await expect(f.agent.execute(r.operation.id, r.approvalToken, true)).rejects.toThrow(
        'Approval'
      )
      expect(f.backend.send).not.toHaveBeenCalled()
      f.backend.decodeInvoice.mockResolvedValue(structuredClone(decoded))
      f.backend.networkEvidence.mockResolvedValue(structuredClone(network))
      const fresh = await f.agent.review(intent)
      expect(fresh.approvalToken).not.toBe(r.approvalToken)
      expect(f.backend.send).not.toHaveBeenCalled()
    }
  )
  it('accepts the exact freshness and balance limits, rejecting the immediately adjacent invalid values', () => {
    expect(() =>
      validateNetwork(
        { ...network, balanceRaw: 1000000, btcSats: 1000, checkedAt: 970 },
        1000000,
        policy,
        1000
      )
    ).not.toThrow()
    expect(() => validateNetwork({ ...network, checkedAt: 969 }, 1000000, policy, 1000)).toThrow(
      'stale'
    )
    expect(() =>
      validateNetwork({ ...network, checkedAt: 1005 }, 1000000, policy, 1000)
    ).not.toThrow()
    expect(() => validateNetwork({ ...network, checkedAt: 1006 }, 1000000, policy, 1000)).toThrow(
      'stale'
    )
  })
})

describe('read-only recovery and history', () => {
  it('retries a transient chain read once but preserves a checkpoint mismatch', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response('b'.repeat(64)))
    await expect(
      new ChainObserver('https://example.com', 1, 'b'.repeat(64), request).identity()
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
    const wrong = vi.fn().mockResolvedValue(new Response('c'.repeat(64)))
    await expect(
      new ChainObserver('https://example.com', 1, 'b'.repeat(64), wrong).identity()
    ).rejects.toThrow('mismatch')
    expect(wrong).toHaveBeenCalledTimes(1)
  })
  it('retains earlier failure codes when a later blocker replaces a finding', () => {
    const f = fixture()
    f.agent.finding('review-failed', 'invoice-hash', 'first', 'block', { check: 'invoice-amount' })
    f.setTime(1010)
    f.agent.finding('review-failed', 'invoice-hash', 'second', 'unavailable', {
      check: 'chain-config'
    })
    const finding = f.agent.snapshot().findings[0]
    expect(finding.history).toEqual([{ at: 1000, check: 'invoice-amount', resolvedAt: undefined }])
    expect(finding.evidence.check).toBe('chain-config')
  })
})
