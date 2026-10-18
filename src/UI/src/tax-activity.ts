import {
  activityRows,
  formatLedgerAmount,
  observedSources,
  type TaxActivityRow
} from '../../shared/tax-activity'
import { readLedgerSource } from '../../shared/ledger-source'
import { recordKeys, type ScopeCommand, type TaxActivitySnapshot } from '../../shared/tax-scope'
import { recordTaxpayerMap } from '../../shared/tax-record-profile'

const el = (id: string): HTMLElement => document.getElementById(id)!
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement
const select = (id: string): HTMLSelectElement => el(id) as HTMLSelectElement
const root = el('view-tax')
const form = el('tax-source-form') as HTMLFormElement
let data: TaxActivitySnapshot | undefined
let signature = ''
let busy = false
let queued = false
let limit = 100
let formTaxpayerId = ''
let unlinkedCount = 0
const editingRecord = (): boolean =>
  root.dataset.enrichmentDirty === 'true' ||
  root.dataset.taxQuestionsDirty === 'true' ||
  root.dataset.taxBasisDirty === 'true'
const blocked = (): boolean => editingRecord() || !form.hidden || root.dataset.scopeBusy === 'true'
const message = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function pending(): void {
  el('tax-activity-pending').hidden = !queued || !blocked()
}
function sourceEditing(editing: boolean): void {
  root.dataset.activityEditing = String(editing)
  window.dispatchEvent(new CustomEvent('kasa:tax-activity-editing', { detail: { editing } }))
}
function controls(): void {
  input('tax-activity-refresh').disabled = busy
  input('tax-activity-link-profile').disabled =
    busy ||
    blocked() ||
    !data?.scope.taxpayers.some((item) => item.id === data!.scope.activeTaxpayerId) ||
    !unlinkedCount
  ;(el('tax-source-fields') as HTMLFieldSetElement).disabled = busy
  for (const button of el('tax-activity-sources').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = busy || blocked() || button.dataset.unavailable === 'true'
}
function accountFields(): void {
  const fresh = select('tax-source-account').value === 'new'
  el('tax-source-new-account').hidden = !fresh
  input('tax-source-label').disabled = !fresh
  select('tax-source-ownership').disabled = !fresh
  const partial = fresh && select('tax-source-ownership').value === 'partial'
  el('tax-source-share-field').hidden = !partial
  input('tax-source-share').disabled = !partial
  input('tax-source-share').required = partial
  const account = data?.scope.accounts.find(
    (item) => item.id === select('tax-source-account').value
  )
  el('tax-source-account-help').textContent = account
    ? `The saved account’s ownership (${account.ownershipBps === null ? 'not confirmed' : `${account.ownershipBps / 100}%`}) and other declarations are retained.`
    : 'If ownership varies between records, leave the source unlinked and review those records individually.'
}
function openSource(sourceId: string): void {
  if (!data || busy || blocked()) return
  const taxpayer = data.scope.taxpayers.find((item) => item.id === data!.scope.activeTaxpayerId)
  const observed = observedSources(data.snapshot).find((item) => item.source.id === sourceId)
  if (!taxpayer || !observed || observed.conflict) return
  formTaxpayerId = taxpayer.id
  form.reset()
  input('tax-source-id').value = sourceId
  input('tax-source-label').value = observed.source.label.slice(0, 200)
  const accounts = select('tax-source-account')
  accounts.replaceChildren(new Option('Create an account for this source', 'new'))
  for (const account of data.scope.accounts.filter(
    (item) => item.taxpayerId === taxpayer.id && !item.sourceId
  )) {
    const option = new Option(
      `${account.label}${account.ownershipBps === null ? ' · ownership needs review' : ''}`,
      account.id
    )
    option.disabled = account.ownershipBps === null
    accounts.append(option)
  }
  el('tax-source-context').textContent =
    `${observed.source.label} → ${taxpayer.label} · tax review ${taxpayer.profile.taxYear}. Ownership applies to recorded history; it does not determine the year in which tax is due.`
  el('tax-source-status').textContent = ''
  form.hidden = false
  sourceEditing(true)
  accountFields()
  controls()
  select('tax-source-account').focus()
}
function renderSources(): void {
  if (!data) return
  const container = el('tax-activity-sources')
  container.replaceChildren()
  const sources = observedSources(data.snapshot)
  if (!sources.length) {
    const note = document.createElement('p')
    note.textContent =
      'No saved source identity is available yet. Older activity is shown below for review; its account, asset and network are not guessed from today’s configuration.'
    container.append(note)
  }
  for (const item of sources) {
    const { source } = item
    const account = data.scope.accounts.find((candidate) => candidate.sourceId === source.id)
    const owner = data.scope.taxpayers.find((candidate) => candidate.id === account?.taxpayerId)
    const card = document.createElement('div')
    card.className = 'tax-source-card'
    card.dataset.sourceId = source.id
    const title = document.createElement('strong')
    title.textContent = source.label
    const description = document.createElement('p')
    description.textContent = `${source.asset.symbol} · ${source.asset.network} · ${source.asset.environment === 'test' ? 'Test activity' : source.asset.environment === 'live' ? 'Real-network source' : 'Environment needs review'} · ${item.paymentCount} payment records`
    const status = document.createElement('p')
    status.textContent = item.conflict
      ? 'Conflicting source metadata. Automatic organisation is paused for this source.'
      : account
        ? `Linked to ${owner?.label ?? 'saved profile'} / ${account.label}. Existing assignments are retained.`
        : 'Ownership not confirmed. These records remain unassigned unless already reviewed.'
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'btn btn-s'
    if (account) {
      action.dataset.unbindAccount = account.id
      action.textContent = 'Stop automatic link'
      action.dataset.unavailable = String(account.taxpayerId !== data.scope.activeTaxpayerId)
      action.onclick = () => {
        void change({ kind: 'unbind-source', accountId: account.id })
      }
    } else {
      action.dataset.bindSource = source.id
      action.textContent = 'Confirm owner'
      action.dataset.unavailable = String(item.conflict || !data.scope.activeTaxpayerId)
      action.onclick = () => openSource(source.id)
    }
    card.append(title, description, status, action)
    container.append(card)
  }
  controls()
}

function reviewText(row: TaxActivityRow): string {
  const source = readLedgerSource((row.payment ?? row.invoice)?.source)
  const notes: string[] = []
  if (!row.taxpayerId) notes.push('Profile link needed')
  if (!row.assignment) notes.push('Account and asset details needed')
  if (!source) notes.push('Source identity missing')
  if (row.environment === 'test') notes.push('Test activity — excluded from tax estimates')
  else if (row.environment === 'unknown') notes.push('Real/test identity needs review')
  if (row.status === 'pending') notes.push('Settlement pending')
  if (row.status === 'failed') notes.push('Failed observation — no settled payment')
  if (row.status === 'unknown') notes.push('Payment status needs review')
  if (row.kind === 'request') notes.push('Payment request, not a receipt')
  if (data?.scope.autoAssignmentExclusions?.includes(row.recordKey))
    notes.push('Automatic assignment disabled for this record')
  const asset = data?.scope.assets.find((item) => item.id === row.assignment?.assetId)
  if (
    source &&
    asset &&
    (asset.canonicalId !== source.asset.canonicalId ||
      asset.network !== source.asset.network ||
      asset.decimals !== source.asset.decimals ||
      asset.environment !== source.asset.environment)
  )
    notes.push('Saved assignment differs from source identity; existing details retained')
  return notes.join(' · ') || 'Purpose, EUR value and tax treatment still need review'
}
function renderRows(): void {
  if (!data) return
  const { scope, snapshot } = data
  const mode = select('tax-activity-filter').value
  const rows = activityRows(
    scope,
    snapshot,
    mode === 'all' ? undefined : (scope.activeTaxpayerId ?? ''),
    mode === 'profile'
  )
  const body = el('tax-activity-rows')
  body.replaceChildren()
  for (const row of rows.slice(0, limit)) {
    const tr = document.createElement('tr')
    tr.dataset.recordKey = row.recordKey
    tr.dataset.activityStatus = row.status
    const activity = document.createElement('td')
    const title = document.createElement('strong')
    title.textContent = row.payment
      ? row.payment.direction === 'in'
        ? 'Received'
        : 'Sent'
      : 'Payment requested'
    activity.append(title)
    const reference = document.createElement('small')
    reference.textContent = `${row.recordKey}${row.payment && row.invoice ? ` · linked invoice ${row.invoice.id}` : ''}`
    activity.append(reference)
    const date = document.createElement('small')
    const time = row.payment ? row.payment.blockTime : row.invoice?.createdAt
    date.textContent =
      typeof time === 'number' && Number.isFinite(time)
        ? new Date(time * 1000).toLocaleDateString(undefined, { timeZone: 'Europe/Rome' })
        : 'Date not recorded'
    activity.append(date)
    const amount = document.createElement('td')
    amount.textContent = formatLedgerAmount(row)
    const status = document.createElement('td')
    status.textContent = row.status === 'request' ? (row.invoice?.state ?? 'Request') : row.status
    const ownership = document.createElement('td')
    ownership.textContent =
      scope.taxpayers.find((item) => item.id === row.taxpayerId)?.label ?? 'Unassigned'
    const review = document.createElement('td')
    review.textContent = reviewText(row)
    tr.append(activity, amount, status, ownership, review)
    body.append(tr)
  }
  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 5
    cell.textContent =
      mode === 'assigned'
        ? 'No activity is linked to this profile yet.'
        : 'No saved activity matches this view.'
    row.append(cell)
    body.append(row)
  }
  const payments = rows.filter((row) => row.kind === 'payment')
  el('tax-activity-summary').textContent =
    `${payments.length} payments · ${rows.length - payments.length} unmatched requests · ${rows.filter((row) => !row.taxpayerId).length} without a profile · ${rows.filter((row) => !row.assignment).length} need account or asset details${rows.length > limit ? ` · showing ${limit} of ${rows.length}` : ''}`
  el('tax-activity-more').hidden = rows.length <= limit
}

