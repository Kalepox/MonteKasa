import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxScopeStore } from './tax-scope'
import { recordKeys, scopedRecords, type TaxScope } from '../shared/tax-scope'
import type { KasaSnapshot } from '../preload/index.d'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
)
const original: TaxScope = {
  version: 1,
  databaseId: 'fixture',
  activeTaxpayerId: 'person',
  taxpayers: [
    {
      id: 'person',
      label: 'Fixture person',
      profile: {
        version: 1,
        country: 'IT',
        taxYear: 2026,
        userType: 'personal',
        personalRegime: 'dichiarativo',
        businessType: null,
        businessRegime: null,
        recordsCoverage: 'unknown'
      }
    }
  ],
  accounts: [],
  assets: [],
  assignments: []
}
const snapshot: KasaSnapshot = {
  invoices: [],
  proposals: [],
  payments: [
    {
      nodeIdx: 1,
      direction: 'in',
      invoiceId: null,
      received: 1,
      status: 'settled',
      txid: 'fixture',
      blockTime: null
    }
  ]
}
const command = { kind: 'link-records', taxpayerId: 'person', recordKeys: ['payment:1'] }
function fixture(): { path: string; ledgerPath: string; store: TaxScopeStore } {
  const directory = mkdtempSync(join(tmpdir(), 'tax-record-profile-'))
  directories.push(directory)
  const path = join(directory, 'scope.json')
  const ledgerPath = join(directory, 'ledger.json')
  writeFileSync(path, JSON.stringify(original, null, 2))
  writeFileSync(ledgerPath, JSON.stringify(snapshot, null, 2))
  return { path, ledgerPath, store: new TaxScopeStore(path, 'fixture') }
}

describe('record profile relationship persistence', () => {
  it('persists profile-only relationships across restart while leaving saved payments and profile declarations unchanged', () => {
    const { path, ledgerPath, store } = fixture()
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const saved = store.change(command, null, recordKeys(snapshot), snapshot)
    const restarted = new TaxScopeStore(path, 'fixture')
    expect(restarted.get().recordProfiles).toEqual([
      { recordKey: 'payment:1', taxpayerId: 'person' }
    ])
    expect(saved.accounts).toEqual([])
    expect(saved.assets).toEqual([])
    expect(saved.assignments).toEqual([])
    expect(saved.taxpayers).toEqual(original.taxpayers)
    expect(scopedRecords(restarted.get(), snapshot, 'person').payments).toEqual(snapshot.payments)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)
    const metadataBefore = readFileSync(path, 'utf8')
    restarted.change(command, null, recordKeys(snapshot), snapshot)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(metadataBefore))
  })

  it('fails atomically for stale selection, duplicate keys and records absent from this database', () => {
    const { path, store } = fixture()
    const before = readFileSync(path, 'utf8')
    for (const input of [
      { ...command, taxpayerId: 'other' },
      { ...command, recordKeys: ['payment:1', 'payment:2'] },
      { ...command, recordKeys: ['payment:1', 'payment:1'] }
    ]) {
      expect(() => store.change(input, null, recordKeys(snapshot), snapshot)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
  })

  it('keeps record relationships isolated to their original database', () => {
    const { path, store } = fixture()
    store.change(command, null, recordKeys(snapshot), snapshot)
    const before = readFileSync(path, 'utf8')
    const other = new TaxScopeStore(path, 'other-database')
    expect(other.get().recordProfiles).toBeUndefined()
    expect(other.get().taxpayers).toEqual([])
    expect(() => other.change(command, null, recordKeys(snapshot), snapshot)).toThrow(
      'existing profile'
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('retains missing-record relationships for review and removes an explicit unassign across restart', () => {
    const { path, store } = fixture()
    store.change(command, null, recordKeys(snapshot), snapshot)
    expect(
      store.organise({ invoices: [], payments: [], proposals: [] }).recordProfiles
    ).toHaveLength(1)
    store.change({ kind: 'unassign', recordKey: 'payment:1' }, null, recordKeys(snapshot), snapshot)
    const restarted = new TaxScopeStore(path, 'fixture').get()
    expect(restarted.recordProfiles).toEqual([])
    expect(restarted.autoAssignmentExclusions).toEqual(['payment:1'])
  })
})
