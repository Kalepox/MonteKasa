import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { validateTaxProfile, type TaxProfile } from '../shared/tax-profile'

export class TaxProfileStore {
  constructor(private readonly path: string) {}

  get(): TaxProfile | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      return validateTaxProfile(JSON.parse(text))
    } catch {
      throw new Error('The saved tax profile could not be read. It has not been changed.')
    }
  }

  save(input: unknown): TaxProfile {
    const profile = validateTaxProfile(input)
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(profile, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
    return profile
  }
}
