import { KaleidoClient } from 'kaleido-sdk'
import { AssetFilterIdType, TransferKind, TransferStatus as RlnStatus } from 'kaleido-sdk/rln'
import type { AssignmentAny, AssignmentFungible , Transfer} from 'kaleido-sdk/rln'
import { rgbConfig } from './config'
import type { IncomingTransfer, NodeState, RgbBackend, TransferStatus } from './types'
type Assignment = Transfer['assignments'][number]

const fungible = (value: number) => ({ type: 'Fungible', value }) as AssignmentFungible
const anyAmount = () => ({ type: 'Any' }) as AssignmentAny

const sum = (as: Assignment[]) => as.reduce((s, a) => s + ('value' in a ? a.value : 0), 0)

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

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e)
const unknownAsset = (e: unknown) => errText(e).includes('Unknown RGB contract')

function stateFromError(e: unknown): NodeState {
  const msg = errText(e).toLowerCase()
  if (msg.includes('changing state')) return 'syncing'
  if (msg.includes('locked')) return 'locked'
  return 'offline'
}

export function createKaleidoBackend(): RgbBackend {
  const rln = KaleidoClient.create({ nodeUrl: rgbConfig.nodeUrl }).rln
  const assetId = rgbConfig.assetId

  return {
    async status() {
      try {
        const info = await rln.getNodeInfo()
        let balanceRaw = 0
        try {
          balanceRaw = (await rln.getAssetBalance({ asset_id: assetId })).spendable
        } catch (e) {
          if (!unknownAsset(e)) throw e // never received USDT yet → balance 0
        }
        return { state: 'online', mock: false, pubkey: info.pubkey, balanceRaw }
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
      return { recipientId: res.recipient_id, invoice: res.invoice, expiresAt: res.expiration_timestamp }
    },

    async listIncoming() {
      await rln.refreshTransfers({ filter: [], skip_sync: false })
      let transfers
      try {
        ;({ transfers } = await rln.listTransfers({
          asset_filter: { type: AssetFilterIdType.Id, value: assetId }
        }))
      } catch (e) {
        if (unknownAsset(e)) return []
        throw e
      }
      return transfers
        .filter((t) => t.kind === TransferKind.ReceiveBlind || t.kind === TransferKind.ReceiveWitness)
        .filter((t) => t.recipient_id)
        .map(
          (t): IncomingTransfer => ({
            idx: t.idx,
            recipientId: t.recipient_id!,
            requestedRaw: requested(t.requested_assignment),
            receivedRaw: sum(t.assignments),
            status: mapStatus(t.status),
            txid: t.txid ?? undefined,
            receiveUtxo: t.receive_utxo ?? undefined,
            updatedAt: t.updated_at
          })
        )
    },

    // decode first: /sendrgb wants the recipient id + endpoints, not the whole invoice
    async send(recipientInvoice, amountRaw) {
      const d = await rln.decodeRgbInvoice({ invoice: recipientInvoice })
      return rln.sendRgb({
        donation: false,
        fee_rate: rgbConfig.feeRate,
        min_confirmations: 1,
        expiration_timestamp: Math.floor(Date.now() / 1000) + 86400,
        recipient_map: {
          [assetId]: [
            { recipient_id: d.recipient_id, assignment: fungible(amountRaw), transport_endpoints: d.transport_endpoints }
          ]
        }
      })
    }
  }
}
