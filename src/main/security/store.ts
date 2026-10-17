import type Database from 'better-sqlite3'
import type { SecurityFinding } from '../../shared/security'
import type { SecurityStore, StoredOperation } from './types'

export const SECURITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS security_operations (
 id TEXT PRIMARY KEY, intent_key TEXT NOT NULL UNIQUE, proposal_id TEXT UNIQUE,
 state TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_findings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS security_operation_state ON security_operations(state);
`
export class SqliteSecurityStore implements SecurityStore {
  constructor(private db: Database.Database) {}
  operations(limit = -1): StoredOperation[] {
    return (
      this.db
        .prepare('SELECT data FROM security_operations ORDER BY rowid DESC LIMIT ?')
        .all(limit) as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data))
  }
  matching(intentKey: string, proposalId?: string): StoredOperation[] {
    return (
      this.db
        .prepare('SELECT data FROM security_operations WHERE intent_key = ? OR proposal_id = ?')
        .all(intentKey, proposalId ?? null) as { data: string }[]
    ).map((r) => JSON.parse(r.data))
  }
  pending(now: number): StoredOperation[] {
    return (
      this.db
        .prepare(
          `SELECT data FROM security_operations WHERE state IN ('submitting', 'submitted', 'confirming', 'uncertain')
      OR (state = 'completed' AND COALESCE(json_extract(data, '$.completedAt'), json_extract(data, '$.updatedAt')) > ?)
      ORDER BY COALESCE(json_extract(data, '$.checkedAt'), 0) ASC LIMIT 5`
        )
        .all(now - 86400) as { data: string }[]
    ).map((r) => JSON.parse(r.data))
  }
  getFinding(id: string): SecurityFinding | undefined {
    const row = this.db.prepare('SELECT data FROM security_findings WHERE id = ?').get(id) as
      { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  get(id: string): StoredOperation | undefined {
    const row = this.db.prepare('SELECT data FROM security_operations WHERE id = ?').get(id) as
      { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  save(o: StoredOperation): void {
    this.db
      .prepare(
        `INSERT INTO security_operations (id, intent_key, proposal_id, state, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET intent_key=excluded.intent_key, proposal_id=excluded.proposal_id, state=excluded.state, data=excluded.data`
      )
      .run(o.id, o.intentKey, o.proposalId ?? null, o.state, JSON.stringify(o))
  }
  claim(id: string): boolean {
    return this.db.transaction(() => {
      const operation = this.get(id)
      if (!operation || operation.state !== 'review') return false
      operation.state = 'submitting'
      this.save(operation)
      return true
    })()
  }
  findings(limit = -1): SecurityFinding[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM security_findings ORDER BY json_extract(data, '$.resolvedAt') IS NOT NULL ASC, json_extract(data, '$.lastSeen') DESC LIMIT ?"
        )
        .all(limit) as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data))
  }
  saveFinding(f: SecurityFinding): void {
    this.db
      .prepare(
        'INSERT INTO security_findings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(f.id, JSON.stringify(f))
  }
}
