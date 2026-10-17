import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_V1, SCHEMA_V2 } from './schema'
import { SECURITY_SCHEMA } from '../security/store'
import type { InvoiceRow, PaymentRow } from './repo'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
  vi.unstubAllEnvs()
})

const invoice: InvoiceRow = {
  id: 'invoice',
  client: 'Existing client',
  amountRaw: 100,
  receivedRaw: 50,
  rgbInvoice: 'rgb:existing',
  recipientId: 'recipient',
  expiresAt: 200,
  state: 'Pending',
  createdAt: 10
}
const payment: Omit<PaymentRow, 'blockTime'> = {
  nodeIdx: 1,
  direction: 'in',
  invoiceId: invoice.id,
  recipientId: invoice.recipientId,
  requestedRaw: 100,
  receivedRaw: 50,
  status: 'confirming',
  txid: 'tx',
  receiveUtxo: null,
  updatedAt: 20
}

// A file fixture permits a real close/reopen migration without touching application data.
async function fixture(legacy = false): Promise<typeof import('./index')> {
  vi.resetModules()
  const dir = mkdtempSync(join(tmpdir(), 'kasa-source-'))
  const file = join(dir, 'ledger.db')
  vi.stubEnv('KASA_DB', file)
  vi.stubEnv('RGB_BACKEND', 'kaleido')
  vi.stubEnv('RGB_NETWORK', 'SignetCustom')
  vi.stubEnv('RLN_NODE_URL', 'https://user:secret@example.test/private?token=secret')
  if (legacy) {
    const old = new Database(file)
    old.exec(SCHEMA_V1 + SCHEMA_V2 + SECURITY_SCHEMA)
    old.exec("ALTER TABLE payments ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'")
    old
      .prepare(
        `INSERT INTO invoices VALUES (@id, @client, @amountRaw, @receivedRaw,
      @rgbInvoice, @recipientId, @expiresAt, @state, @createdAt)`
      )
      .run(invoice)
    old
      .prepare(
        `INSERT INTO payments VALUES (@nodeIdx, @invoiceId, @recipientId,
      @requestedRaw, @receivedRaw, @status, @txid, NULL, @receiveUtxo, @updatedAt, @direction)`
      )
      .run(payment)
    old.pragma('user_version = 4')
    old.close()
  }
  const db = await import('./index')
  cleanups.push(() => {
    if (db.getDb().open) db.getDb().close()
    rmSync(dir, { recursive: true, force: true })
  })
  return db
}

describe('saved ledger provenance', () => {
  it('migrates old records unchanged and does not assign current provenance during upsert', async () => {
    const db = await fixture(true)
    expect(db.getInvoice(invoice.id)).toEqual(invoice)
    expect(db.getPayment(1)).toEqual({ ...payment, blockTime: null })
    const source = db.getLedgerSource()
    db.migrate(db.getDb())
    expect(db.getLedgerSource()).toEqual(source)
    expect(db.upsertPayment({ ...payment, source, status: 'settled', updatedAt: 30 })).toBe(true)
    expect(db.getPayment(1)?.source).toBeUndefined()
    expect(db.getInvoice(invoice.id)?.source).toBeUndefined()
    expect(db.getPayment(1)?.receivedRaw).toBe(50)
  })

  it('retains the original source through status, amount and timing changes, idempotently', async () => {
    const db = await fixture()
    const source = db.getLedgerSource()
    db.insertInvoice({ ...invoice, source })
    expect(db.upsertPayment({ ...payment, source })).toBe(true)
    expect(db.upsertPayment({ ...payment, source })).toBe(false)
    const updated = {
      ...payment,
      source: { ...source, label: 'Renamed display label' },
      status: 'settled',
      receivedRaw: 75
    }
    expect(db.upsertPayment(updated)).toBe(true)
    expect(db.setBlockTime(1, 100)).toBe(true)
    expect(db.setBlockTime(1, 100)).toBe(false)
    expect(db.getPayment(1)).toMatchObject({ source, receivedRaw: 75, blockTime: 100 })
    expect(db.getInvoice(invoice.id)?.source).toEqual(source)
    expect(db.upsertPayment(updated)).toBe(false)
    expect(db.upsertPayment({ ...updated, status: 'confirming' })).toBe(true)
    expect(db.getPayment(1)?.blockTime).toBeNull()
  })

  it('rejects a transfer index collision from another known stream without modifying the saved payment', async () => {
    const db = await fixture()
    const source = db.getLedgerSource()
    db.insertInvoice({ ...invoice, source })
    db.upsertPayment({ ...payment, source })
    expect(() =>
      db.upsertPayment({
        ...payment,
        source: { ...source, id: 'another-stream' },
        receivedRaw: 999
      })
    ).toThrow('another saved app ledger stream')
    expect(db.getPayment(1)).toEqual({ ...payment, source, blockTime: null })
  })

  it('persists a stable identity across restart and separates configuration changes without leaking endpoints', async () => {
    const db = await fixture()
    const first = db.getLedgerSource()
    expect(first.asset.environment).toBe('test')
    expect(JSON.stringify(first)).not.toMatch(/secret|example\.test|private/)
    const { rgbConfig } = await import('../rgb/config')
    rgbConfig.assetId = 'rgb:another'
    expect(db.getLedgerSource().id).not.toBe(first.id)
    rgbConfig.network = 'Mainnet'
    expect(db.getLedgerSource().asset.environment).toBe('live')
    rgbConfig.network = 'Unrecognised'
    expect(db.getLedgerSource().asset.environment).toBe('unknown')
    db.getDb().close()
    vi.resetModules()
    const reopened = await import('./index')
    expect(reopened.getLedgerSource()).toEqual(first)
    reopened.getDb().close()
  })

  it('treats malformed saved metadata as unknown and keeps records available', async () => {
    const db = await fixture()
    db.insertInvoice(invoice)
    db.getDb().prepare('UPDATE invoices SET source_json = ?').run('{broken')
    expect(db.getInvoice(invoice.id)).toEqual(invoice)
    db.getDb()
      .prepare('UPDATE invoices SET source_json = ?')
      .run(JSON.stringify({ id: 'incomplete' }))
    expect(db.listInvoices()).toEqual([invoice])
  })

  it('distinguishes nodes by endpoint path without exposing URLs or depending on access tokens', async () => {
    const db = await fixture()
    const first = db.getLedgerSource()
    const { rgbConfig } = await import('../rgb/config')
    rgbConfig.nodeUrl = 'https://other:new-password@example.test/private?token=new-token#fragment'
    expect(db.getLedgerSource().id).toBe(first.id)
    rgbConfig.nodeUrl = 'https://other:new-password@example.test/another-node?token=new-token'
    const other = db.getLedgerSource()
    expect(other.id).not.toBe(first.id)
    expect(JSON.stringify(other)).not.toMatch(/example\.test|another-node|new-password|new-token/)
  })

  it('rejects enum-shaped arrays in saved provenance rather than treating them as valid sources', async () => {
    const db = await fixture()
    db.insertInvoice(invoice)
    const source = db.getLedgerSource()
    for (const invalid of [
      { ...source, backend: ['wdk'] },
      { ...source, asset: { ...source.asset, environment: ['live'] } }
    ]) {
      db.getDb().prepare('UPDATE invoices SET source_json = ?').run(JSON.stringify(invalid))
      expect(db.getInvoice(invoice.id)).toEqual(invoice)
    }
  })
})
