import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { rgbConfig } from '../rgb'
import { SCHEMA_V1, SCHEMA_V2 } from './schema'
import { SECURITY_SCHEMA } from '../security/store'

let db: Database.Database | undefined

export function getDb(): Database.Database {
  if (db) return db
  // separate file in mock mode, so fake payments never mix with real ones
  const name = rgbConfig.mock ? 'kasa-mock.db' : 'kasa.db'
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
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, def: string): void {
  const cols = d.pragma(`table_info(${table})`) as { name: string }[]
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}


export * from './repo'
