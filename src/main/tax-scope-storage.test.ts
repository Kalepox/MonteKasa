import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxScopeStore } from './tax-scope'
import { changeTaxScope, type TaxScope } from '../shared/tax-scope'
import type { TaxProfile } from '../shared/tax-profile'

const profile: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'complete'
}
const empty = (databaseId: string): TaxScope => ({
  version: 1,
  databaseId,
  taxpayers: [],
  accounts: [],
  assets: [],
  assignments: []
})
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function fixture(): { path: string; folder: string; saved: string; sidecar: string } {
  const folder = mkdtempSync(join(tmpdir(), 'tax-scope-storage-'))
  folders.push(folder)
  const path = join(folder, 'tax-scopes.json')
  const state = changeTaxScope(
    empty('kaleido-db'),
    { kind: 'taxpayer', label: 'Existing personal profile' },
    profile,
    new Set(),
    'existing-person'
  )
  const saved = JSON.stringify(state, null, 2)
  writeFileSync(path, saved)
  const hash = createHash('sha256').update('wdk-db').digest('hex')
  return { path, folder, saved, sidecar: join(folder, `tax-scopes-${hash}.json`) }
}

describe('tax scope storage for separate saved ledgers', () => {
  it('keeps an existing matching file unchanged on get and organisation', () => {
    const { path, folder, saved } = fixture()
    const store = new TaxScopeStore(path, 'kaleido-db')
    expect(store.get().taxpayers).toHaveLength(1)
    store.organise({ invoices: [], payments: [], proposals: [] })
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(readdirSync(folder)).toEqual(['tax-scopes.json'])
  })

  it('returns an empty scope for another ledger without creating or changing files', () => {
    const { path, folder, saved } = fixture()
    const store = new TaxScopeStore(path, 'wdk-db')
    expect(store.get()).toEqual(empty('wdk-db'))
    expect(store.organise({ invoices: [], payments: [], proposals: [] })).toEqual(empty('wdk-db'))
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(readdirSync(folder)).toEqual(['tax-scopes.json'])
  })

  it('persists and reopens only the other ledger sidecar while retaining the original scope', () => {
    const { path, saved, sidecar } = fixture()
    const store = new TaxScopeStore(path, 'wdk-db')
    const next = store.change({ kind: 'taxpayer', label: 'WDK profile' }, profile, new Set())
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual(next)
    expect(new TaxScopeStore(path, 'wdk-db').get()).toEqual(next)
    expect(new TaxScopeStore(path, 'kaleido-db').get()).toEqual(JSON.parse(saved))
    expect(readFileSync(path, 'utf8')).toBe(saved)
  })

  it('keeps other sidecars isolated and reuses a sidecar if the legacy file is absent', () => {
    const { path, saved, sidecar } = fixture()
    const next = new TaxScopeStore(path, 'wdk-db').change(
      { kind: 'taxpayer', label: 'WDK profile' },
      profile,
      new Set()
    )
    expect(new TaxScopeStore(path, 'third-db').get()).toEqual(empty('third-db'))
    expect(readFileSync(path, 'utf8')).toBe(saved)
    rmSync(path)
    expect(new TaxScopeStore(path, 'wdk-db').get()).toEqual(next)
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual(next)
  })

  it.each(['{bad json', '{}', JSON.stringify({ ...empty('kaleido-db'), accounts: [{}] })])(
    'fails closed for malformed legacy content instead of hiding it in a new scope',
    (content) => {
      const { path, folder } = fixture()
      writeFileSync(path, content)
      const store = new TaxScopeStore(path, 'wdk-db')
      expect(() => store.get()).toThrow('Scope file is invalid')
      expect(() => store.change({ kind: 'taxpayer', label: 'New' }, profile, new Set())).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(content)
      expect(readdirSync(folder)).toEqual(['tax-scopes.json'])
    }
  )

  it.each(['{bad json', JSON.stringify(empty('wrong-db'))])(
    'fails closed for corrupt or mismatched sidecars without changing either file',
    (content) => {
      const { path, saved, sidecar } = fixture()
      writeFileSync(sidecar, content)
      const store = new TaxScopeStore(path, 'wdk-db')
      expect(() => store.get()).toThrow('Scope file is invalid')
      expect(() => store.change({ kind: 'taxpayer', label: 'New' }, profile, new Set())).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(saved)
      expect(readFileSync(sidecar, 'utf8')).toBe(content)
    }
  )

  it('does not fail at construction or write a new file until setup is saved', () => {
    const { path, folder } = fixture()
    rmSync(path)
    const store = new TaxScopeStore(path, 'wdk-db')
    expect(store.get()).toEqual(empty('wdk-db'))
    expect(readdirSync(folder)).toEqual([])
    const next = store.change({ kind: 'taxpayer', label: 'First profile' }, profile, new Set())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(next)
    writeFileSync(path, 'invalid')
    expect(() => new TaxScopeStore(path, 'wdk-db')).not.toThrow()
    expect(() => new TaxScopeStore(path, 'wdk-db').get()).toThrow()
  })
})
