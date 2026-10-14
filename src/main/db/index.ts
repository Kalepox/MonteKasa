import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { rgbConfig } from '../rgb'
import { SCHEMA_V1, SCHEMA_V2 } from './schema'

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
function migrate(d: Database.Database): void {
  const version = d.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    d.exec(SCHEMA_V1)
    d.pragma('user_version = 1')
  }
  if (version <2){
    d.exec(SCHEMA_V2)
    d.pragma('user_version = 2')
  }
}

export * from './repo'
