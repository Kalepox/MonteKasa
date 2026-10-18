import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { AppProfilesStore } from './app-profiles'
import { recordKeys, validateTaxScope, type TaxScope } from '../shared/tax-scope'
import type { AppProfileFields } from '../shared/app-profile'
import type { TaxProfile } from '../shared/tax-profile'
import { emptyValuation } from '../shared/tax-enrichment'
import type { KasaSnapshot } from '../preload/index.d'

const databases: Database.Database[] = []
const directories: string[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => {
    if (db.open) db.close()
  })
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
const fields: AppProfileFields = {
  name: 'Saved Person',
  company: 'Saved Company',
  email: 'fixture@example.test',
  taxId: 'Saved identifier',
  address: 'Saved address',
  currency: 'EUR'
}
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
function legacy(databaseId = ':memory:'): TaxScope {
  return {
    version: 1,
    databaseId,
    activeTaxpayerId: 'existing',
    taxpayers: [
      { id: 'existing', label: 'Original taxpayer label', profile },
      { id: 'foreign', label: 'Other existing taxpayer', profile }
    ],
    accounts: [
      {
        id: 'owned-account',
        taxpayerId: 'existing',
        label: 'Owned account',
        ownershipBps: 10000,
        kind: 'unknown',
        sourceId: 'owned-source'
      },
      {
        id: 'foreign-account',
        taxpayerId: 'foreign',
        label: 'Foreign account',
        ownershipBps: 10000,
        kind: 'unknown',
        sourceId: 'foreign-source'
      }
    ],
    assets: [
      {
        id: 'btc',
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        environment: 'live',
        decimals: 8
      }
    ],
    assignments: [
      { recordKey: 'payment:1', accountId: 'owned-account', assetId: 'btc' },
      { recordKey: 'payment:3', accountId: 'foreign-account', assetId: 'btc' }
    ],
    recordProfiles: [{ recordKey: 'payment:2', taxpayerId: 'existing' }],
    enrichments: [
      {
        recordKey: 'payment:1',
        accountId: 'owned-account',
        assetId: 'btc',
        classification: 'sale',
        valuation: {
          eur: '100',
          date: '2026-01-01',
          source: 'Fixture statement',
          reference: 'Reference'
        },
        fee: {
          status: 'none',
          amount: '',
          assetId: '',
          purpose: '',
          reference: '',
          valuation: emptyValuation()
        },
        relatedRecordKey: ''
      }
    ],
    preparationAnswers: [
      {
        taxpayerId: 'existing',
        taxYear: 2026,
        questionId: 'acquisition-history',
        status: 'partial',
        reference: 'Keep reference',
        notes: 'Keep notes'
      }
    ],
    disposalBases: [
      {
        taxpayerId: 'existing',
        taxYear: 2026,
        recordKey: 'payment:1',
        facts: '{}',
        transactionKind: 'fiat-sale',
        costBasisEur: '90',
        reference: 'Existing allocation',
        reviewed: true
      }
    ],
    autoAssignmentExclusions: ['payment:6']
  }
}
const snapshot: KasaSnapshot = {
  invoices: [],
  proposals: [],
  payments: [1, 2, 3, 4, 5, 6].map((nodeIdx) => ({
    nodeIdx,
    direction: 'out',
    invoiceId: null,
    received: 1,
    receivedRaw: 100000000,
    status: 'settled',
    txid: `fixture-${nodeIdx}`,
    blockTime: 1767225600,
    source: {
      id: nodeIdx === 3 || nodeIdx === 5 ? 'foreign-source' : 'owned-source',
      label: 'Fixture source',
      backend: 'wdk',
      asset: {
        symbol: 'BTC',
        canonicalId: 'bitcoin',
        network: 'bitcoin',
        environment: 'live',
        decimals: 8
      }
    }
  }))
}

