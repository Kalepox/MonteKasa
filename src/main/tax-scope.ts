import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { parse, join } from 'node:path'
import { changeTaxScope, validateTaxScope, type TaxScope } from '../shared/tax-scope'
import { bindLedgerSource, organiseTaxActivity } from '../shared/tax-activity'
import type { KasaSnapshot } from '../preload/index.d'
import type { TaxProfile } from '../shared/tax-profile'

export class TaxScopeStore {
  constructor(
    private readonly path: string,
    private readonly databaseId: string
  ) {}
  get(): TaxScope {
    return (
      this.storage().scope ?? {
        version: 1,
        databaseId: this.databaseId,
        taxpayers: [],
        accounts: [],
        assets: [],
        assignments: []
      }
    )
  }
  private read(path: string, databaseId?: string): TaxScope | undefined {
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const value = JSON.parse(content)
      if (typeof value?.databaseId !== 'string' || !value.databaseId.trim())
        throw new Error('Missing database identity.')
      return validateTaxScope(value, databaseId ?? value.databaseId)
    } catch {
      throw new Error(
        'Scope file is invalid or belongs to a different database. No assignments have been applied.'
      )
    }
  }
  private storage(): { path: string; scope?: TaxScope } {
    // Keep the original file for its original ledger. A different backend gets
    // its own file, never another ledger's ownership or tax assignments.
    const legacy = this.read(this.path)
    if (legacy?.databaseId === this.databaseId) return { path: this.path, scope: legacy }
    const { dir, name, ext } = parse(this.path)
    const hash = createHash('sha256').update(this.databaseId).digest('hex')
    const path = join(dir, `${name}-${hash}${ext || '.json'}`)
    const scope = this.read(path, this.databaseId)
    // Also retain an existing sidecar if the original file was removed.
    return legacy || scope ? { path, scope } : { path: this.path }
  }
  change(
    input: unknown,
    profile: TaxProfile | null,
    records: Set<string>,
    snapshot?: KasaSnapshot
  ): TaxScope {
    const binding = (input as { kind?: unknown } | null)?.kind === 'bind-source'
    if (binding && !snapshot) throw new Error('Saved ledger data is required to link a source.')
    const state = binding
      ? bindLedgerSource(this.get(), snapshot!, input, randomUUID())
      : changeTaxScope(this.get(), input, profile, records, randomUUID())
    this.save(state)
    return state
  }
  organise(snapshot: KasaSnapshot): TaxScope {
    const current = this.get()
    const next = organiseTaxActivity(current, snapshot)
    if (next !== current) this.save(next)
    return next
  }
  private save(state: TaxScope): void {
    const { path } = this.storage()
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}
