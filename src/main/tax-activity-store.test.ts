import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaxScopeStore } from './tax-scope'
import { recordKeys, type TaxScope } from '../shared/tax-scope'
import type { KasaSnapshot } from '../preload/index.d'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
)
const original: TaxScope = {
  version: 1,
  databaseId: 'fixture',
  taxpayers: [
    {
      id: 'me',
      label: 'Existing profile',
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
      receivedRaw: 100000000,
      status: 'settled',
      txid: 'local-fixture',
      blockTime: 1,
      source: {
        id: 'saved-app-stream',
        label: 'Saved source',
        backend: 'wdk',
        asset: {
          symbol: 'BTC',
          canonicalId: 'btc',
          network: 'bitcoin',
          decimals: 8,
          environment: 'live'
        }
      }
    }
  ]
}
const command = {
  kind: 'bind-source',
  sourceId: 'saved-app-stream',
  taxpayerId: 'me',
  ownershipBps: 10000
}
function fixture(): { path: string; store: TaxScopeStore } {
  const directory = mkdtempSync(join(tmpdir(), 'tax-activity-store-'))
  directories.push(directory)
  const path = join(directory, 'scope.json')
  writeFileSync(path, JSON.stringify(original, null, 2))
  return { path, store: new TaxScopeStore(path, 'fixture') }
}

describe('local-only activity organisation persistence', () => {
  it('keeps get read-only, validates trusted snapshot on binding and persists mapping across restart', () => {
    const { path, store } = fixture()
    const before = readFileSync(path, 'utf8')
    expect(store.get()).toEqual(original)
    expect(store.organise(snapshot)).toEqual(original)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(() => store.change(command, null, recordKeys(snapshot))).toThrow('Saved ledger data')
    expect(readFileSync(path, 'utf8')).toBe(before)
    const linked = store.change(command, null, recordKeys(snapshot), snapshot)
    const restarted = new TaxScopeStore(path, 'fixture')
    expect(restarted.get().accounts).toEqual(linked.accounts)
    expect(restarted.get().assignments).toEqual(linked.assignments)
    expect(restarted.get().taxpayers).toEqual(original.taxpayers)
    const persisted = readFileSync(path, 'utf8')
    restarted.organise(snapshot)
    expect(readFileSync(path, 'utf8')).toBe(persisted)
    const newSnapshot = {
      ...snapshot,
      payments: [...snapshot.payments, { ...snapshot.payments[0], nodeIdx: 2 }]
    }
    expect(restarted.organise(newSnapshot).assignments).toHaveLength(2)
    expect(new TaxScopeStore(path, 'fixture').get().assignments).toHaveLength(2)
  })
  it('leaves files unchanged when source binding cannot be validated', () => {
    const { path, store } = fixture()
    const before = readFileSync(path, 'utf8')
    for (const invalid of [
      { ...command, sourceId: 'invented' },
      { ...command, ownershipBps: null },
      { ...command, taxpayerId: 'missing' }
    ]) {
      expect(() => store.change(invalid, null, recordKeys(snapshot), snapshot)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
    expect(new TaxScopeStore(path, 'another-database').organise(snapshot)).toMatchObject({
      databaseId: 'another-database',
      taxpayers: [],
      accounts: [],
      assets: [],
      assignments: []
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  it('persists manual exclusions and disconnect without deleting prior records', () => {
    const { path, store } = fixture()
    const linked = store.change(command, null, recordKeys(snapshot), snapshot)
    store.change({ kind: 'unassign', recordKey: 'payment:1' }, null, recordKeys(snapshot))
    expect(new TaxScopeStore(path, 'fixture').organise(snapshot).assignments).toEqual([])
    const added = {
      ...snapshot,
      payments: [...snapshot.payments, { ...snapshot.payments[0], nodeIdx: 2 }]
    }
    expect(store.organise(added).assignments).toHaveLength(1)
    const accountId = linked.accounts[0].id
    store.change({ kind: 'unbind-source', accountId }, null, recordKeys(added))
    const restarted = new TaxScopeStore(path, 'fixture')
    const third = {
      ...added,
      payments: [...added.payments, { ...snapshot.payments[0], nodeIdx: 3 }]
    }
    const result = restarted.organise(third)
    expect(result.assignments.map((assignment) => assignment.recordKey)).toEqual(['payment:2'])
    expect(result.accounts[0].sourceId).toBeUndefined()
    expect(result.assets).toEqual(linked.assets)
    expect(result.autoAssignmentExclusions).toEqual(['payment:1'])
  })
})
