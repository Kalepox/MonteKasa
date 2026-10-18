import { validateEnrichment, enrichmentGaps, feeGaps, type TaxEnrichment } from './tax-enrichment'
import {
  disposalBasisKey,
  validateDisposalBasis,
  type TaxDisposalBasis
} from './tax-disposal-basis'
import { validateTaxProfile, type TaxProfile } from './tax-profile'
import {
  preparationAnswerKey,
  validatePreparationAnswer,
  type TaxPreparationAnswer
} from './tax-questions'
import type { KasaSnapshot } from '../preload/index.d'
import {
  recordTaxpayerMap,
  validateRecordProfile,
  type TaxRecordProfile
} from './tax-record-profile'

export type Taxpayer = {
  id: string
  label: string
  profile: TaxProfile
  yearProfiles?: TaxProfile[]
}
export type TaxAccount = {
  id: string
  taxpayerId: string
  label: string
  ownershipBps: number | null
  kind: 'self-custody' | 'provider' | 'unknown'
  sourceId?: string
}
export type TaxAsset = {
  id: string
  symbol: string
  canonicalId: string
  network: string
  decimals: number
  environment: 'live' | 'test' | 'unknown'
}
export type TaxAssignment = { recordKey: string; accountId: string; assetId: string }
export type TaxScope = {
  version: 1
  databaseId: string
  activeTaxpayerId?: string
  // Runtime app-profile context. The database-backed app profile registry owns
  // this selection; legacy scope files never supply it as authority.
  appProfileId?: string | null
  taxpayers: Taxpayer[]
  accounts: TaxAccount[]
  assets: TaxAsset[]
  enrichments?: TaxEnrichment[]
  preparationAnswers?: TaxPreparationAnswer[]
  disposalBases?: TaxDisposalBasis[]
  assignments: TaxAssignment[]
  recordProfiles?: TaxRecordProfile[]
  autoAssignmentExclusions?: string[]
}
export type ScopeCommand =
  | { kind: 'taxpayer'; label: string }
  | { kind: 'create-profile'; label: string; profile: TaxProfile }
  | { kind: 'select-taxpayer'; taxpayerId: string }
  | { kind: 'link-records'; taxpayerId: string; recordKeys: string[] }
  | { kind: 'history-coverage'; taxpayerId: string; coverage: TaxProfile['recordsCoverage'] }
  | { kind: 'preparation-answer'; answer: TaxPreparationAnswer }
  | { kind: 'disposal-basis'; basis: TaxDisposalBasis }
  | {
      kind: 'account'
      taxpayerId: string
      label: string
      ownershipBps: number | null
      accountKind: TaxAccount['kind']
    }
  | {
      kind: 'asset'
      symbol: string
      canonicalId: string
      network: string
      decimals: number
      environment: TaxAsset['environment']
    }
  | {
      kind: 'bind-source'
      sourceId: string
      taxpayerId: string
      accountId?: string
      label?: string
      ownershipBps?: number
      accountKind?: TaxAccount['kind']
    }
  | { kind: 'unbind-source'; accountId: string }
  | { kind: 'assign'; recordKey: string; accountId: string; assetId: string }
  | { kind: 'unassign'; recordKey: string }
  | { kind: 'enrich'; enrichment: TaxEnrichment }
  | { kind: 'clear-enrichment'; recordKey: string }
export type TaxActivitySnapshot = { scope: TaxScope; snapshot: KasaSnapshot }
export interface TaxScopeAPI {
  organise(): Promise<TaxActivitySnapshot>
  get(): Promise<TaxScope>
  change(command: ScopeCommand): Promise<TaxScope>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`Enter ${label} (1–200 characters).`)
  return value.trim()
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error(`Invalid ${label}.`)
  return Number(value)
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (!options.includes(value as T)) throw new Error(`Invalid ${label}.`)
  return value as T
}
export function recordKeys(snapshot: KasaSnapshot): Set<string> {
  return new Set([
    ...snapshot.invoices.map((i) => `invoice:${i.id}`),
    ...snapshot.payments.map((p) => `payment:${p.nodeIdx}`)
  ])
}

