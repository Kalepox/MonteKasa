import { ChainObserver, bounded } from '../security/network'
import { requireCheck } from '../security/rules'
import { KaleidoClient } from 'kaleido-sdk'
import { AssetFilterIdType, TransferKind, TransferStatus as RlnStatus } from 'kaleido-sdk/rln'
import type { AssignmentAny, AssignmentFungible, Transfer } from 'kaleido-sdk/rln'
import { rgbConfig } from './config'
import type { RgbTransfer, NodeState, RgbBackend, TransferStatus } from './types'
type Assignment = Transfer['assignments'][number]

const fungible = (value: number): AssignmentFungible =>
  ({ type: 'Fungible', value }) as AssignmentFungible
const anyAmount = (): AssignmentAny => ({ type: 'Any' }) as AssignmentAny

const sum = (as: Assignment[]): number => as.reduce((s, a) => s + ('value' in a ? a.value : 0), 0)

// both {type:"Any"} and {type:"Fungible", value:0} mean "any amount"
function requested(a?: Assignment | null): number | null {
  if (!a || !('value' in a) || a.value === 0) return null
  return a.value
}

function mapStatus(s: RlnStatus): TransferStatus {
  if (s === RlnStatus.Settled) return 'settled'
  if (s === RlnStatus.Failed) return 'failed'
  if (s === RlnStatus.WaitingCounterparty) return 'waiting'
  return 'confirming'
}

const errText = (e: unknown): string => String((e as { message?: string })?.message ?? e)
const unknownAsset = (e: unknown): boolean => errText(e).includes('Unknown RGB contract')

function stateFromError(e: unknown): NodeState {
  const msg = errText(e).toLowerCase()
  if (msg.includes('changing state')) return 'syncing'
  if (msg.includes('locked')) return 'locked'
  return 'offline'
}

