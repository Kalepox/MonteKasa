import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { migrate } from '../db'
import { SCHEMA_V1, SCHEMA_V2 } from '../db/schema'
import { SECURITY_SCHEMA, SqliteSecurityStore } from './store'
import type { StoredOperation } from './types'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function operation(): StoredOperation {
  return {
    id: 'one',
    intentKey: 'intent',
    invoice: 'rgb:test',
    recipientId: 'r',
    assetId: 'a',
    network: 'n',
    amountRaw: 1,
    feeRate: 2,
    state: 'review',
    createdAt: 1,
    updatedAt: 1,
    approvalExpiresAt: 120,
    confirmations: 0,
    rgbStatus: 'none',
    history: [],
    tokenHash: 'hash',
    detailsHash: 'details'
  }
}
describe('SQLite persistence', () => {
  it('migrates an existing V2 database without losing invoices or proposals', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1 + SCHEMA_V2)
    db.pragma('user_version = 2')
    db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'inv',
      'Client',
      100,
      120,
      'rgb:test',
      'recipient',
      1000,
      'Overpaid',
      1
    )
    db.prepare('INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'proposal',
      'inv',
      'refund',
      20,
      'excess',
      'open',
      null,
      null,
      null,
      1
    )
    migrate(db)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(db.prepare('SELECT count(*) AS n FROM invoices').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT amount_raw FROM proposals').get()).toEqual({ amount_raw: 20 })
    db.close()
  })
  it.each([
    ['payments.direction', "ALTER TABLE payments ADD COLUMN direction TEXT NOT NULL DEFAULT 'in';"],
    ['security tables', SECURITY_SCHEMA]
  ])('upgrades a v3 database that only has %s', (_, v3) => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1 + SCHEMA_V2 + v3)
    db.pragma('user_version = 3')
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(new SqliteSecurityStore(db).operations()).toEqual([])
    const cols = db.pragma('table_info(payments)') as { name: string }[]
    expect(cols.some((c) => c.name === 'direction')).toBe(true)
    db.close()
  })
  it('persists operations across reopen, enforces unique intent and claims once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kasa-ledger-'))
    dirs.push(dir)
    const path = join(dir, 'ledger.db')
    const db = new Database(path)
    migrate(db)
    const first = new SqliteSecurityStore(db)
    first.save(operation())
    expect(first.claim('one')).toBe(true)
    expect(first.claim('one')).toBe(false)
    expect(() => first.save({ ...operation(), id: 'two' })).toThrow()
    first.saveFinding({
      id: 'finding',
      rule: 'test',
      version: 1,
      subject: 'one',
      severity: 'review',
      message: 'test',
      evidence: {},
      firstSeen: 1,
      lastSeen: 1
    })
    db.close()
    const reopened = new Database(path)
    const next = new SqliteSecurityStore(reopened)
    expect(next.get('one')?.state).toBe('submitting')
    expect(next.findings()).toHaveLength(1)
    reopened.close()
  })
})