async function refresh(): Promise<void> {
  queued = true
  pending()
  if (busy || blocked()) return
  busy = true
  controls()
  try {
    while (queued && !blocked()) {
      queued = false
      const next = await window.taxScope.organise()
      if (blocked()) {
        queued = true
        break
      }
      const nextSignature = JSON.stringify(next)
      data = next
      const owners = recordTaxpayerMap(next.scope)
      unlinkedCount = [...recordKeys(next.snapshot)].filter((key) => !owners.has(key)).length
      if (signature !== nextSignature) {
        signature = nextSignature
        renderSources()
        renderRows()
      }
      window.dispatchEvent(new CustomEvent('kasa:tax-activity-updated', { detail: next }))
      el('tax-activity-status').textContent =
        'Updated from this device’s saved ledger. Confirmed source links organise unassigned records; original payments and existing tax details stay unchanged.'
    }
  } catch (error) {
    el('tax-activity-status').textContent =
      `Activity could not be refreshed: ${message(error)}. Saved records and open edits are retained. Retry when ready.`
  } finally {
    busy = false
    controls()
    pending()
  }
}
async function change(command: ScopeCommand): Promise<void> {
  if (busy || editingRecord() || root.dataset.scopeBusy === 'true') return
  busy = true
  controls()
  try {
    await window.taxScope.change(command)
    form.hidden = true
    sourceEditing(false)
    signature = ''
    el('tax-activity-status').textContent =
      command.kind === 'unbind-source'
        ? 'Automatic link stopped. Existing assignments and tax details are retained.'
        : 'Source ownership saved. Matching unassigned records are now organised.'
  } catch (error) {
    el(form.hidden ? 'tax-activity-status' : 'tax-source-status').textContent =
      `Could not save: ${message(error)}. Your answers are retained.`
    return
  } finally {
    busy = false
    controls()
  }
  await refresh()
}