export function createKaleidoBackend(): RgbBackend {
  const rln = KaleidoClient.create({ nodeUrl: rgbConfig.nodeUrl }).rln
  const assetId = rgbConfig.assetId
  const reference = new ChainObserver(
    rgbConfig.explorerApi,
    rgbConfig.checkpointHeight,
    rgbConfig.checkpointHash
  )
  const nodeChain = new ChainObserver(
    rgbConfig.nodeChainApi,
    rgbConfig.checkpointHeight,
    rgbConfig.checkpointHash
  )

  return {
    async decodeInvoice(invoice) {
      const d = await bounded(rln.decodeRgbInvoice({ invoice }))
      requireCheck(
        d.assignment.type === 'Any' || d.assignment.type === 'Fungible',
        'assignment',
        'Only fungible or open-amount invoices are supported.'
      )
      return {
        recipientId: d.recipient_id,
        assetId: d.asset_id ?? null,
        network: d.network,
        amountRaw: d.assignment.type === 'Fungible' ? d.assignment.value : null,
        expiresAt: d.expiration_timestamp ?? null,
        endpoints: d.transport_endpoints
      }
    },
    async networkEvidence() {
      requireCheck(
        Boolean(rgbConfig.nodeChainApi),
        'chain-config',
        'Configure RGB_NODE_CHAIN_API for the Esplora chain source used by this RGB node.',
        'unavailable'
      )
      await Promise.all([reference.identity(), nodeChain.identity()])
      await bounded(rln.refreshTransfers({ filter: [], skip_sync: false }))
      const [network, refHeight, nodeHeight, balance, btc] = await Promise.all([
        bounded(rln.getNetworkInfo()),
        reference.height(true),
        nodeChain.height(true),
        bounded(rln.getAssetBalance({ asset_id: assetId })),
        bounded(rln.getBtcBalance(true))
      ])
      const sharedHeight = Math.min(network.height, refHeight, nodeHeight)
      const [left, right] = await Promise.all([
        reference.blockHash(sharedHeight),
        nodeChain.blockHash(sharedHeight)
      ])
      const identityVerified =
        /^[a-f0-9]{64}$/.test(left) && left === right && Math.abs(network.height - nodeHeight) <= 2
      return {
        network: network.network,
        height: network.height,
        referenceHeight: refHeight,
        identityVerified,
        online: true,
        balanceRaw: balance.spendable,
        btcSats: btc.vanilla.spendable,
        checkedAt: Math.floor(Date.now() / 1000),
        source: rgbConfig.explorerApi,
        recommendedFeeRate: await reference.recommendedFee()
      }
    },
    async outgoingTransfers() {
      await bounded(rln.refreshTransfers({ filter: [], skip_sync: false }))
      const { transfers } = await bounded(
        rln.listTransfers({ asset_filter: { type: AssetFilterIdType.Id, value: assetId } })
      )
      return transfers
        .filter((t) => t.kind === TransferKind.Send && t.recipient_id)
        .map((t) => ({
          recipientId: t.recipient_id!,
          amountRaw: sum(t.assignments),
          txid: t.txid ?? undefined,
          status: t.status
        }))
    },
    chainEvidence: (txid) => reference.transaction(txid),
    async status() {
      try {
        const info = await rln.getNodeInfo()
        const btc = await rln.getBtcBalance(true)
        let balanceRaw = 0
        try {
          balanceRaw = (await rln.getAssetBalance({ asset_id: assetId })).spendable
        } catch (e) {
          if (!unknownAsset(e)) throw e // never received USDT yet balance 0
        }
        return {
          state: 'online',
          mock: false,
          pubkey: info.pubkey,
          balanceRaw,
          btcSats: btc.vanilla.spendable
        }
      } catch (e) {
        return { state: stateFromError(e), mock: false }
      }
    },

    async createInvoice(amountRaw, expiresAt) {
      const base = {
        min_confirmations: 1,
        witness: false,
        expiration_timestamp: expiresAt,
        transport_endpoints: [rgbConfig.proxy]
      }
      let res
      try {
        res = await rln.createRgbInvoice({
          ...base,
          asset_id: assetId,
          assignment: amountRaw === null ? anyAmount() : fungible(amountRaw)
        })
      } catch (e) {
        if (!unknownAsset(e)) throw e
        // first USDT ever: the node can't name the asset yet, so ask for "any asset"
        res = await rln.createRgbInvoice({ ...base, asset_id: null, assignment: anyAmount() })
      }
      return {
        recipientId: res.recipient_id,
        invoice: res.invoice,
        expiresAt: res.expiration_timestamp
      }
    },
    async listTransfers() {
      await bounded(rln.refreshTransfers({ filter: [], skip_sync: false }))


      let transfers
      try {
        ;({ transfers } = await bounded(
          rln.listTransfers({
            asset_filter: { type: AssetFilterIdType.Id, value: assetId }
          })
        ))
      } catch (e) {
        if (unknownAsset(e)) return []
        throw e
      }
      const incoming = (t: Transfer): boolean =>
        t.kind === TransferKind.ReceiveBlind || t.kind === TransferKind.ReceiveWitness
      return transfers
        .filter((t) => incoming(t) || t.kind === TransferKind.Send)
        .filter((t) => t.recipient_id)
        .map((t): RgbTransfer => {
          const isIn = incoming(t)
          return {
            idx: t.idx,
            direction: isIn ? 'in' : 'out',
            recipientId: t.recipient_id!,
            requestedRaw: requested(t.requested_assignment),
            // for a Send, `assignments` is our change coming back; the amount sent is the requested one
            receivedRaw: isIn ? sum(t.assignments) : (requested(t.requested_assignment) ?? 0),
            status: mapStatus(t.status),
            txid: t.txid ?? undefined,
            receiveUtxo: isIn ? (t.receive_utxo ?? undefined) : undefined,
            updatedAt: t.updated_at
          }
        })
    },

    // decode first: /sendrgb wants the recipient id + endpoints, not the whole invoice
    async send(recipientInvoice, amountRaw) {
      const d = await bounded(rln.decodeRgbInvoice({ invoice: recipientInvoice }))

      if (d.asset_id && d.asset_id !== assetId)
        throw new Error(`Invoice is for another asset (${d.asset_id})`)
      if (d.network !== rgbConfig.network)
        throw new Error(`Invoice is for another network (${d.network})`)

      return bounded(
        rln.sendRgb({
          donation: false,
          fee_rate: rgbConfig.feeRate,
          min_confirmations: 1,
          expiration_timestamp: Math.floor(Date.now() / 1000) + 86400,
          recipient_map: {
            [assetId]: [
              {
                recipient_id: d.recipient_id,
                assignment: fungible(amountRaw),
                transport_endpoints: d.transport_endpoints
              }
            ]
          }
        })
      )
    }
  }
}
