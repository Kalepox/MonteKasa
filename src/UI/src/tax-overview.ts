import { recordKeys, scopedRecords, type TaxScope } from '../../shared/tax-scope'
import { valuationComplete } from '../../shared/tax-enrichment'
import type { KasaSnapshot } from '../../preload/index.d'

export function taxOverview(
  state: TaxScope,
  snapshot: KasaSnapshot,
  taxpayerId: string
): {
  accounts: number
  assets: number
  invoices: number
  payments: number
  unassigned: number
  orphaned: number
  unknownOwnership: number
  testAssets: number
  unknownAssets: number
  missing: { classification: string[]; valuation: string[]; fees: string[]; links: string[] }
} {
  const accounts = state.accounts.filter((a) => a.taxpayerId === taxpayerId)
  const accountIds = new Set(accounts.map((a) => a.id))
  const selected = scopedRecords(state, snapshot, taxpayerId)
  const keys = recordKeys(selected)
  const known = recordKeys(snapshot)
  const owned = state.assignments.filter((a) => accountIds.has(a.accountId))
  const assetIds = new Set(owned.filter((a) => keys.has(a.recordKey)).map((a) => a.assetId))
  const assets = state.assets.filter((a) => assetIds.has(a.id))
  const missing: ReturnType<typeof taxOverview>['missing'] = {
    classification: [],
    valuation: [],
    fees: [],
    links: []
  }
  for (const key of keys) {
    const e = state.enrichments?.find((item) => item.recordKey === key)
    if (!e || e.classification === 'unknown') missing.classification.push(key)
    if (!e || !valuationComplete(e.valuation)) missing.valuation.push(key)
    if (
      !e ||
      e.fee.status === 'unknown' ||
      (e.fee.status === 'recorded' &&
        (!e.fee.purpose || !e.fee.reference || !valuationComplete(e.fee.valuation)))
    )
      missing.fees.push(key)
    if (
      e &&
      ['own-transfer', 'refund'].includes(e.classification) &&
      (!e.relatedRecordKey || !known.has(e.relatedRecordKey))
    )
      missing.links.push(key)
  }
  return {
    accounts: accounts.length,
    assets: assets.length,
    invoices: selected.invoices.length,
    payments: selected.payments.length,
    unassigned: [...known].filter((key) => !state.assignments.some((a) => a.recordKey === key))
      .length,
    orphaned: owned.filter((a) => !known.has(a.recordKey)).length,
    unknownOwnership: accounts.filter((a) => a.ownershipBps === null).length,
    testAssets: assets.filter((a) => a.environment === 'test').length,
    unknownAssets: assets.filter((a) => a.environment === 'unknown').length,
    missing
  }
}