// No wallet adapter: identifiers describe locally declared scope, not verified ownership.
export function changeTaxScope(
  state: TaxScope,
  input: unknown,
  profile: TaxProfile | null,
  records: Set<string>,
  id: string
): TaxScope {
  if (!input || typeof input !== 'object') throw new Error('Invalid scope command.')
  const c = input as Record<string, unknown>
  const next = structuredClone(state)
  if (c.kind === 'link-records') {
    if (!state.taxpayers.some((taxpayer) => taxpayer.id === c.taxpayerId))
      throw new Error('Select an existing profile.')
    if (c.taxpayerId !== state.activeTaxpayerId)
      throw new Error('The selected profile changed. Reload before linking these records.')
    if (
      !Array.isArray(c.recordKeys) ||
      !c.recordKeys.length ||
      new Set(c.recordKeys).size !== c.recordKeys.length
    )
      throw new Error('Select unique saved records to link.')
    // Validate the entire request before adding any relationships. Existing
    // account assignments and another profile's links remain authoritative.
    const owners = recordTaxpayerMap(state)
    const links = c.recordKeys.map((recordKey) => {
      const link = validateRecordProfile({ recordKey, taxpayerId: c.taxpayerId }, state, owners)
      if (!records.has(link.recordKey))
        throw new Error('The record is not in the current database.')
      return link
    })
    const additions = links.filter((link) => !owners.has(link.recordKey))
    if (additions.length) next.recordProfiles = [...(next.recordProfiles ?? []), ...additions]
  } else if (c.kind === 'disposal-basis') {
    const basis = validateDisposalBasis(c.basis, state, records)
    const key = disposalBasisKey(basis)
    next.disposalBases = [
      ...(next.disposalBases ?? []).filter((entry) => disposalBasisKey(entry) !== key),
      basis
    ]
  } else if (c.kind === 'preparation-answer') {
    const answer = validatePreparationAnswer(c.answer, state.taxpayers)
    if (answer.taxpayerId !== state.activeTaxpayerId)
      throw new Error('The selected profile changed. Reload before saving this answer.')
    const key = preparationAnswerKey(answer)
    next.preparationAnswers = [
      ...(next.preparationAnswers ?? []).filter((entry) => preparationAnswerKey(entry) !== key),
      answer
    ]
  } else if (c.kind === 'history-coverage') {
    const taxpayer = next.taxpayers.find((t) => t.id === c.taxpayerId)
    if (!taxpayer) throw new Error('Select an existing profile.')
    taxpayer.profile.recordsCoverage = choice(
      c.coverage,
      ['unknown', 'incomplete', 'complete'],
      'history coverage'
    )
    if (taxpayer.yearProfiles)
      taxpayer.yearProfiles = taxpayer.yearProfiles.map((profile) =>
        profile.taxYear === taxpayer.profile.taxYear ? { ...taxpayer.profile } : profile
      )
  } else if (c.kind === 'select-taxpayer') {
    if (!state.taxpayers.some((t) => t.id === c.taxpayerId))
      throw new Error('Select an existing profile.')
    next.activeTaxpayerId = String(c.taxpayerId)
  } else if (c.kind === 'create-profile') {
    next.taxpayers.push({
      id,
      label: text(c.label, 'a profile name'),
      profile: validateTaxProfile(c.profile)
    })
    next.activeTaxpayerId = id
  } else if (c.kind === 'taxpayer') {
    if (!profile) throw new Error('Save a tax profile first.')
    next.taxpayers.push({
      id,
      label: text(c.label, 'a taxpayer label'),
      profile: validateTaxProfile(profile)
    })
  } else if (c.kind === 'account') {
    if (!state.taxpayers.some((t) => t.id === c.taxpayerId))
      throw new Error('Select an existing taxpayer.')
    next.accounts.push({
      id,
      taxpayerId: String(c.taxpayerId),
      label: text(c.label, 'an account label'),
      ownershipBps:
        c.ownershipBps === null ? null : integer(c.ownershipBps, 1, 10000, 'ownership share'),
      kind: choice(c.accountKind, ['self-custody', 'provider', 'unknown'], 'account type')
    })
  } else if (c.kind === 'unbind-source') {
    const account = next.accounts.find((a) => a.id === c.accountId)
    if (!account) throw new Error('Select an existing account.')
    delete account.sourceId
  } else if (c.kind === 'asset') {
    const asset: TaxAsset = {
      id,
      symbol: text(c.symbol, 'an asset symbol'),
      canonicalId: text(c.canonicalId, 'the canonical asset identifier'),
      network: text(c.network, 'the network'),
      decimals: integer(c.decimals, 0, 18, 'asset precision'),
      environment: choice(c.environment, ['live', 'test', 'unknown'], 'asset environment')
    }
    if (
      state.assets.some(
        (a) =>
          a.canonicalId === asset.canonicalId &&
          a.network === asset.network &&
          a.environment === asset.environment
      )
    )
      throw new Error('This asset identity is already declared.')
    next.assets.push(asset)
  } else if (c.kind === 'enrich') {
    const enrichment = validateEnrichment(c.enrichment, state, records)
    next.enrichments = [
      ...(state.enrichments ?? []).filter((e) => e.recordKey !== enrichment.recordKey),
      enrichment
    ]
  } else if (c.kind === 'clear-enrichment') {
    if (!records.has(String(c.recordKey))) throw new Error('Record is not in the current database.')
    next.enrichments = (state.enrichments ?? []).filter((e) => e.recordKey !== c.recordKey)
  } else if (c.kind === 'assign' || c.kind === 'unassign') {
    if (!records.has(String(c.recordKey)))
      throw new Error('The record is not in the current database.')
    if (
      c.kind === 'assign' &&
      (!state.accounts.some((a) => a.id === c.accountId) ||
        !state.assets.some((a) => a.id === c.assetId))
    )
      throw new Error('Select an existing account and asset.')
    const previous = state.assignments.find((a) => a.recordKey === c.recordKey)
    if (
      c.kind === 'unassign' ||
      previous?.accountId !== c.accountId ||
      previous?.assetId !== c.assetId
    ) {
      next.enrichments = (state.enrichments ?? [])
        .filter((e) => e.recordKey !== c.recordKey)
        .map((e) => (e.relatedRecordKey === c.recordKey ? { ...e, relatedRecordKey: '' } : e))
    }
    if (c.kind === 'unassign')
      next.autoAssignmentExclusions = [
        ...new Set([...(next.autoAssignmentExclusions ?? []), String(c.recordKey)])
      ]
    else if (next.autoAssignmentExclusions)
      next.autoAssignmentExclusions = next.autoAssignmentExclusions.filter(
        (key) => key !== c.recordKey
      )
    next.assignments = next.assignments.filter((a) => a.recordKey !== c.recordKey)
    if (next.recordProfiles)
      next.recordProfiles = next.recordProfiles.filter((entry) => entry.recordKey !== c.recordKey)
    if (c.kind === 'assign')
      next.assignments.push({
        recordKey: String(c.recordKey),
        accountId: String(c.accountId),
        assetId: String(c.assetId)
      })
  } else throw new Error('Unknown scope command.')
  return next
}

