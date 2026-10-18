import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  appProfileLabel,
  validateAppProfileFields,
  type AppProfile,
  type AppProfileState
} from '../shared/app-profile'
import { validateTaxProfile } from '../shared/tax-profile'
import { changeTaxScope, validateTaxScope, type TaxScope } from '../shared/tax-scope'
import { bindLedgerSource, organiseTaxActivity } from '../shared/tax-activity'
import { recordTaxpayerMap } from '../shared/tax-record-profile'
import type { KasaSnapshot } from '../preload/index.d'

type ProfileRow = { id: string; fields_json: string; taxpayer_id: string | null }

// Receives an already-open application database. This store has no wallet,
// network, Electron or database-configuration dependencies.
export class AppProfilesStore {
  private readonly databaseId: string

  constructor(
    private readonly db: Database.Database,
    legacyScope: () => TaxScope
  ) {
    this.databaseId = db.name
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_profiles (
          id TEXT PRIMARY KEY,
          fields_json TEXT NOT NULL,
          taxpayer_id TEXT UNIQUE,
          request_id TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS app_profile_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tax_scope_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          scope_json TEXT NOT NULL
        );
      `)
      if (!db.prepare('SELECT id FROM tax_scope_state WHERE id = 1').get()) {
        const scope = validateTaxScope(legacyScope(), this.databaseId)
        db.prepare('INSERT INTO tax_scope_state (id, scope_json) VALUES (1, ?)').run(
          JSON.stringify(scope)
        )
      }
    })()
  }

  private setting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM app_profile_settings WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_profile_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  private scope(): TaxScope {
    const row = this.db.prepare('SELECT scope_json FROM tax_scope_state WHERE id = 1').get() as
      { scope_json: string } | undefined
    if (!row) throw new Error('Saved tax information is unavailable. No changes were applied.')
    return validateTaxScope(JSON.parse(row.scope_json), this.databaseId)
  }

  private saveScope(scope: TaxScope): void {
    const persisted = validateTaxScope(scope, this.databaseId)
    this.db
      .prepare('UPDATE tax_scope_state SET scope_json = ? WHERE id = 1')
      .run(JSON.stringify(persisted))
  }

  private profiles(): AppProfile[] {
    const rows = this.db
      .prepare('SELECT id, fields_json, taxpayer_id FROM app_profiles ORDER BY rowid')
      .all() as ProfileRow[]
    return rows.map((row) => ({
      ...validateAppProfileFields(JSON.parse(row.fields_json)),
      id: row.id,
      taxpayerId: row.taxpayer_id
    }))
  }

  private view(scope: TaxScope, profiles: AppProfile[], activeProfileId: string | null): TaxScope {
    const active = profiles.find((profile) => profile.id === activeProfileId)
    const result = structuredClone(scope)
    delete result.activeTaxpayerId
    result.appProfileId = active?.id ?? null
    if (active?.taxpayerId) {
      if (!result.taxpayers.some((taxpayer) => taxpayer.id === active.taxpayerId))
        throw new Error(
          'The app profile’s saved taxpayer link is missing. Existing information has been retained.'
        )
      result.activeTaxpayerId = active.taxpayerId
    }
    const profileByTaxpayer = new Map(
      profiles
        .filter((profile) => profile.taxpayerId)
        .map((profile) => [profile.taxpayerId, profile])
    )
    for (const taxpayer of result.taxpayers) {
      const appProfile = profileByTaxpayer.get(taxpayer.id)
      if (appProfile) taxpayer.label = appProfileLabel(appProfile, taxpayer.profile.userType)
    }
    return result
  }

  get(): AppProfileState {
    const profiles = this.profiles()
    const selected = this.setting('active_profile_id')
    if (selected && !profiles.some((profile) => profile.id === selected))
      throw new Error('The active app profile is missing. Existing profiles have been retained.')
    const activeProfileId = selected ?? null
    return {
      databaseId: this.databaseId,
      profiles,
      activeProfileId,
      scope: this.view(this.scope(), profiles, activeProfileId),
      legacyImported: this.setting('legacy_imported') === '1'
    }
  }

  getTaxScope(): TaxScope {
    return this.get().scope
  }

  private active(profiles = this.profiles()): AppProfile {
    const current = profiles.find((profile) => profile.id === this.setting('active_profile_id'))
    if (!current) throw new Error('Choose or create an app profile first.')
    return current
  }

  private requireActive(profileId: unknown): AppProfile {
    const profile = this.active()
    if (profile.id !== profileId)
      throw new Error('The active app profile changed. Reload before saving.')
    return profile
  }

  change(input: unknown): AppProfileState {
    if (!input || typeof input !== 'object') throw new Error('Invalid app profile command.')
    const command = input as Record<string, unknown>
    return this.db.transaction(() => {
      if (command.kind === 'create' || command.kind === 'import-legacy') {
        if (command.kind === 'import-legacy' && this.setting('legacy_imported') === '1')
          return this.get()
        const fields = validateAppProfileFields(command.fields)
        if (command.kind === 'create') {
          if (
            typeof command.requestId !== 'string' ||
            !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(command.requestId)
          )
            throw new Error('A valid creation request ID is required.')
          const previous = this.db
            .prepare('SELECT id FROM app_profiles WHERE request_id = ?')
            .get(command.requestId) as { id: string } | undefined
          if (previous) return this.get()
        }
        // An explicit app profile already created on this database takes priority
        // over old renderer presentation data. Never import an extra duplicate.
        if (command.kind === 'import-legacy' && this.profiles().length) {
          this.setSetting('legacy_imported', '1')
          return this.get()
        }
        const id = randomUUID()
        this.db
          .prepare(
            'INSERT INTO app_profiles (id, fields_json, taxpayer_id, request_id) VALUES (?, ?, NULL, ?)'
          )
          .run(
            id,
            JSON.stringify(fields),
            command.kind === 'create' ? command.requestId : 'legacy-import'
          )
        this.setSetting('active_profile_id', id)
        this.setSetting('legacy_imported', '1')
      } else if (command.kind === 'select') {
        if (!this.profiles().some((profile) => profile.id === command.profileId))
          throw new Error('Choose an existing app profile.')
        this.setSetting('active_profile_id', String(command.profileId))
      } else if (command.kind === 'update') {
        const profile = this.requireActive(command.profileId)
        const fields = validateAppProfileFields(command.fields)
        this.db
          .prepare('UPDATE app_profiles SET fields_json = ? WHERE id = ?')
          .run(JSON.stringify(fields), profile.id)
      } else if (command.kind === 'link-taxpayer') {
        const profile = this.requireActive(command.profileId)
        const scope = this.scope()
        if (
          typeof command.taxpayerId !== 'string' ||
          !scope.taxpayers.some((taxpayer) => taxpayer.id === command.taxpayerId)
        )
          throw new Error('Choose an existing saved taxpayer.')
        if (profile.taxpayerId && profile.taxpayerId !== command.taxpayerId)
          throw new Error(
            'This app profile already has a taxpayer. Create another app profile for another taxpayer.'
          )
        if (
          this.profiles().some(
            (entry) => entry.id !== profile.id && entry.taxpayerId === command.taxpayerId
          )
        )
          throw new Error('This taxpayer is already linked to another app profile.')
        this.db
          .prepare('UPDATE app_profiles SET taxpayer_id = ? WHERE id = ?')
          .run(command.taxpayerId, profile.id)
      } else if (command.kind === 'select-tax-year') {
        const appProfile = this.requireActive(command.profileId)
        if (!appProfile.taxpayerId)
          throw new Error('Set up or link a taxpayer for this app profile first.')
        const scope = this.scope()
        const taxpayer = scope.taxpayers.find((entry) => entry.id === appProfile.taxpayerId)
        if (!taxpayer)
          throw new Error('The linked taxpayer is missing. Existing records were retained.')
        const years = new Map((taxpayer.yearProfiles ?? []).map((entry) => [entry.taxYear, entry]))
        // The current settings are saved evidence too, including imported profiles
        // that do not yet have annual history. Never infer answers for a new year.
        years.set(taxpayer.profile.taxYear, taxpayer.profile)
        const selected = Number.isInteger(command.taxYear)
          ? years.get(command.taxYear as number)
          : undefined
        if (!selected) throw new Error('Set up tax information for this year before selecting it.')
        if (taxpayer.profile.taxYear !== selected.taxYear) {
          taxpayer.profile = structuredClone(selected)
          taxpayer.yearProfiles = [...years.values()].sort((a, b) => a.taxYear - b.taxYear)
          this.saveScope(scope)
        }
      } else if (command.kind === 'save-tax') {
        const appProfile = this.requireActive(command.profileId)
        const profile = validateTaxProfile(command.profile)
        const scope = this.scope()
        if (appProfile.taxpayerId) {
          const taxpayer = scope.taxpayers.find((entry) => entry.id === appProfile.taxpayerId)
          if (!taxpayer)
            throw new Error('The linked taxpayer is missing. Existing records were retained.')
          const years = new Map(
            (taxpayer.yearProfiles ?? []).map((entry) => [entry.taxYear, entry])
          )
          years.set(taxpayer.profile.taxYear, taxpayer.profile)
          years.set(profile.taxYear, profile)
          taxpayer.profile = profile
          taxpayer.yearProfiles = [...years.values()].sort((a, b) => a.taxYear - b.taxYear)
        } else {
          const id = randomUUID()
          scope.taxpayers.push({
            id,
            label: appProfileLabel(appProfile, profile.userType),
            profile,
            yearProfiles: [profile]
          })
          this.db
            .prepare('UPDATE app_profiles SET taxpayer_id = ? WHERE id = ?')
            .run(id, appProfile.id)
        }
        this.saveScope(scope)
      } else throw new Error('Unknown app profile command.')
      return this.get()
    })()
  }

  private guardScopeCommand(
    command: Record<string, unknown>,
    scope: TaxScope,
    profile: AppProfile
  ): void {
    if (['taxpayer', 'create-profile'].includes(String(command.kind)))
      throw new Error(
        'Create tax settings from the active app profile. Each app profile has one taxpayer.'
      )
    if (!profile.taxpayerId)
      throw new Error('Set up or link a taxpayer for this app profile first.')
    const taxpayerId = profile.taxpayerId
    if (command.kind === 'select-taxpayer') {
      if (command.taxpayerId !== taxpayerId)
        throw new Error('Switch app profiles to select another taxpayer.')
      return
    }
    const owns = (id: unknown): boolean => id === taxpayerId
    const ownsAccount = (id: unknown): boolean =>
      scope.accounts.some((account) => account.id === id && account.taxpayerId === taxpayerId)
    const owner = (key: unknown): string | undefined =>
      typeof key === 'string' ? recordTaxpayerMap(scope).get(key) : undefined
    if (
      ['history-coverage', 'link-records', 'account', 'bind-source'].includes(
        String(command.kind)
      ) &&
      !owns(command.taxpayerId)
    )
      throw new Error('These tax details belong to another app profile.')
    if (
      ['unbind-source', 'assign'].includes(String(command.kind)) &&
      !ownsAccount(command.accountId)
    )
      throw new Error('Choose an account belonging to the active app profile.')
    if (command.kind === 'assign') {
      const previous = owner(command.recordKey)
      if (previous && previous !== taxpayerId)
        throw new Error('This record belongs to another app profile.')
    }
    if (
      ['unassign', 'clear-enrichment'].includes(String(command.kind)) &&
      !owns(owner(command.recordKey))
    )
      throw new Error('This record does not belong to the active app profile.')
    if (command.kind === 'enrich') {
      const entry = command.enrichment as Record<string, unknown> | null
      if (!entry || !ownsAccount(entry.accountId) || !owns(owner(entry.recordKey)))
        throw new Error('These record details do not belong to the active app profile.')
    }
    if (command.kind === 'preparation-answer') {
      const answer = command.answer as Record<string, unknown> | null
      if (!answer || !owns(answer.taxpayerId))
        throw new Error('This answer belongs to another app profile.')
    }
    if (command.kind === 'disposal-basis') {
      const basis = command.basis as Record<string, unknown> | null
      if (!basis || !owns(basis.taxpayerId) || !owns(owner(basis.recordKey)))
        throw new Error('This cost evidence does not belong to the active app profile.')
    }
  }

  changeTaxScope(input: unknown, records: Set<string>, snapshot?: KasaSnapshot): TaxScope {
    if (!input || typeof input !== 'object') throw new Error('Invalid scope command.')
    const command = input as Record<string, unknown>
    return this.db.transaction(() => {
      const profile = this.active()
      const scope = this.scope()
      this.guardScopeCommand(command, scope, profile)
      scope.activeTaxpayerId = profile.taxpayerId!
      if (command.kind === 'select-taxpayer') return this.getTaxScope()
      if (command.kind === 'bind-source' && !snapshot)
        throw new Error('Saved ledger data is required to link a source.')
      const next =
        command.kind === 'bind-source'
          ? bindLedgerSource(scope, snapshot!, command, randomUUID())
          : changeTaxScope(scope, command, null, records, randomUUID())
      if (command.kind === 'bind-source') {
        const existing = new Set(scope.assignments.map((entry) => entry.recordKey))
        const accounts = new Set(
          next.accounts
            .filter((account) => account.taxpayerId === profile.taxpayerId)
            .map((account) => account.id)
        )
        next.assignments = next.assignments.filter(
          (entry) => existing.has(entry.recordKey) || accounts.has(entry.accountId)
        )
      }
      this.saveScope(next)
      return this.getTaxScope()
    })()
  }

  organise(snapshot: KasaSnapshot): TaxScope {
    return this.db.transaction(() => {
      const profiles = this.profiles()
      const active = profiles.find((profile) => profile.id === this.setting('active_profile_id'))
      if (!active?.taxpayerId) return this.getTaxScope()
      const scope = this.scope()
      const eligible = {
        ...scope,
        accounts: scope.accounts.filter((account) => account.taxpayerId === active.taxpayerId)
      }
      const organised = organiseTaxActivity(eligible, snapshot)
      if (organised !== eligible) this.saveScope({ ...scope, assignments: organised.assignments })
      return this.getTaxScope()
    })()
  }
}
