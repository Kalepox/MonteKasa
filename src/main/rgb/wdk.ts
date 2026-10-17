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
          address: string
          btc: { vanilla: { spendable: number } }
          asset: { spendable: number }
        }>('status', { assetId })
        return { state: 'online', mock: false, pubkey: s.address,
          balanceRaw: Number(s.asset.spendable ?? 0), btcSats: s.btc.vanilla.spendable }
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
      await Promise.all([reference.identity(), walletChain.identity()])
      const [refHeight, walletHeight, st] = await Promise.all([
        reference.height(true), walletChain.height(true),
        wallet.call<{ btc: { vanilla: { spendable: number } }; asset: { spendable: number } }>('status', { assetId })
      ])
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
        recommendedFeeRate: await reference.recommendedFee()
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