async function linkProfile(): Promise<void> {
  if (!data || busy || blocked()) return
  const taxpayerId = data.scope.activeTaxpayerId
  if (!taxpayerId || !data.scope.taxpayers.some((item) => item.id === taxpayerId)) return
  const databaseId = data.scope.databaseId
  const savedKeys = recordKeys(data.snapshot)
  busy = true
  sourceEditing(true)
  controls()
  try {
    const current = await window.taxScope.get()
    if (current.databaseId !== databaseId || current.activeTaxpayerId !== taxpayerId)
      throw new Error('The selected profile changed. Refresh activity and try again')
    const owners = recordTaxpayerMap(current)
    const unlinked = [...savedKeys].filter((key) => !owners.has(key))
    if (unlinked.length)
      await window.taxScope.change({ kind: 'link-records', taxpayerId, recordKeys: unlinked })
    signature = ''
  } catch (error) {
    el('tax-activity-status').textContent =
      `Could not link activity: ${message(error)}. Existing profile links and payments are retained.`
    return
  } finally {
    busy = false
    sourceEditing(false)
    controls()
  }
  await refresh()
}
form.onsubmit = (event) => {
  event.preventDefault()
  if (!form.reportValidity() || busy || !data || root.dataset.scopeBusy === 'true') return
  if (data.scope.activeTaxpayerId !== formTaxpayerId) {
    el('tax-source-status').textContent =
      'The selected profile changed. Cancel and review ownership again.'
    return
  }
  const accountId = select('tax-source-account').value
  if (accountId !== 'new') {
    void change({
      kind: 'bind-source',
      sourceId: input('tax-source-id').value,
      taxpayerId: formTaxpayerId,
      accountId
    })
    return
  }
  const ownership = select('tax-source-ownership').value
  const percentage = Number(input('tax-source-share').value)
  if (
    ownership === 'unknown' ||
    (ownership === 'partial' &&
      (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100))
  ) {
    el('tax-source-status').textContent =
      'Confirm a fixed ownership share, or cancel and leave these records for individual review.'
    return
  }
  void change({
    kind: 'bind-source',
    sourceId: input('tax-source-id').value,
    taxpayerId: formTaxpayerId,
    label: input('tax-source-label').value.trim(),
    ownershipBps: ownership === 'full' ? 10000 : Math.round(percentage * 100),
    accountKind: 'unknown'
  })
}
select('tax-source-account').onchange = accountFields
select('tax-source-ownership').onchange = accountFields
el('tax-source-cancel').onclick = () => {
  if (busy) return
  form.hidden = true
  sourceEditing(false)
  void refresh()
  el('tax-activity-refresh').focus()
}
el('tax-activity-refresh').onclick = () => {
  void refresh()
}
el('tax-activity-link-profile').onclick = () => {
  void linkProfile()
}
select('tax-activity-filter').onchange = () => {
  limit = 100
  renderRows()
}
el('tax-activity-more').onclick = () => {
  limit += 100
  renderRows()
}
for (const event of ['kasa:tax-scope-updated', 'kasa:tax-profile-saved'])
  window.addEventListener(event, () => {
    void refresh()
  })
window.addEventListener('kasa:tax-questions-dirty', () => {
  controls()
  if (!editingRecord() && queued) void refresh()
})
window.addEventListener('kasa:tax-basis-dirty', () => {
  controls()
  if (!editingRecord() && queued) void refresh()
})
window.addEventListener('kasa:tax-enrichment-dirty', () => {
  controls()
  if (!editingRecord() && queued) void refresh()
})
window.addEventListener('kasa:tax-scope-idle', () => {
  controls()
  if (queued) void refresh()
})
window.addEventListener('kasa:tax-scope-busy', controls)
const unsubscribe = window.kasa.onChanged(() => {
  void refresh()
})
window.addEventListener('beforeunload', unsubscribe)
void refresh()
