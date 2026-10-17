import { describe, expect, it, vi } from 'vitest'
import { createKaleidoBackend } from './kaleido'
import { validateInvoice } from '../security/rules'
import type { SecurityPolicy } from '../security/types'

const { decodeRgbInvoice, refreshTransfers, listTransfers } = vi.hoisted(() => ({
  decodeRgbInvoice: vi.fn(),
  refreshTransfers: vi.fn(),
  listTransfers: vi.fn()
}))
vi.mock('kaleido-sdk', () => ({
  KaleidoClient: { create: () => ({ rln: { decodeRgbInvoice, refreshTransfers, listTransfers } }) }
}))

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

describe('invoice decoding errors', () => {
  it.each([
    ['rgb:test/rpcù', 'at the end: “ù” (U+00F9)'],
    ['rgb:te\u200bst', 'at character 7: an invisible or whitespace character (U+200B)'],
    ['rgb:te st', 'at character 7: an invisible or whitespace character (U+0020)'],
    ['rgb:test\n', 'at the end: an invisible or whitespace character (U+000A)']
  ])('identifies unexpected characters in rejected invoices', async (invoice, explanation) => {
    decodeRgbInvoice.mockRejectedValueOnce(new Error('Invalid invoice: invalid invoice.'))
    await expect(createKaleidoBackend().decodeInvoice(invoice)).rejects.toThrow(explanation)
    expect(decodeRgbInvoice).toHaveBeenLastCalledWith({ invoice })
  })

  it('gives recovery instructions for malformed ASCII invoices', async () => {
    decodeRgbInvoice.mockRejectedValueOnce(new Error('Invalid invoice: invalid invoice.'))
    await expect(createKaleidoBackend().decodeInvoice('rgb:broken')).rejects.toThrow(
      'Copy the full RGB invoice again'
    )
  })

  it('preserves node errors instead of blaming the invoice', async () => {
    const error = new Error('Node is locked')
    decodeRgbInvoice.mockRejectedValueOnce(error)
    await expect(createKaleidoBackend().decodeInvoice('rgb:testù')).rejects.toBe(error)
  })

  it('also explains rejection during send without proceeding to submission', async () => {
    decodeRgbInvoice.mockRejectedValueOnce(new Error('Invalid invoice: invalid invoice.'))
    await expect(createKaleidoBackend().send('rgb:testù', 1000000)).rejects.toThrow(
      'at the end: “ù” (U+00F9)'
    )
  })
})

describe('decoded invoice amount validation', () => {
  it.each([{ type: 'Any' }, { type: 'Fungible', value: 0 }])(
    'allows positive payments for open amount %j',
    async (assignment) => {
      decodeRgbInvoice.mockResolvedValue({
        assignment,
        recipient_id: 'recipient',
        asset_id: 'asset',
        network: 'SignetCustom',
        expiration_timestamp: 2000,
        transport_endpoints: ['rpcs://proxy.example/rpc']
      })
      const invoice = await createKaleidoBackend().decodeInvoice('rgb:test')
      expect(invoice.amountRaw).toBeNull()
      for (const amount of [1, 20000000, 30000000]) {
        expect(validateInvoice(invoice, amount, policy, 1000)).toContain(
          'Open-amount invoice: verify the amount shown.'
        )
      }
      for (const amount of [0, -1, 0.5, NaN]) {
        expect(() => validateInvoice(invoice, amount, policy, 1000)).toThrow('Invalid raw amount.')
      }
    }
  )

  it('still requires the exact amount for a fixed invoice', async () => {
    decodeRgbInvoice.mockResolvedValue({
      assignment: { type: 'Fungible', value: 10000000 },
      recipient_id: 'recipient',
      asset_id: 'asset',
      network: 'SignetCustom',
      expiration_timestamp: 2000,
      transport_endpoints: ['rpcs://proxy.example/rpc']
    })
    const invoice = await createKaleidoBackend().decodeInvoice('rgb:test')
    expect(invoice.amountRaw).toBe(10000000)
    expect(() => validateInvoice(invoice, 10000000, policy, 1000)).not.toThrow()
    expect(() => validateInvoice(invoice, 20000000, policy, 1000)).toThrow(
      'Amount does not match the fixed invoice amount.'
    )
  })
})

it('shares concurrent refreshes and matches sends by requested amount, not change', async () => {
  let finish!: () => void
  refreshTransfers.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  listTransfers.mockResolvedValue({
    transfers: [
      {
        kind: 'Send',
        recipient_id: 'r',
        assignments: [{ type: 'Fungible', value: 90000000 }],
        requested_assignment: { type: 'Fungible', value: 10000000 },
        status: 'Settled',
        txid: 'tx'
      }
    ]
  })
  const backend = createKaleidoBackend()
  const first = backend.outgoingTransfers()
  const second = backend.outgoingTransfers()
  expect(refreshTransfers).toHaveBeenCalledTimes(1)
  finish()
  expect((await first)[0].amountRaw).toBe(10000000)
  expect(await second).toEqual(await first)
})