export function scopedRecords(
  state: TaxScope,
  snapshot: KasaSnapshot,
  taxpayerId: string,
  accountId = '',
  assetId = ''
): KasaSnapshot {
  const accounts = new Set(
    state.accounts
      .filter((a) => a.taxpayerId === taxpayerId && (!accountId || a.id === accountId))
      .map((a) => a.id)
  )
  const keys = new Set(
    state.assignments
      .filter((a) => accounts.has(a.accountId) && (!assetId || a.assetId === assetId))
      .map((a) => a.recordKey)
  )
  if (!accountId && !assetId) {
    const owners = recordTaxpayerMap(state)
    for (const relationship of state.recordProfiles ?? [])
      if (owners.get(relationship.recordKey) === taxpayerId) keys.add(relationship.recordKey)
  }
  return {
    invoices: snapshot.invoices.filter((i) => keys.has(`invoice:${i.id}`)),
    payments: snapshot.payments.filter((p) => keys.has(`payment:${p.nodeIdx}`)),
    proposals: []
  }
}

export type Completeness = {
  calculation: string
  status: 'missing-data' | 'unsupported' | 'not-applicable'
  missing: string[]
}
export function calculationCompleteness(
  state: TaxScope,
  snapshot: KasaSnapshot,
  taxpayerId: string,
  accountId = '',
  assetId = ''
): Completeness[] {
  const taxpayer = state.taxpayers.find((t) => t.id === taxpayerId)
  const profile = taxpayer?.profile
  const selected = scopedRecords(state, snapshot, taxpayerId, accountId, assetId)
  const keys = recordKeys(selected)
  const assignments = state.assignments.filter((a) => keys.has(a.recordKey))
  const assets = state.assets.filter((a) => assignments.some((r) => r.assetId === a.id))
  const entries = assignments.map((a) =>
    state.enrichments?.find((e) => e.recordKey === a.recordKey)
  )
  const common: string[] = enrichmentGaps(entries)
  const knownAccounts = new Set(state.accounts.map((account) => account.id))
  const knownAssets = new Set(state.assets.map((asset) => asset.id))
  const fullyAssigned = new Set(
    assignments
      .filter(
        (assignment) =>
          knownAccounts.has(assignment.accountId) && knownAssets.has(assignment.assetId)
      )
      .map((assignment) => assignment.recordKey)
  )
  if (fullyAssigned.size < keys.size)
    common.push(
      'Some records are linked to this profile without account and asset details. Confirm those details and ownership before using them in tax calculations.'
    )
  if (
    state.accounts.some(
      (a) =>
        a.taxpayerId === taxpayerId && (!accountId || a.id === accountId) && a.ownershipBps === null
    )
  )
    common.push('Confirm the ownership share for accounts marked unsure.')
  if (entries.some(Boolean))
    common.push(
      'Enrichment values and evidence references are user supplied and unverified. Links do not prove settlement or exempt transactions from tax; reconcile invoice/payment observations before calculating.'
    )
  if (!profile) common.push('Select a taxpayer with a saved profile.')
  if (!keys.size) common.push('No database records explicitly assigned to this selection.')
  if (assets.some((a) => a.environment === 'test'))
    common.push('Test assets are excluded from monetary tax estimates.')
  if (assets.some((a) => a.environment === 'unknown'))
    common.push('Confirm whether the asset represents real economic activity.')
  common.push(
    'Ownership, asset identity and source precision need evidence; declarations alone are not verification.'
  )
  if (profile?.recordsCoverage !== 'complete')
    common.push('Import missing account history or confirm its coverage.')
  else
    common.push('Declared complete history still needs reconciliation against supporting records.')
  if (selected.payments.some((p) => p.blockTime === null))
    common.push('Some payment dates are missing; determine fiscal recognition separately.')
  if (profile?.businessType === 'unknown') common.push('Confirm the business type.')
  if (profile?.personalRegime === 'unknown' || profile?.businessRegime === 'unknown')
    common.push('Confirm the applicable tax regime.')
  const personal = profile?.userType === 'personal'
  const business = profile?.userType === 'business'
  const rows: [string, boolean, string[]][] = [
    [
      'Personal gains and losses',
      Boolean(personal),
      [
        'Documented acquisition lots and EUR costs, including earlier years.',
        'Disposal classifications and evidenced EUR consideration.',
        'Account-specific tax regime, loss carryforwards, elections and tax already withheld.'
      ]
    ],
    [
      'Annual holding tax',
      true,
      [
        'Historical holdings, ownership periods and EUR valuations.',
        'Stamp duty already paid and supporting statements.'
      ]
    ],
    [
      'Business income',
      Boolean(business),
      [
        'Legal form, fiscal-year dates and accounting policy.',
        'EUR revenue, expenses, book value and tax basis; approved adjustments.'
      ]
    ],
    [
      'VAT',
      Boolean(business),
      [
        'Fiscal invoice lines, supply dates and locations, customer VAT status.',
        'Output/input VAT treatment, credit notes and filing period.'
      ]
    ],
    [
      'Forfettario',
      Boolean(business && profile?.businessRegime === 'forfettario'),
      [
        'Verified eligibility, activity coefficient, total receipts and mandatory contributions.',
        'Cross-border and exceptional VAT obligations require separate review.'
      ]
    ],
    [
      'Transaction fees',
      true,
      [
        ...feeGaps(entries),
        'Verify declared fees and any no-fee declarations against supporting records.',
        'EUR valuation and regime-specific treatment.'
      ]
    ],
    [
      'EU provider and transfer checks',
      true,
      [
        'Provider identity and service involved, or evidence of a direct self-hosted transfer.',
        'Dated authorization/token classification evidence and applicable transfer information.'
      ]
    ]
  ]
  return rows.map(([calculation, applies, missing]) => ({
    calculation,
    status:
      !profile || profile.country !== 'IT'
        ? 'unsupported'
        : !applies
          ? 'not-applicable'
          : 'missing-data',
    missing: !profile
      ? ['Select a taxpayer first.']
      : profile.country !== 'IT'
        ? ['Only Italian taxpayer review is supported.']
        : !applies
          ? ['Not enabled for this declared profile. Recheck if its classification changes.']
          : [...common, ...missing]
  }))
}