function fixture(): {
  db: Database.Database
  original: TaxScope
  readLegacy: ReturnType<typeof vi.fn>
  store: AppProfilesStore
} {
  const db = new Database(':memory:')
  databases.push(db)
  // A sentinel ledger table proves this store never writes saved payment data.
  db.exec('CREATE TABLE payments (node_idx INTEGER PRIMARY KEY, original TEXT NOT NULL)')
  db.prepare('INSERT INTO payments VALUES (?, ?)').run(1, 'untouched payment')
  const original = legacy(db.name)
  const readLegacy = vi.fn(() => structuredClone(original))
  return { db, original, readLegacy, store: new AppProfilesStore(db, readLegacy) }
}
function create(store: AppProfilesStore, input = fields): string {
  return store.change({ kind: 'create', fields: input, requestId: randomUUID() }).activeProfileId!
}
function link(store: AppProfilesStore): string {
  const id = create(store)
  store.change({ kind: 'link-taxpayer', profileId: id, taxpayerId: 'existing' })
  return id
}
function rawScope(db: Database.Database): TaxScope {
  return JSON.parse(
    (
      db.prepare('SELECT scope_json FROM tax_scope_state WHERE id = 1').get() as {
        scope_json: string
      }
    ).scope_json
  )
}

describe('database-backed app profiles and taxpayer identity', () => {
  it('retains identities, selection, taxpayer links and annual settings after closing and reopening a real fixture database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasa-app-profiles-'))
    directories.push(directory)
    const path = join(directory, 'fixture.db')
    const db = new Database(path)
    databases.push(db)
    db.exec('CREATE TABLE payments (node_idx INTEGER PRIMARY KEY, original TEXT NOT NULL)')
    db.prepare('INSERT INTO payments VALUES (?, ?)').run(
      1,
      'Original ledger bytes\n€ 100.00 · fixture'
    )
    const ledgerBefore = db
      .prepare(
        'SELECT node_idx, original, hex(CAST(original AS BLOB)) AS bytes FROM payments ORDER BY node_idx'
      )
      .all()
    const savedScope = legacy(db.name)
    const readLegacy = vi.fn(() => structuredClone(savedScope))
    const first = new AppProfilesStore(db, readLegacy)
    const firstId = link(first)
    first.change({
      kind: 'update',
      profileId: firstId,
      fields: { ...fields, name: 'Renamed after migration' }
    })
    first.change({
      kind: 'save-tax',
      profileId: firstId,
      profile: { ...profile, taxYear: 2025, recordsCoverage: 'incomplete' }
    })
    const secondId = create(first, { ...fields, name: 'Second fixture profile' })
    first.change({ kind: 'link-taxpayer', profileId: secondId, taxpayerId: 'foreign' })
    first.change({ kind: 'select', profileId: firstId })
    first.change({ kind: 'select-tax-year', profileId: firstId, taxYear: 2026 })
    const beforeRestart = first.get()
    expect(
      db
        .prepare(
          'SELECT node_idx, original, hex(CAST(original AS BLOB)) AS bytes FROM payments ORDER BY node_idx'
        )
        .all()
    ).toEqual(ledgerBefore)
    expect(readLegacy).toHaveBeenCalledOnce()
    db.close()

    const reopenedDb = new Database(path)
    databases.push(reopenedDb)
    const noLegacyRead = vi.fn(() => {
      throw new Error('Legacy backup must not be reimported after restart')
    })
    const reopened = new AppProfilesStore(reopenedDb, noLegacyRead)
    expect(reopened.get()).toEqual(beforeRestart)
    expect(reopened.get().activeProfileId).toBe(firstId)
    expect(reopened.get().profiles.map((entry) => [entry.id, entry.taxpayerId])).toEqual([
      [firstId, 'existing'],
      [secondId, 'foreign']
    ])
    expect(reopened.getTaxScope().taxpayers[0].yearProfiles?.map((entry) => entry.taxYear)).toEqual(
      [2025, 2026]
    )
    expect(reopened.getTaxScope().taxpayers[0].profile.taxYear).toBe(2026)
    reopened.change({ kind: 'select-tax-year', profileId: firstId, taxYear: 2025 })
    expect(reopened.getTaxScope().taxpayers[0].profile).toEqual({
      ...profile,
      taxYear: 2025,
      recordsCoverage: 'incomplete'
    })
    expect(reopened.getTaxScope().recordProfiles).toEqual(savedScope.recordProfiles)
    expect(reopened.getTaxScope().enrichments).toEqual(savedScope.enrichments)
    expect(
      reopenedDb
        .prepare(
          'SELECT node_idx, original, hex(CAST(original AS BLOB)) AS bytes FROM payments ORDER BY node_idx'
        )
        .all()
    ).toEqual(ledgerBefore)
    expect(noLegacyRead).not.toHaveBeenCalled()
  })

  it('imports tax metadata exactly once while retaining all relationships and never selecting an arbitrary app identity', () => {
    const f = fixture()
    expect(f.readLegacy).toHaveBeenCalledOnce()
    expect(rawScope(f.db)).toEqual(validateTaxScope(f.original, f.db.name))
    expect(f.store.get()).toMatchObject({
      profiles: [],
      activeProfileId: null,
      legacyImported: false,
      scope: { appProfileId: null }
    })
    expect(f.store.getTaxScope().activeTaxpayerId).toBeUndefined()
    const fail = vi.fn(() => {
      throw new Error('Legacy file must not be read again')
    })
    expect(new AppProfilesStore(f.db, fail).get()).toEqual(f.store.get())
    expect(fail).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT * FROM payments').all()).toEqual([
      { node_idx: 1, original: 'untouched payment' }
    ])
  })

  it('rolls the schema and metadata import back when legacy validation fails', () => {
    const db = new Database(':memory:')
    databases.push(db)
    const malformed = { ...legacy(), databaseId: 'another-database' }
    expect(() => new AppProfilesStore(db, () => malformed)).toThrow('different database')
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_profiles', 'app_profile_settings', 'tax_scope_state')"
        )
        .all()
    ).toEqual([])
    expect(new AppProfilesStore(db, () => legacy()).get().profiles).toEqual([])
  })

  it('creates stable IDs and retries a request without creating duplicates or reverting subsequent edits', () => {
    const { store, db } = fixture()
    const requestId = randomUUID()
    const first = store.change({ kind: 'create', fields, requestId })
    const id = first.activeProfileId!
    expect(id).toMatch(/^[a-f\d-]{36}$/)
    store.change({ kind: 'update', profileId: id, fields: { ...fields, name: 'Renamed' } })
    expect(store.change({ kind: 'create', fields, requestId }).profiles).toEqual([
      { ...fields, name: 'Renamed', id, taxpayerId: null }
    ])
    const restart = new AppProfilesStore(db, () => {
      throw new Error('Must use saved database state')
    })
    expect(restart.get()).toEqual(store.get())
    expect(() => store.change({ kind: 'create', fields, requestId: 'invalid' })).toThrow(
      'request ID'
    )
    expect(store.get().profiles).toHaveLength(1)
  })

  it('imports saved presentation identity once without guessing a taxpayer from matching names', () => {
    const { store } = fixture()
    const first = store.change({
      kind: 'import-legacy',
      fields: { ...fields, name: 'Original taxpayer label' }
    })
    expect(first.profiles[0].taxpayerId).toBeNull()
    expect(first.scope.activeTaxpayerId).toBeUndefined()
    expect(first.legacyImported).toBe(true)
    expect(
      store.change({ kind: 'import-legacy', fields: { ...fields, name: 'A later renderer value' } })
    ).toEqual(first)
  })

  it('does not import another identity after an explicit app profile has been created', () => {
    const { store } = fixture()
    create(store)
    const before = store.get()
    expect(
      store.change({ kind: 'import-legacy', fields: { ...fields, name: 'Old presentation' } })
    ).toEqual(before)
  })

  it('links an explicitly chosen existing taxpayer and preserves every legacy ID and financial declaration', () => {
    const { store, db, original } = fixture()
    const id = link(store)
    expect(store.getTaxScope()).toMatchObject({ appProfileId: id, activeTaxpayerId: 'existing' })
    expect(store.getTaxScope().taxpayers.find((entry) => entry.id === 'existing')?.label).toBe(
      fields.name
    )
    expect(rawScope(db)).toEqual(validateTaxScope(original, db.name))
    expect(
      store.change({ kind: 'link-taxpayer', profileId: id, taxpayerId: 'existing' }).profiles
    ).toHaveLength(1)
  })

  it('enforces both sides of the one-to-one link and preserves failed attempts atomically', () => {
    const { store } = fixture()
    const firstId = link(store)
    expect(() =>
      store.change({ kind: 'link-taxpayer', profileId: firstId, taxpayerId: 'foreign' })
    ).toThrow('already has a taxpayer')
    const secondId = create(store, { ...fields, name: 'Second person' })
    const before = store.get()
    expect(() =>
      store.change({ kind: 'link-taxpayer', profileId: secondId, taxpayerId: 'existing' })
    ).toThrow('another app profile')
    expect(() =>
      store.change({ kind: 'link-taxpayer', profileId: firstId, taxpayerId: 'existing' })
    ).toThrow('active app profile changed')
    expect(store.get()).toEqual(before)
    store.change({ kind: 'link-taxpayer', profileId: secondId, taxpayerId: 'foreign' })
    expect(store.getTaxScope().activeTaxpayerId).toBe('foreign')
    store.change({ kind: 'select', profileId: firstId })
    expect(store.getTaxScope().activeTaxpayerId).toBe('existing')
  })

  it('retains the taxpayer and original stored label when app identity fields change', () => {
    const { store, db } = fixture()
    const id = link(store)
    const before = rawScope(db)
    store.change({
      kind: 'update',
      profileId: id,
      fields: { ...fields, name: 'Updated Person', company: 'Updated Company' }
    })
    expect(store.getTaxScope().taxpayers[0].label).toBe('Updated Person')
    expect(store.get().profiles[0].taxpayerId).toBe('existing')
    expect(rawScope(db)).toEqual(before)
  })

  it('creates tax settings once and edits or changes tax year under the same taxpayer identity', () => {
    const { store, db, original } = fixture()
    const id = create(store)
    const first = store.change({ kind: 'save-tax', profileId: id, profile })
    const taxpayerId = first.profiles[0].taxpayerId!
    const earlier: TaxProfile = { ...profile, taxYear: 2025, personalRegime: 'amministrato' }
    store.change({ kind: 'save-tax', profileId: id, profile: earlier })
    store.change({
      kind: 'save-tax',
      profileId: id,
      profile: { ...profile, recordsCoverage: 'incomplete' }
    })
    const next = store.getTaxScope().taxpayers.find((entry) => entry.id === taxpayerId)!
    expect(store.getTaxScope().taxpayers).toHaveLength(original.taxpayers.length + 1)
    expect(next.yearProfiles).toEqual([earlier, { ...profile, recordsCoverage: 'incomplete' }])
    expect(next.profile.taxYear).toBe(2026)
    expect(rawScope(db).assignments).toEqual(original.assignments)
    expect(rawScope(db).recordProfiles).toEqual(original.recordProfiles)
    expect(rawScope(db).enrichments).toEqual(original.enrichments)
  })

  it('retains old-year settings and evidence while editing an existing linked taxpayer', () => {
    const { store, original, db } = fixture()
    const id = link(store)
    store.change({
      kind: 'save-tax',
      profileId: id,
      profile: { ...profile, taxYear: 2025, recordsCoverage: 'incomplete' }
    })
    const next = rawScope(db)
    expect(next.taxpayers[0].id).toBe('existing')
    expect(next.taxpayers[0].yearProfiles).toContainEqual(profile)
    expect(next.disposalBases).toEqual(original.disposalBases)
    expect(next.preparationAnswers).toEqual(original.preparationAnswers)
    expect(next.enrichments).toEqual(original.enrichments)
    expect(next.assignments).toEqual(original.assignments)
    expect(next.recordProfiles).toEqual(original.recordProfiles)
    expect(next.taxpayers[0].label).toBe('Original taxpayer label')
  })

  it('selects only saved annual settings and preserves all evidence when switching back and forth', () => {
    const { store, db } = fixture()
    const id = link(store)
    const earlier: TaxProfile = {
      ...profile,
      taxYear: 2025,
      personalRegime: 'amministrato',
      recordsCoverage: 'incomplete'
    }
    store.change({ kind: 'save-tax', profileId: id, profile: earlier })
    const before = rawScope(db)
    const profilesBefore = store.get().profiles
    const selected = store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })
    expect(selected.activeProfileId).toBe(id)
    expect(selected.scope.activeTaxpayerId).toBe('existing')
    expect(selected.profiles).toEqual(profilesBefore)
    expect(rawScope(db)).toEqual({
      ...before,
      taxpayers: [{ ...before.taxpayers[0], profile }, before.taxpayers[1]]
    })
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2025 })
    expect(rawScope(db)).toEqual(before)
    expect(store.getTaxScope().taxpayers[0].profile).toEqual(earlier)
    expect(db.prepare('SELECT * FROM payments').all()).toEqual([
      { node_idx: 1, original: 'untouched payment' }
    ])
  })

  it('preserves imported current-year settings even when annual history omits them', () => {
    const { store, db } = fixture()
    const id = link(store)
    const saved = rawScope(db)
    const earlier = { ...profile, taxYear: 2025, recordsCoverage: 'incomplete' as const }
    saved.taxpayers[0].yearProfiles = [earlier]
    db.prepare('UPDATE tax_scope_state SET scope_json = ? WHERE id = 1').run(JSON.stringify(saved))
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2025 })
    expect(store.getTaxScope().taxpayers[0].yearProfiles).toEqual([earlier, profile])
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })
    expect(store.getTaxScope().taxpayers[0].profile).toEqual(profile)
  })

  it('uses the saved current settings when history contains an older copy of the same year', () => {
    const { store, db } = fixture()
    const id = link(store)
    const saved = rawScope(db)
    saved.taxpayers[0].yearProfiles = [
      { ...profile, taxYear: 2025 },
      { ...profile, recordsCoverage: 'incomplete' }
    ]
    db.prepare('UPDATE tax_scope_state SET scope_json = ? WHERE id = 1').run(JSON.stringify(saved))
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2025 })
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })
    expect(store.getTaxScope().taxpayers[0].profile).toEqual(profile)
  })

  it('retains each app profile’s selected year and independent annual answers', () => {
    const { store, db } = fixture()
    const first = link(store)
    store.change({ kind: 'save-tax', profileId: first, profile: { ...profile, taxYear: 2025 } })
    const second = create(store, { ...fields, name: 'Second person' })
    store.change({ kind: 'link-taxpayer', profileId: second, taxpayerId: 'foreign' })
    store.change({
      kind: 'save-tax',
      profileId: second,
      profile: { ...profile, taxYear: 2024, personalRegime: 'amministrato' }
    })
    const otherBefore = rawScope(db).taxpayers[1]
    store.change({ kind: 'select', profileId: first })
    store.change({ kind: 'select-tax-year', profileId: first, taxYear: 2026 })
    expect(rawScope(db).taxpayers[1]).toEqual(otherBefore)
    store.change({ kind: 'select', profileId: second })
    expect(store.getTaxScope().taxpayers[1].profile.taxYear).toBe(2024)
    store.change({ kind: 'select', profileId: first })
    expect(store.getTaxScope().taxpayers[0].profile.taxYear).toBe(2026)
  })

  it.each([2025, 2027, 2026.5, '2026', null, undefined, NaN])(
    'rejects an unsaved or invalid selected tax year %s without copying current answers',
    (taxYear) => {
      const { store, db } = fixture()
      const id = link(store)
      const before = store.get()
      const persistedBefore = rawScope(db)
      expect(() => store.change({ kind: 'select-tax-year', profileId: id, taxYear })).toThrow(
        'Set up tax information for this year'
      )
      expect(store.get()).toEqual(before)
      expect(rawScope(db)).toEqual(persistedBefore)
    }
  )

  it('requires an active linked app profile before selecting a saved tax year', () => {
    const { store } = fixture()
    expect(() =>
      store.change({ kind: 'select-tax-year', profileId: 'missing', taxYear: 2026 })
    ).toThrow('app profile first')
    const first = link(store)
    const second = create(store, { ...fields, name: 'Unlinked person' })
    const before = store.get()
    expect(() =>
      store.change({ kind: 'select-tax-year', profileId: first, taxYear: 2026 })
    ).toThrow('active app profile changed')
    expect(() =>
      store.change({ kind: 'select-tax-year', profileId: second, taxYear: 2026 })
    ).toThrow('link a taxpayer')
    expect(store.get()).toEqual(before)
  })

  it('selects an already current imported year without rewriting saved evidence', () => {
    const { store, db } = fixture()
    const id = link(store)
    const before = store.get()
    const persistedBefore = rawScope(db)
    expect(store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })).toEqual(before)
    expect(rawScope(db)).toEqual(persistedBefore)
  })

  it('rolls back a failed tax-year selection and retains both years for retry', () => {
    const { store, db } = fixture()
    const id = link(store)
    store.change({ kind: 'save-tax', profileId: id, profile: { ...profile, taxYear: 2025 } })
    const before = store.get()
    db.exec(
      "CREATE TRIGGER prevent_year_write BEFORE UPDATE ON tax_scope_state BEGIN SELECT RAISE(ABORT, 'fixture year failure'); END"
    )
    expect(() => store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })).toThrow(
      'fixture year failure'
    )
    expect(store.get()).toEqual(before)
    db.exec('DROP TRIGGER prevent_year_write')
    store.change({ kind: 'select-tax-year', profileId: id, taxYear: 2026 })
    expect(store.getTaxScope().taxpayers[0].profile.taxYear).toBe(2026)
    expect(store.getTaxScope().taxpayers[0].yearProfiles?.map((entry) => entry.taxYear)).toEqual([
      2025, 2026
    ])
  })

  it('rolls back taxpayer creation together with its app-profile link if saving scope fails', () => {
    const { store, db } = fixture()
    const id = create(store)
    const before = store.get()
    db.exec(
      "CREATE TRIGGER prevent_tax_write BEFORE UPDATE ON tax_scope_state BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    )
    expect(() => store.change({ kind: 'save-tax', profileId: id, profile })).toThrow(
      'fixture failure'
    )
    expect(store.get()).toEqual(before)
    db.exec('DROP TRIGGER prevent_tax_write')
    store.change({ kind: 'save-tax', profileId: id, profile })
    expect(store.get().scope.taxpayers).toHaveLength(before.scope.taxpayers.length + 1)
  })

  it('updates annual history coverage while preserving other-year settings', () => {
    const { store } = fixture()
    const id = link(store)
    store.change({ kind: 'save-tax', profileId: id, profile: { ...profile, taxYear: 2025 } })
    store.changeTaxScope(
      { kind: 'history-coverage', taxpayerId: 'existing', coverage: 'incomplete' },
      recordKeys(snapshot),
      snapshot
    )
    const taxpayer = store.getTaxScope().taxpayers[0]
    expect(taxpayer.profile.recordsCoverage).toBe('incomplete')
    expect(taxpayer.yearProfiles?.find((entry) => entry.taxYear === 2025)?.recordsCoverage).toBe(
      'incomplete'
    )
    expect(taxpayer.yearProfiles?.find((entry) => entry.taxYear === 2026)?.recordsCoverage).toBe(
      'complete'
    )
  })

  it('requires an active linked app profile before any tax mutation and ignores old scope selection authority', () => {
    const { store } = fixture()
    expect(() =>
      store.changeTaxScope(
        { kind: 'history-coverage', taxpayerId: 'existing', coverage: 'incomplete' },
        recordKeys(snapshot),
        snapshot
      )
    ).toThrow('app profile first')
    create(store)
    expect(() =>
      store.changeTaxScope(
        { kind: 'history-coverage', taxpayerId: 'existing', coverage: 'incomplete' },
        recordKeys(snapshot),
        snapshot
      )
    ).toThrow('link a taxpayer')
    expect(store.organise(snapshot).assignments).toHaveLength(2)
  })

  it.each([
    { kind: 'create-profile', label: 'Bypass', profile },
    { kind: 'taxpayer', label: 'Bypass' },
    { kind: 'select-taxpayer', taxpayerId: 'foreign' },
    { kind: 'history-coverage', taxpayerId: 'foreign', coverage: 'incomplete' },
    { kind: 'link-records', taxpayerId: 'foreign', recordKeys: ['payment:4'] },
    {
      kind: 'account',
      taxpayerId: 'foreign',
      label: 'Bypass',
      ownershipBps: 10000,
      accountKind: 'unknown'
    },
    {
      kind: 'bind-source',
      taxpayerId: 'foreign',
      sourceId: 'foreign-source',
      accountId: 'foreign-account'
    },
    { kind: 'unbind-source', accountId: 'foreign-account' },
    { kind: 'assign', recordKey: 'payment:4', accountId: 'foreign-account', assetId: 'btc' },
    { kind: 'assign', recordKey: 'payment:3', accountId: 'owned-account', assetId: 'btc' },
    { kind: 'unassign', recordKey: 'payment:3' },
    { kind: 'clear-enrichment', recordKey: 'payment:3' },
    { kind: 'enrich', enrichment: { recordKey: 'payment:3', accountId: 'foreign-account' } },
    { kind: 'preparation-answer', answer: { taxpayerId: 'foreign' } },
    { kind: 'disposal-basis', basis: { taxpayerId: 'foreign', recordKey: 'payment:3' } }
  ])(
    'rejects independent taxpayer creation or foreign-profile command %# without writes',
    (command) => {
      const { store, db } = fixture()
      link(store)
      const before = rawScope(db)
      expect(() => store.changeTaxScope(command, recordKeys(snapshot), snapshot)).toThrow()
      expect(rawScope(db)).toEqual(before)
    }
  )

  it('allows active-profile changes and organises only its confirmed source without moving foreign relationships', () => {
    const { store, original, db } = fixture()
    link(store)
    expect(
      store.changeTaxScope(
        { kind: 'select-taxpayer', taxpayerId: 'existing' },
        recordKeys(snapshot),
        snapshot
      )
    ).toEqual(store.getTaxScope())
    store.changeTaxScope(
      { kind: 'link-records', taxpayerId: 'existing', recordKeys: ['payment:4'] },
      recordKeys(snapshot),
      snapshot
    )
    const organised = store.organise(snapshot)
    expect(organised.assignments).toContainEqual({
      recordKey: 'payment:4',
      accountId: 'owned-account',
      assetId: 'btc'
    })
    expect(organised.assignments.some((entry) => entry.recordKey === 'payment:5')).toBe(false)
    expect(organised.assignments.some((entry) => entry.recordKey === 'payment:6')).toBe(false)
    expect(organised.assignments).toContainEqual(original.assignments[1])
    expect(organised.enrichments).toEqual(original.enrichments)
    expect(db.prepare('SELECT * FROM payments').all()).toEqual([
      { node_idx: 1, original: 'untouched payment' }
    ])
  })

  it('limits source-binding automatic additions to the active profile and retains foreign source declarations', () => {
    const { store, original } = fixture()
    link(store)
    const next = store.changeTaxScope(
      {
        kind: 'bind-source',
        taxpayerId: 'existing',
        sourceId: 'owned-source',
        accountId: 'owned-account'
      },
      recordKeys(snapshot),
      snapshot
    )
    expect(next.assignments).toContainEqual({
      recordKey: 'payment:4',
      accountId: 'owned-account',
      assetId: 'btc'
    })
    expect(next.assignments.some((entry) => entry.recordKey === 'payment:5')).toBe(false)
    expect(next.accounts).toEqual(original.accounts)
    expect(next.enrichments).toEqual(original.enrichments)
  })

  it('does not trust a legacy scope selection or transient app profile marker as registry authority', () => {
    const { store, db } = fixture()
    const id = link(store)
    const saved = { ...rawScope(db), activeTaxpayerId: 'foreign', appProfileId: 'forged' }
    db.prepare('UPDATE tax_scope_state SET scope_json = ? WHERE id = 1').run(JSON.stringify(saved))
    expect(store.getTaxScope()).toMatchObject({ appProfileId: id, activeTaxpayerId: 'existing' })
    expect(validateTaxScope(saved, db.name)).not.toHaveProperty('appProfileId')
  })

  it('validates annual settings without dropping existing historical years', () => {
    const saved = legacy()
    saved.taxpayers[0].yearProfiles = [{ ...profile, taxYear: 2025 }, profile]
    expect(validateTaxScope(saved, saved.databaseId).taxpayers[0].yearProfiles).toEqual(
      saved.taxpayers[0].yearProfiles
    )
    saved.taxpayers[0].yearProfiles.push(profile)
    expect(() => validateTaxScope(saved, saved.databaseId)).toThrow('Duplicate annual')
  })
})
