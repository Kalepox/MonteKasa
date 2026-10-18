import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { rgbConfig } from '../rgb'
import { SCHEMA_V1, SCHEMA_V2 } from './schema'
import { SECURITY_SCHEMA } from '../security/store'
import type { LedgerSource } from '../../shared/ledger-source'

let db: Database.Database | undefined

export function getDb(): Database.Database {
  if (db) return db
  // separate file in mock mode, so fake payments never mix with real ones
  // one database per backend: transfer numbers (node_idx) of different wallets would collide
  const name = rgbConfig.mock
    ? 'kasa-mock.db'
    : rgbConfig.backend === 'wdk'
      ? 'kasa-wdk.db'
      : 'kasa.db'
  const file = process.env.KASA_DB ?? join(app.getPath('userData'), name)
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  console.log('[db] opened', file)
  return db
}

// user_version is SQLite's built-in schema version number
export function migrate(d: Database.Database): void {
  const version = d.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    d.exec(SCHEMA_V1)
    d.pragma('user_version = 1')
  }
  if (version < 2) {
    d.exec(SCHEMA_V2)
    d.pragma('user_version = 2')
  }
  // two branches both shipped a v3 (payments.direction vs security tables), so a v3 db
  // may have either one; v4 idempotently applies both
  if (version < 4)
    d.transaction(() => {
      addColumnIfMissing(d, 'payments', 'direction', "TEXT NOT NULL DEFAULT 'in'")
      d.exec(SECURITY_SCHEMA)
      d.pragma('user_version = 4')
    })()
  if (version < 5)
    d.transaction(() => {
      // Leave old rows NULL: today's configuration cannot identify historic activity.
      addColumnIfMissing(d, 'invoices', 'source_json', 'TEXT')
      addColumnIfMissing(d, 'payments', 'source_json', 'TEXT')
      d.exec(
        'CREATE TABLE IF NOT EXISTS ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
      )
      d.prepare('INSERT OR IGNORE INTO ledger_metadata (key, value) VALUES (?, ?)').run(
        'identity',
        randomUUID()
      )
      d.pragma('user_version = 5')
    })()
}

export function getLedgerSource(): LedgerSource {
  const { value: databaseId } = getDb()
    .prepare("SELECT value FROM ledger_metadata WHERE key = 'identity'")
    .get() as { value: string }
  let endpoint = ''
  if (rgbConfig.backend === 'kaleido') {
    try {
      // A shared host can route different nodes by path. Hash that distinction,
      // while excluding credentials/query tokens and never exposing the URL.
      const url = new URL(rgbConfig.nodeUrl)
      endpoint = `${url.origin}${url.pathname}`
    } catch {
      /* An invalid endpoint is not an identity we can use. */
    }
  }
  const { backend, assetId, network, precision } = rgbConfig
  const id =
    'ledger-' +
    createHash('sha256')
      .update(JSON.stringify([databaseId, backend, assetId, network, precision, endpoint]))
      .digest('hex')
  const normalized = network.toLowerCase()
  const environment =
    backend === 'mock' || /signet|testnet|regtest|mutinynet/.test(normalized)
      ? 'test'
      : ['bitcoin', 'mainnet'].includes(normalized)
        ? 'live'
        : 'unknown'
  const label = backend === 'wdk' ? 'WDK' : backend === 'mock' ? 'Demo' : 'Kaleido'
  return {
    id,
    label: `${label} app ledger · ${network}`,
    backend,
    asset: { symbol: 'USDT', canonicalId: assetId, network, decimals: precision, environment }
  }
}

function addColumnIfMissing(
  d: Database.Database,
  table: string,
  column: string,
  def: string
): void {
  const cols = d.pragma(`table_info(${table})`) as { name: string }[]
  if (!cols.some((c) => c.name === column))
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

export * from './repo'