// Revalidate persisted declarations and references, including orphaned record IDs.
// Records may disappear from the database; retain those assignments for review.
export function validateTaxScope(input: unknown, databaseId: string): TaxScope {
  if (!input || typeof input !== 'object') throw new Error('Invalid scope file.')
  const source = input as TaxScope
  if (
    source.version !== 1 ||
    source.databaseId !== databaseId ||
    ![source.taxpayers, source.accounts, source.assets, source.assignments].every(Array.isArray)
  )
    throw new Error('Scope file is invalid or belongs to a different database.')
  let state: TaxScope = {
    version: 1,
    databaseId,
    taxpayers: [],
    accounts: [],
    assets: [],
    assignments: []
  }
  const ids = new Set<string>()
  const id = (value: unknown): string => {
    const result = text(value, 'a scope ID')
    if (ids.has(result)) throw new Error('Duplicate scope ID.')
    ids.add(result)
    return result
  }
  for (const t of source.taxpayers) {
    state = changeTaxScope(
      state,
      { kind: 'taxpayer', label: t.label },
      validateTaxProfile(t.profile),
      new Set(),
      id(t.id)
    )
    if (t.yearProfiles !== undefined) {
      if (!Array.isArray(t.yearProfiles)) throw new Error('Invalid annual tax settings.')
      const years = new Set<number>()
      const profiles = t.yearProfiles.map((entry) => {
        const profile = validateTaxProfile(entry)
        if (years.has(profile.taxYear)) throw new Error('Duplicate annual tax settings.')
        years.add(profile.taxYear)
        return profile
      })
      state.taxpayers[state.taxpayers.length - 1].yearProfiles = profiles
    }
  }
  const sourceIds = new Set<string>()
  for (const a of source.accounts) {
    state = changeTaxScope(
      state,
      {
        kind: 'account',
        taxpayerId: a.taxpayerId,
        label: a.label,
        ownershipBps: a.ownershipBps,
        accountKind: a.kind
      },
      null,
      new Set(),
      id(a.id)
    )
    if (a.sourceId !== undefined) {
      if (
        typeof a.sourceId !== 'string' ||
        !a.sourceId.trim() ||
        a.sourceId.length > 2048 ||
        sourceIds.has(a.sourceId)
      )
        throw new Error('Invalid or duplicate source binding.')
      if (a.ownershipBps === null) throw new Error('Source binding requires confirmed ownership.')
      sourceIds.add(a.sourceId)
      state.accounts[state.accounts.length - 1].sourceId = a.sourceId
    }
  }
  for (const a of source.assets)
    state = changeTaxScope(state, { ...a, kind: 'asset' }, null, new Set(), id(a.id))
  const records = new Set<string>()
  for (const a of source.assignments) {
    const key = text(a.recordKey, 'a record key')
    if (!/^(invoice|payment):.+/.test(key) || records.has(key))
      throw new Error('Invalid or duplicate record assignment.')
    records.add(key)
    state = changeTaxScope(state, { ...a, kind: 'assign' }, null, records, '')
  }
  if (source.recordProfiles !== undefined) {
    if (!Array.isArray(source.recordProfiles))
      throw new Error('Invalid record profile relationships.')
    state.recordProfiles = []
    const linked = new Set<string>()
    const owners = recordTaxpayerMap(state)
    for (const relationship of source.recordProfiles) {
      const valid = validateRecordProfile(relationship, state, owners)
      if (linked.has(valid.recordKey)) throw new Error('Duplicate record profile relationship.')
      linked.add(valid.recordKey)
      state.recordProfiles.push(valid)
    }
  }
  if (source.enrichments !== undefined && !Array.isArray(source.enrichments))
    throw new Error('Invalid enrichment list.')
  const enriched = new Set<string>()
  for (const e of source.enrichments ?? []) {
    const valid = validateEnrichment(e, state, records)
    if (enriched.has(valid.recordKey)) throw new Error('Duplicate enrichment.')
    enriched.add(valid.recordKey)
    state.enrichments = [...(state.enrichments ?? []), valid]
  }
  if (source.preparationAnswers !== undefined) {
    if (!Array.isArray(source.preparationAnswers)) throw new Error('Invalid preparation answers.')
    const answered = new Set<string>()
    state.preparationAnswers = []
    for (const answer of source.preparationAnswers) {
      // Preserve earlier years and formerly applicable questions for review. Only
      // a new edit must match the profile's current year and classification.
      const valid = validatePreparationAnswer(answer, state.taxpayers, false)
      const key = preparationAnswerKey(valid)
      if (answered.has(key)) throw new Error('Duplicate preparation answer.')
      answered.add(key)
      state.preparationAnswers.push(valid)
    }
  }
  if (source.disposalBases !== undefined) {
    if (!Array.isArray(source.disposalBases)) throw new Error('Invalid disposal cost evidence.')
    const reviewed = new Set<string>()
    state.disposalBases = []
    for (const basis of source.disposalBases) {
      // Keep prior evidence after profile or assignment changes. The calculator
      // separately checks current ownership and the saved-record fingerprint.
      const valid = validateDisposalBasis(basis, state, records, false)
      const key = disposalBasisKey(valid)
      if (reviewed.has(key)) throw new Error('Duplicate disposal cost evidence.')
      reviewed.add(key)
      state.disposalBases.push(valid)
    }
  }
  if (source.autoAssignmentExclusions !== undefined) {
    if (!Array.isArray(source.autoAssignmentExclusions))
      throw new Error('Invalid assignment exclusions.')
    const excluded = new Set<string>()
    for (const key of source.autoAssignmentExclusions) {
      if (
        typeof key !== 'string' ||
        !/^(invoice|payment):.+/.test(key) ||
        key.length > 200 ||
        excluded.has(key)
      )
        throw new Error('Invalid or duplicate assignment exclusion.')
      excluded.add(key)
    }
    state.autoAssignmentExclusions = [...excluded]
  }
  if (source.activeTaxpayerId !== undefined) {
    if (!state.taxpayers.some((t) => t.id === source.activeTaxpayerId))
      throw new Error('Invalid active profile.')
    state.activeTaxpayerId = source.activeTaxpayerId
  }
  return state
}
