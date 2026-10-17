import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { changeTaxScope, validateTaxScope, type TaxScope } from '../shared/tax-scope'
import type { TaxProfile } from '../shared/tax-profile'

export class TaxScopeStore {
  constructor(
    private readonly path: string,
    private readonly databaseId: string
  ) {}
  get(): TaxScope {
    let content: string
    try {
      content = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          version: 1,
          databaseId: this.databaseId,
          taxpayers: [],
          accounts: [],
          assets: [],
          assignments: []
        }
      throw error
    }
    try {
      return validateTaxScope(JSON.parse(content), this.databaseId)
    } catch {
      throw new Error(
        'Scope file is invalid or belongs to a different database. No assignments have been applied.'
      )
    }
  }
  change(input: unknown, profile: TaxProfile | null, records: Set<string>): TaxScope {
    const state = changeTaxScope(this.get(), input, profile, records, randomUUID())
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    return state
  }
}
