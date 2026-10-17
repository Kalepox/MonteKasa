import type { ChainEvidence } from './types'
import { requireCheck } from './rules'
export async function bounded<T>(work: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Node request timed out; its result may be unknown.')),
          milliseconds
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export class ChainObserver {
  private tip?: { height: number; at: number }
  constructor(
    private base: string,
    private checkpointHeight: number,
    private checkpointHash: string,
    private request: typeof fetch = fetch
  ) {}
  async read(path: string): Promise<Response> {
    const url = new URL(this.base)
    requireCheck(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
      'chain-url',
      'Chain API must use HTTPS or loopback HTTP.',
      'unavailable'
    )
    const response = await this.request(`${this.base.replace(/\/$/, '')}${path}`, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    })
    requireCheck(
      response.ok,
      'chain-api',
      `Chain API returned ${response.status}; verification unavailable.`,
      'unavailable'
    )
    return response
  }
  async identity(): Promise<void> {
    requireCheck(
      Number.isSafeInteger(this.checkpointHeight) &&
        this.checkpointHeight > 0 &&
        /^[a-f0-9]{64}$/.test(this.checkpointHash),
      'chain-config',
      'Configure a trusted non-genesis RGB_CHAIN_CHECKPOINT_HEIGHT and RGB_CHAIN_CHECKPOINT_HASH.',
      'unavailable'
    )
    const hash = (await (await this.read(`/block-height/${this.checkpointHeight}`)).text()).trim()
    requireCheck(
      hash === this.checkpointHash,
      'chain-checkpoint',
      'Chain checkpoint mismatch.',
      'unavailable'
    )
  }
  async height(fresh = false): Promise<number> {
    if (!fresh && this.tip && Date.now() - this.tip.at < 10000) return this.tip.height
    const text = (await (await this.read('/blocks/tip/height')).text()).trim()
    const height = Number(text)
    requireCheck(
      /^\d+$/.test(text) && Number.isSafeInteger(height),
      'chain-height',
      'Invalid chain height.',
      'unavailable'
    )
    this.tip = { height, at: Date.now() }
    return height
  }
  async blockHash(height: number): Promise<string> {
    return (await (await this.read(`/block-height/${height}`)).text()).trim()
  }
  async transaction(txid: string): Promise<ChainEvidence> {
    requireCheck(
      /^[a-f0-9]{64}$/.test(txid),
      'txid',
      'Invalid Bitcoin transaction ID.',
      'unavailable'
    )
    await this.identity()
    const status = (await (await this.read(`/tx/${txid}/status`)).json()) as {
      confirmed?: boolean
      block_height?: number
      block_hash?: string
    }
    requireCheck(
      typeof status.confirmed === 'boolean',
      'chain-response',
      'Invalid transaction status.',
      'unavailable'
    )
    if (!status.confirmed)
      return {
        confirmed: false,
        confirmations: 0,
        inBestChain: false,
        checkedAt: Math.floor(Date.now() / 1000)
      }
    requireCheck(
      Number.isSafeInteger(status.block_height) &&
        status.block_height! >= 0 &&
        /^[a-f0-9]{64}$/.test(status.block_hash ?? ''),
      'chain-response',
      'Invalid block inclusion evidence.',
      'unavailable'
    )
    const block = (await (await this.read(`/block/${status.block_hash}/status`)).json()) as {
      in_best_chain?: boolean
    }
    requireCheck(
      typeof block.in_best_chain === 'boolean',
      'chain-response',
      'Invalid best-chain evidence.',
      'unavailable'
    )
    const height = await this.height()
    requireCheck(
      height >= status.block_height!,
      'chain-height',
      'Chain tip is behind the inclusion block.',
      'unavailable'
    )
    return {
      confirmed: true,
      inBestChain: block.in_best_chain,
      confirmations: block.in_best_chain ? height - status.block_height! + 1 : 0,
      checkedAt: Math.floor(Date.now() / 1000)
    }
  }
  async recommendedFee(): Promise<number | undefined> {
    try {
      const estimates = (await (await this.read('/fee-estimates')).json()) as Record<string, number>
      const fee = estimates['6']
      return Number.isFinite(fee) && fee > 0 ? fee : undefined
    } catch {
      return undefined
    }
  }
}
