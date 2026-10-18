// RgbBackend on top of the WDK wallet service. Chain evidence comes from Esplora, as in kaleido.ts.
import { ChainObserver } from '../security/network'
import { requireCheck } from '../security/rules'
import type { DecodedInvoice } from '../security/types'
import { rgbConfig } from './config'
import { WalletService } from './wallet-service'
import type { RgbBackend, RgbTransfer, TransferStatus } from './types'

type Assignment = { Fungible?: number } | null | undefined
const amountOf = (a: Assignment): number => (a && typeof a.Fungible === 'number' ? a.Fungible : 0)

interface WdkTransfer {
  idx: number
  kind: string // 'ReceiveBlind' | 'ReceiveWitness' | 'Send' | 'Issuance'
  status: string // 'WaitingCounterparty' | 'WaitingConfirmations' | 'Settled' | 'Failed'
  requestedAssignment?: Assignment
  assignments: Assignment[]
  txid?: string | null
  recipientId?: string | null
  receiveUtxo?: { txid: string; vout: number } | null
  updatedAt: number
}

function mapStatus(s: string): TransferStatus {
  if (s === 'Settled') return 'settled'
  if (s === 'Failed') return 'failed'
  if (s === 'WaitingCounterparty') return 'waiting'
  return 'confirming'
}
const incoming = (t: WdkTransfer): boolean => t.kind === 'ReceiveBlind' || t.kind === 'ReceiveWitness'

export function createWdkBackend(): RgbBackend & { wallet: WalletService } {
  const wallet = new WalletService()
  const assetId = rgbConfig.assetId
  const reference = new ChainObserver(rgbConfig.explorerApi, rgbConfig.checkpointHeight, rgbConfig.checkpointHash)
  const walletChain = new ChainObserver(rgbConfig.nodeChainApi, rgbConfig.checkpointHeight, rgbConfig.checkpointHash)

  // The checkpoint can't change while the app runs: verify the chain identity once per session
  // (retried if it failed). The fee estimate is the slowest chain call: reuse it for a minute.
  let identityOnce: Promise<void> | undefined
  const verifiedIdentity = (): Promise<void> =>
    (identityOnce ??= Promise.all([reference.identity(), walletChain.identity()]).then(
      () => undefined,
      (e) => {
        identityOnce = undefined
        throw e
      }
    ))
  let fee: { value: number | undefined; at: number } | undefined
  const feeEstimate = async (): Promise<number | undefined> => {
    if (fee && Date.now() - fee.at < 60_000) return fee.value
    const value = await reference.recommendedFee()
    fee = { value, at: Date.now() }
    return value
  }

  const transfers = async (): Promise<WdkTransfer[]> =>
    (await wallet.call<WdkTransfer[]>('listTransfers', { assetId })).filter((t) => t.recipientId)

  async function decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const d = await wallet.call<{
      recipientId: string
      assetId: string | null
      assignment: Record<string, unknown>
      network: string
      expirationTimestamp: number | null
      transportEndpoints: string[]
    }>('decodeInvoice', { invoice })
    requireCheck('Fungible' in d.assignment || 'Any' in d.assignment, 'assignment',
      'Only fungible or open-amount invoices are supported.')
    const fungible = Number(d.assignment.Fungible ?? 0)
    return {
      recipientId: d.recipientId,
      assetId: d.assetId ?? null,
      network: d.network,
      amountRaw: fungible > 0 ? fungible : null,
      expiresAt: d.expirationTimestamp ?? null,
      endpoints: d.transportEndpoints
    }
  }

  return {
    wallet,

    async status() {
      try {
        const { state } = await wallet.call<{ state: string }>('state')
        if (state !== 'unlocked') return { state: 'locked', mock: false } // 'none' = no wallet yet (onboarding)
        const s = await wallet.call<{
          synced: boolean
          address: string | null
          btc: { vanilla: { spendable: number } }
          asset: { spendable: number; future?: number }
        }>('status', { assetId })
        // unlocked, but the first background sync after unlock hasn't finished yet
        if (!s.synced) return { state: 'syncing', mock: false }
        return { state: 'online', mock: false, pubkey: s.address ?? undefined,
          balanceRaw: Number(s.asset.spendable ?? 0), btcSats: s.btc.vanilla.spendable,
          futureRaw: Number(s.asset.future ?? s.asset.spendable ?? 0) }
      } catch {
        return { state: 'offline', mock: false }
      }
    },

    async createInvoice(amountRaw) {
      const r = await wallet.call<{ invoice: string; recipientId: string; expirationTimestamp: number }>(
        'createInvoice', { assetId, amountRaw })
      return { recipientId: r.recipientId, invoice: r.invoice, expiresAt: r.expirationTimestamp }
    },

    async listTransfers() {
      return (await transfers())
        .filter((t) => incoming(t) || t.kind === 'Send')
        .map((t): RgbTransfer => {
          const isIn = incoming(t)
          const requested = amountOf(t.requestedAssignment)
          return {
            idx: t.idx,
            direction: isIn ? 'in' : 'out',
            recipientId: t.recipientId!,
            requestedRaw: requested > 0 ? requested : null,
            // for a Send, assignments is our change; the amount sent is the requested one
            receivedRaw: isIn ? t.assignments.reduce((s, a) => s + amountOf(a), 0) : requested,
            status: mapStatus(t.status),
            txid: t.txid ?? undefined,
            receiveUtxo: isIn && t.receiveUtxo ? `${t.receiveUtxo.txid}:${t.receiveUtxo.vout}` : undefined,
            updatedAt: t.updatedAt
          }
        })
    },

    async send(invoice, amountRaw) {
      const d = await decodeInvoice(invoice)
      if (d.assetId && d.assetId !== assetId) throw new Error(`Invoice is for another asset (${d.assetId})`)
      if (d.network !== rgbConfig.network) throw new Error(`Invoice is for another network (${d.network})`)
      return wallet.call<{ txid: string }>('send', { invoice, assetId, amountRaw, feeRate: rgbConfig.feeRate })
    },

    decodeInvoice,

    async networkEvidence() {
      await verifiedIdentity()
      const [refHeight, walletHeight, st, feeRate] = await Promise.all([
        reference.height(true), walletChain.height(true),
        wallet.call<{ synced: boolean; btc: { vanilla: { spendable: number } }; asset: { spendable: number } }>(
          'status', { assetId }),
        feeEstimate()
      ])
      // payment checks need real balances, not the placeholders before the first sync
      requireCheck(st.synced, 'wallet-sync', 'Wallet is still syncing; try again in a few seconds.', 'unavailable')
      const shared = Math.min(refHeight, walletHeight)
      const [left, right] = await Promise.all([reference.blockHash(shared), walletChain.blockHash(shared)])
      return {
        network: rgbConfig.network,
        height: walletHeight,
        referenceHeight: refHeight,
        identityVerified: /^[a-f0-9]{64}$/.test(left) && left === right,
        online: true,
        balanceRaw: Number(st.asset.spendable ?? 0),
        btcSats: st.btc.vanilla.spendable,
        checkedAt: Math.floor(Date.now() / 1000),
        source: rgbConfig.explorerApi,
        recommendedFeeRate: feeRate
      }
    },

    async outgoingTransfers() {
      return (await transfers())
        .filter((t) => t.kind === 'Send')
        .map((t) => ({ recipientId: t.recipientId!, amountRaw: amountOf(t.requestedAssignment),
          txid: t.txid ?? undefined, status: t.status }))
    },

    chainEvidence: (txid) => reference.transaction(txid)
  }
}
