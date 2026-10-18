// Bridge between the Kasa UI (src/UI/index.html) and the backend (window.kasa, see src/preload).
// It fills the screen with real data and replaces the UI's simulated actions with real ones.
// Everything else in the UI (views, animations, demo sections) stays as it is.
import QRCode from 'qrcode'
import { invoiceDetailsCsv, invoicesCsv, transactionsCsv } from './invoice-csv'
import { invoiceDocumentBody } from '../../shared/invoice-document'
import { searchLedger } from './ledger'
import { reviewPayment } from './security'
import type { KasaInvoice, KasaPayment, KasaSnapshot, KasaStatus } from '../../preload/index.d'

// the UI's own functions (go, toast, openM, closeM, …) are globals defined in index.html
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as unknown as Record<string, any>
const $ = (id: string): HTMLElement | null => document.getElementById(id)
// Exposed so the UI's own receipt builder (src/UI/index.html) can mint a real, scannable QR
// without needing its own copy of the qrcode library.
w.generateReceiptQR = (text: string, size = 128): Promise<string> =>
  QRCode.toDataURL(text, { margin: 1, width: size })
const fmt = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const day = (t: number): string =>
  new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
// Bitcoin txid as a link to the Mutinynet explorer (opens in the system browser); stopPropagation
// keeps the wallet row's own click (PDF download) from firing
const TX_EXPLORER = 'https://mutinynet.com/tx/'
const txLink = (txid: string, label: string): string =>
  /^[0-9a-f]{64}$/.test(txid)
    ? `<a href="${TX_EXPLORER}${txid}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()" title="Open on Mutinynet explorer" style="color:inherit;text-decoration:underline;">${label}</a>`
    : '—'
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
const setText = (id: string, v: string): void => {
  const e = $(id)
  if (e) e.textContent = v
}
// IPC errors arrive as "Error invoking remote method 'kasa:send': Error: <message>"
const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
const toastErr = (title: string, e: unknown, retry?: () => void): void =>
  w.toast('err', '!', title, esc(errText(e)), 'red', retry)

const BADGE: Record<string, string> = {
  Issued: 'b-pending',
  Pending: 'b-pending',
  Paid: 'b-paid',
  Overpaid: 'b-overpaid',
  Underpaid: 'b-flagged',
  Expired: 'b-flagged',
  Flagged: 'b-flagged'
}
const badge = (i: KasaInvoice): string =>
  `<span class="badge ${BADGE[i.state] ?? 'b-pending'}">${i.state}</span>`
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
const shortId = (i: KasaInvoice): string => 'INV-' + i.id.slice(0, 6).toUpperCase()

let snap: KasaSnapshot = { invoices: [], proposals: [], payments: [] }
let searchRequest = 0
w.qry = async (): Promise<void> => {
  const request = ++searchRequest
  const query = ($('qi') as HTMLInputElement).value.trim()
  const output = $('qa')!
  output.style.display = 'block'
  output.style.whiteSpace = 'pre-wrap'
  output.textContent = 'Searching recorded invoices and payments…'
  try {
    const current = await window.kasa.snapshot()
    if (request === searchRequest) output.textContent = searchLedger(current, query)
  } catch (e) {
    if (request === searchRequest) output.textContent = `Search failed: ${errText(e)}`
  }
}
let walletBalance = 0

// ---------- rendering ----------

function reason(i: KasaInvoice): string {
  if (i.state === 'Overpaid') return `+${fmt(i.received - i.amount)} USDT excess`
  if (i.state === 'Underpaid') return `${fmt(i.amount - i.received)} USDT missing`
  if (i.state === 'Paid') return `Received ${fmt(i.received)} USDT`
  if (i.state === 'Pending') return 'Confirming on Bitcoin'
  if (i.state === 'Expired') return 'Expired unpaid'
  return 'Awaiting RGB transfer'
}

function clientCell(i: KasaInvoice): string {
  return `<div class="cc"><div class="av">${esc(initials(i.client))}</div><span style="font-weight:500;">${esc(i.client)}</span></div>`
}

// Once money has actually arrived, show what was received (not just what was asked for),
// so the number in the list visibly moves when a payment lands — not only the status badge.
function amountCell(i: KasaInvoice): string {
  if (i.received <= 0) return `${fmt(i.amount)} USDT`
  const sub =
    i.received !== i.amount
      ? `<div style="font-size:10px;font-weight:400;color:var(--t3);">of ${fmt(i.amount)} requested</div>`
      : ''
  return `${fmt(i.received)} USDT${sub}`
}

// money received through Receive (no New Invoice behind it), newest first
const paidRequests = (): KasaPayment[] =>
  snap.payments.filter(
    (p) => p.direction === 'in' && p.received > 0 && p.status !== 'failed' && !p.invoiceId
  )
const requestId = (p: KasaPayment): string =>
  'REQ-' + (p.txid ? p.txid.slice(0, 6).toUpperCase() : String(p.nodeIdx))

function renderInvoices(): void {
  const empty = (cols: number): string =>
    `<tr><td colspan="${cols}" style="color:var(--t3);text-align:center;padding:18px;">No invoices yet</td></tr>`

  const dash = $('dash-invoices')
  if (dash)
    dash.innerHTML =
      snap.invoices
        .slice(0, 6)
        .map(
          (
            i
          ) => `<tr onclick="openInvoice('${i.id}')"><td class="mono">${shortId(i)}</td><td>${clientCell(i)}</td>
       <td class="mono" style="color:var(--t1);font-weight:600;">${amountCell(i)}</td>
       <td class="mono" style="color:var(--t3);">${day(i.expiresAt)}</td><td>${badge(i)}</td>
       <td style="font-size:11px;color:var(--t3);">${reason(i)}</td></tr>`
        )
        .join('') || empty(6)

  // paid Receive requests have no invoice row of their own: list them as paid invoices too
  const requestRows = paidRequests()
    .map(
      (
        p
      ) => `<tr onclick="exportTransactionPdfByNode(${p.nodeIdx})" style="cursor:pointer;" title="Click to download this invoice as PDF"><td class="mono">${requestId(p)}</td><td style="color:var(--t3);">Payment request</td>
       <td class="mono" style="color:var(--t1);font-weight:600;">${fmt(p.received)} USDT</td>
       <td class="mono" style="color:var(--t3);">${p.blockTime ? day(p.blockTime) : '—'}</td>
       <td class="mono" style="color:var(--t3);">—</td><td><span class="badge ${BADGE.Paid ?? 'b-paid'}">Paid</span></td>
       <td class="mono" style="font-size:9.5px;color:var(--t3);">${esc((p.txid ?? '').slice(-8))}</td></tr>`
    )
    .join('')
  const all = $('inv-table')
  if (all)
    all.innerHTML =
      snap.invoices
        .map(
          (
            i
          ) => `<tr onclick="downloadInvoicePdfById('${i.id}')" style="cursor:pointer;" title="Click to download this invoice as PDF"><td class="mono">${shortId(i)}</td><td>${clientCell(i)}</td>
       <td class="mono" style="color:var(--t1);font-weight:600;">${amountCell(i)}</td>
       <td class="mono" style="color:var(--t3);">${day(i.createdAt)}</td>
       <td class="mono" style="color:var(--t3);">${day(i.expiresAt)}</td><td>${badge(i)}</td>
       <td class="mono" style="font-size:9.5px;color:var(--t3);">${esc(i.recipientId.slice(-8))}</td></tr>`
        )
        .join('') + requestRows || empty(7)

  const activeFilter = document.querySelector('#view-invoices .ft.on')
  if (activeFilter) w.ft(activeFilter)

  // Money arrives two ways: New Invoice (an invoice row) and Receive requests (only a payment row),
  // so the cards count incoming payments, not just invoices.
  const incoming = snap.payments.filter((p) => p.direction === 'in')
  const arrived = incoming.filter((p) => p.received > 0 && p.status !== 'failed')
  const needsAttention = snap.invoices.filter((i) =>
    ['Underpaid', 'Overpaid', 'Flagged'].includes(i.state)
  ).length
  setText('stat-received', `${fmt(arrived.reduce((s, p) => s + p.received, 0))} USDT`)
  setText(
    'stat-paid',
    String(
      snap.invoices.filter((i) => i.state === 'Paid').length +
        arrived.filter((p) => !p.invoiceId).length
    )
  )
  const sent = snap.payments.filter(
    (p) => p.direction === 'out' && p.received > 0 && p.status !== 'failed'
  )
  setText('stat-sent', `${fmt(sent.reduce((s, p) => s + p.received, 0))} USDT`)
  const navBadge = $('nav-inv-badge')
  if (navBadge) {
    navBadge.textContent = String(needsAttention)
    navBadge.style.display = needsAttention ? 'inline' : 'none'
  }

  // Invoices page: summary cards, record count, and per-status filter tab counts
  setText('inv-record-count', `${snap.invoices.length + paidRequests().length} Records`)
  // Invoices page cards: New Invoice invoices only
  const settled = snap.invoices.filter((i) => ['Paid', 'Overpaid', 'Underpaid'].includes(i.state))
  const awaiting = snap.invoices.filter((i) => ['Issued', 'Pending'].includes(i.state))
  setText('inv-stat-total', `${fmt(snap.invoices.reduce((s, i) => s + i.amount, 0))} USDT`)
  setText('inv-stat-settled', `${fmt(settled.reduce((s, i) => s + i.received, 0))} USDT`)
  setText('inv-stat-awaiting', `${fmt(awaiting.reduce((s, i) => s + i.amount, 0))} USDT`)

  const settlementDays = settled
    .map((i) => snap.payments.find((p) => p.invoiceId === i.id && p.blockTime))
    .filter((p): p is NonNullable<typeof p> => !!p?.blockTime)
    .map(
      (p) =>
        (p.blockTime! - (settled.find((i) => i.id === p.invoiceId)?.createdAt ?? p.blockTime!)) /
        86400
    )
  setText(
    'inv-stat-avgtime',
    settlementDays.length
      ? `${(settlementDays.reduce((a, b) => a + b, 0) / settlementDays.length).toFixed(1)} Days`
      : '—'
  )

  const upcoming = $('upcoming-due')
  if (upcoming) {
    const dueSoon = snap.invoices
      .filter((i) => ['Issued', 'Pending'].includes(i.state))
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, 5)
    upcoming.innerHTML = dueSoon.length
      ? dueSoon
          .map((i, idx) => {
            const daysLeft = Math.max(0, Math.ceil((i.expiresAt - Date.now() / 1000) / 86400))
            const overdue = i.expiresAt * 1000 <= Date.now()
            const border = idx < dueSoon.length - 1 ? 'border-bottom:1px solid var(--border);' : ''
            return `<div onclick="openInvoice('${i.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;${border}">
              <div class="av">${esc(initials(i.client))}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;font-weight:600;color:var(--t1);">${esc(i.client)}</div>
                <div style="font-size:10px;color:var(--t3);">${shortId(i)} &middot; ${fmt(i.amount)} USDT</div>
              </div>
              <span class="badge ${overdue ? 'b-flagged' : 'b-issued'}" style="font-size:9px;">${overdue ? 'Expired' : `Due in ${daysLeft}d`}</span>
            </div>`
          })
          .join('')
      : '<div style="padding:14px;text-align:center;color:var(--t3);font-size:12px;">No invoices awaiting payment</div>'
  }

  setText('ft-count-all', String(snap.invoices.length + paidRequests().length))
  setText('ft-count-issued', String(snap.invoices.filter((i) => i.state === 'Issued').length))
  setText('ft-count-pending', String(snap.invoices.filter((i) => i.state === 'Pending').length))
  setText(
    'ft-count-paid',
    String(snap.invoices.filter((i) => i.state === 'Paid').length + paidRequests().length)
  )
  setText('ft-count-overpaid', String(snap.invoices.filter((i) => i.state === 'Overpaid').length))
  setText(
    'ft-count-flagged',
    String(
      snap.invoices.filter((i) => ['Underpaid', 'Expired', 'Flagged'].includes(i.state)).length
    )
  )
}

// the transfers currently listed in the wallet tables; a clicked row's data-tx indexes into this
let shownMoves: KasaPayment[] = []

// set while the password is being checked and the wallet opens: "Loading…" instead of "Locked"
let unlocking = false

function renderWallet(st: KasaStatus): void {
  walletBalance = st.state === 'online' ? st.balance : 0
  if (st.state !== 'locked') unlocking = false
  // what to show instead of a number: still loading, locked, or a real problem
  const pending =
    ['syncing', 'timeout'].includes(st.state) || (st.state === 'locked' && unlocking)
      ? 'Loading…'
      : st.state === 'locked'
        ? 'Locked'
        : 'Unavailable'
  // shown balance includes payments on their way; spending (Send → Available) uses settled only
  const shown = st.future ?? st.balance
  setText('w-balance', st.state === 'online' ? `${fmt(shown)} USDT` : pending)
  setText('w-usdt', st.state === 'online' ? `${fmt(shown)} USDT` : pending)
  setText('w-btc', st.state === 'online' ? `${(st.btcSats / 1e8).toFixed(8)} BTC` : pending)
  setText('w-usdt-id', 'rgb:lX~ToKsO…E9PA_h0 · RGB20')
  setText('send-avail-bal', st.state === 'online' ? `${fmt(st.balance)} USDT` : pending)

  // real movements only: no unpaid invoices (0) and no failed transfers
  const moves = snap.payments.filter((p) => p.received > 0 && p.status !== 'failed')
  const txRows = (list: typeof moves): string =>
    list
      .map((p) => {
        const inv = snap.invoices.find((i) => i.id === p.invoiceId)
        const txid = p.txid ? txLink(p.txid, `${p.txid.slice(0, 8)}…${p.txid.slice(-8)}`) : '—'
        const out = p.direction === 'out'
        const refund = out && snap.proposals.some((x) => x.txid && x.txid === p.txid)
        return `<tr data-tx="${moves.indexOf(p)}" style="cursor:pointer;" title="Click to download this transaction as PDF"><td class="mono" style="color:var(--t3);">${txid}</td>
        <td style="color:var(${out ? '--red' : '--green'});font-size:12px;font-weight:600;">${out ? '&#x2191; Sent' : '&#x2193; Received'}</td>
        <td class="mono" style="color:var(--t1);font-weight:600;">${out ? '−' : '+'}${fmt(p.received)} USDT</td>
        <td class="mono">${inv ? shortId(inv) : refund ? 'refund' : 'wallet'}</td>
        <td class="mono" style="color:var(--t3);">${p.status}${p.blockTime ? ' · ' + day(p.blockTime) : ''}</td></tr>`
      })
      .join('') ||
    `<tr><td colspan="5" style="color:var(--t3);text-align:center;padding:18px;">No RGB transfers yet</td></tr>`
  shownMoves = moves
  const tx = $('w-tx')
  if (tx) tx.innerHTML = txRows(moves.slice(0, 10))
  const latest = $('w-tx-latest')
  if (latest) latest.innerHTML = txRows(moves.slice(0, 3))

  // Feed the real payment history to the Cashflow chart (src/UI/index.html) instead of its demo series
  w.__realPayments = snap.payments
  w.renderCashflowSmall?.()
}

function renderStatus(st: KasaStatus): void {
  const label = st.mock
    ? 'Mock node'
    : {
        online: 'Mutinynet connected',
        syncing: 'Node syncing…',
        locked: unlocking ? 'Opening wallet…' : 'Node locked',
        offline: 'Node unreachable',
        timeout: 'Node timed out — retry status check',
        error: 'Node error — inspect diagnostics'
      }[st.state]
  document.querySelectorAll('.tb-net-pill span:last-child').forEach((e) => {
    e.textContent = st.configurationError ? `${label} · payment setup needed` : label
    e.setAttribute('title', st.configurationError ?? st.error ?? '')
  })
}

// Notifies once per transition, comparing against the previous snapshot — never on every poll.
function notifyNewFlags(previous: KasaSnapshot, current: KasaSnapshot): void {
  const prevState = new Map(previous.invoices.map((i) => [i.id, i.state]))
  for (const i of current.invoices) {
    const was = prevState.get(i.id)
    if (was === i.state) continue
    if (i.state === 'Overpaid')
      w.pushNotification(
        '&#x26A0;',
        'Invoice Overpaid',
        `${esc(i.client)} sent extra on ${shortId(i)}.`,
        'amber',
        () => w.openInvoice(i.id)
      )
    else if (i.state === 'Underpaid')
      w.pushNotification(
        '&#x26A0;',
        'Invoice Underpaid',
        `${esc(i.client)} sent less than ${shortId(i)} requires.`,
        'red',
        () => w.openInvoice(i.id)
      )
    else if (i.state === 'Flagged')
      w.pushNotification(
        '&#x2691;',
        'Invoice Flagged',
        `${shortId(i)} needs manual review.`,
        'red',
        () => w.openInvoice(i.id)
      )
    else if (i.state === 'Expired' && was && was !== 'Expired')
      w.pushNotification(
        '&#x23F0;',
        'Invoice Expired',
        `${esc(i.client)}'s ${shortId(i)} expired unpaid.`,
        'amber',
        () => w.openInvoice(i.id)
      )
  }
  const prevProposals = new Set(previous.proposals.map((p) => p.id))
  for (const p of current.proposals) {
    if (p.status !== 'open' || prevProposals.has(p.id)) continue
    const inv = current.invoices.find((i) => i.id === p.invoiceId)
    w.pushNotification(
      '&#x1F916;',
      'Refund Proposed',
      inv
        ? `${p.kind} for ${shortId(inv)}: ${fmt(p.amount)} USDT.`
        : `${p.kind}: ${fmt(p.amount)} USDT.`,
      'blue',
      inv ? () => w.openInvoice(inv.id) : undefined
    )
  }
}

let refreshing = false
let firstRefresh = true
async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const [st, s] = await Promise.all([window.kasa.status(), window.kasa.snapshot()])
    // skip the very first refresh: everything would look "newly" flagged against the empty initial snapshot
    if (!firstRefresh) notifyNewFlags(snap, s)
    firstRefresh = false
    snap = s
    renderStatus(st)
    renderInvoices()
    renderWallet(st)
  } catch (e) {
    console.error('[kasa ui] refresh failed', e)
  } finally {
    refreshing = false
  }
}

// ---------- actions (replace the UI's simulated versions) ----------

// "Approve & Issue RGB Invoice": create a real invoice, then run the UI's own step animation
const uiIssue = w.issueRGB
w.issueRGB = async (): Promise<void> => {
  const client = ($('rv-client') as HTMLInputElement | null)?.value.trim() ?? ''
  const amount = ($('rv-total') as HTMLInputElement | null)?.value.trim() ?? ''
  if (!client || !amount)
    return w.toast('rgb', '!', 'Check the draft', 'Client and total are required', 'red')
  try {
    const inv = await window.kasa.createInvoice(client, amount)
    setText(
      'done-text',
      `${shortId(inv)} for ${client}: ${fmt(Number(amount))} USDT. Awaiting payment on RGB.`
    )
    const box = $('done-invoice')
    if (box)
      box.innerHTML = `<img src="${await QRCode.toDataURL(inv.rgbInvoice, { margin: 1, width: 180 })}" style="border-radius:8px;"/>
        <div class="mono" style="font-size:10px;word-break:break-all;margin-top:10px;color:var(--t2);">${esc(inv.rgbInvoice)}</div>`
    await uiIssue()
    void refresh() // show the new invoice in the Invoices table immediately, instead of waiting for the next poll
  } catch (e) {
    toastErr('Invoice not created', e, () => void w.issueRGB())
  }
}

// Send modal
w.autofillSendAddress = async (): Promise<void> => {
  try {
    const invoice = (await navigator.clipboard.readText()).trim()
    if (!invoice.startsWith('rgb:')) throw new Error('Clipboard does not contain an RGB invoice.')
    const input = $('send-addr-input') as HTMLInputElement | null
    if (input) input.value = invoice
    w.toast(
      'af',
      '✓',
      'Invoice pasted',
      'Review the recipient and amount before submitting.',
      'blue'
    )
  } catch (e) {
    toastErr('Paste failed', e)
  }
}

w.setSendMax = (): void => {
  const input = $('send-amt-input') as HTMLInputElement | null
  if (input) input.value = walletBalance.toFixed(6).replace(/\.?0+$/, '') || '0'
}

w.executeSend = async (): Promise<void> => {
  const amtInput = $('send-amt-input') as HTMLInputElement | null
  const addrInput = $('send-addr-input') as HTMLInputElement | null
  const amount = amtInput?.value.trim() ?? ''
  const invoice = addrInput?.value.trim() ?? ''

  if (amtInput) amtInput.style.borderBottomColor = 'var(--borderB)'
  if (addrInput) addrInput.style.borderColor = 'var(--borderB)'
  const badAmount = !(parseFloat(amount) > 0)
  const badInvoice = !invoice.startsWith('rgb:')
  if (badAmount || badInvoice) {
    if (badAmount && amtInput) amtInput.style.borderBottomColor = 'var(--red)'
    if (badInvoice && addrInput) addrInput.style.borderColor = 'var(--red)'
    return w.toast('snd', '!', 'Check the form', 'Amount and an rgb: invoice are required', 'red')
  }

  const btn = $('btn-confirm-send') as HTMLButtonElement | null
  const resetBtn = (): void => {
    if (!btn) return
    btn.innerHTML = '&#x2191; Sign &amp; Send RGB Transfer'
    btn.style.pointerEvents = 'auto'
  }
  if (btn) {
    btn.innerHTML =
      '<span class="spinner" style="width:14px;height:14px;border-top-color:#fff;margin:0 8px 0 0;display:inline-block;"></span> Reviewing…'
    btn.style.pointerEvents = 'none'
  }

  try {
    // every send goes through the security review gate; the main process refuses direct sends
    const r = await reviewPayment({ invoice, amount })
    resetBtn()
    if (!r) return

    w.saveRecentRecipient?.(invoice)

    // Switch the Send modal over to the success confirmation view
    setText('send-success-amt', `${fmt(parseFloat(amount))} USDT`)
    setText(
      'send-success-to',
      invoice.length > 26 ? `${invoice.slice(0, 14)}…${invoice.slice(-9)}` : invoice
    )
    const txidEl = $('send-success-txid')
    if (txidEl) txidEl.innerHTML = r.txid ? txLink(r.txid, r.txid) : '—'
    const mhdr = $('send-mhdr')
    if (mhdr) mhdr.style.display = 'none'
    const formView = $('send-form-view')
    if (formView) formView.style.display = 'none'
    const successView = $('send-success-view')
    if (successView) successView.style.display = 'block'
    void w.showSendReceipt?.()

    w.toast(
      'snd',
      '&#x2191;',
      `Payment ${r.state}`,
      r.txid
        ? `tx ${r.txid.slice(0, 10)}… · settlement not yet verified`
        : 'Outcome unknown. Check Security; do not resend.',
      'green'
    )
    void refresh()
  } catch (e) {
    resetBtn()
    toastErr('Send refused', e, () => void w.executeSend())
  }
}

// Publish the invoice and its QR together, and never expose stale data while loading.
let receiveGeneration = 0
let receiveInvoice: { invoice: string; expiresAt: number } | undefined
const receiveButtons = (copy: boolean, fresh: boolean): void => {
  const copyBtn = $('rcv-copy') as HTMLButtonElement | null
  const freshBtn = $('rcv-fresh') as HTMLButtonElement | null
  const emailBtn = $('rcv-email-btn') as HTMLButtonElement | null
  if (copyBtn) copyBtn.disabled = !copy
  if (freshBtn) freshBtn.disabled = !fresh
  if (emailBtn) emailBtn.disabled = !copy
}
async function fillReceive(fresh = false, amount?: string): Promise<void> {
  const generation = ++receiveGeneration
  receiveInvoice = undefined
  receiveButtons(false, false)
  setText('rcv-addr-text', '')
  setText('rcv-qr', '')
  setText('rcv-seal-info', 'Generating request invoice…')
  try {
    const r = await window.kasa.receive(fresh, amount)
    if (!r.invoice.startsWith('rgb:') || r.expiresAt * 1000 <= Date.now())
      throw new Error('The node returned an invalid or expired receive invoice.')
    const qr = await QRCode.toString(r.invoice, { type: 'svg', margin: 4 })
    if (generation !== receiveGeneration) return
    $('rcv-qr')!.innerHTML = qr.replace('<svg', '<svg id="rcv-qr-svg" width="100%" height="100%"')
    setText('rcv-addr-text', r.invoice)
    receiveInvoice = r
    receiveButtons(true, true)
    setText(
      'rcv-seal-info',
      `Blinded UTXO · valid until ${new Date(r.expiresAt * 1000).toLocaleTimeString()}`
    )
  } catch (e) {
    if (generation !== receiveGeneration) return
    setText('rcv-seal-info', 'Unable to generate invoice. Try again.')
    receiveButtons(false, true)
    toastErr('No receive invoice', e, () => void fillReceive())
  }
}
const currentReceiveAmount = (): string =>
  (($('rcv-amount') as HTMLInputElement | null)?.value ?? '').trim()
w.setReceiveAsset = (asset: string): void => {
  if (asset !== 'usdt') return
  void fillReceive(false, currentReceiveAmount() || undefined)
}
w.generateFreshSeal = (): Promise<void> => fillReceive(true, currentReceiveAmount() || undefined)
let receiveAmountDebounce: ReturnType<typeof setTimeout> | undefined
w.onReceiveAmountInput = (): void => {
  clearTimeout(receiveAmountDebounce)
  receiveAmountDebounce = setTimeout(
    () => void fillReceive(true, currentReceiveAmount() || undefined),
    500
  )
}
w.openRecv = w.openReceiveModal
w.copyReceiveAddress = async (): Promise<void> => {
  if (!receiveInvoice) return
  if (receiveInvoice.expiresAt * 1000 <= Date.now()) {
    receiveInvoice = undefined
    setText('rcv-qr', '')
    setText('rcv-addr-text', '')
    setText('rcv-seal-info', 'Invoice expired. Generate a fresh invoice.')
    receiveButtons(false, true)
    return
  }
  try {
    await navigator.clipboard.writeText(receiveInvoice.invoice)
    w.toast('rcv-cp', '✓', 'Invoice copied', 'Receive invoice copied to clipboard.', 'green')
  } catch (e) {
    toastErr('Copy failed', e)
  }
}
w.emailReceiveRequest = async (): Promise<void> => {
  if (!receiveInvoice) return
  if (receiveInvoice.expiresAt * 1000 <= Date.now()) {
    w.toast('rcv-em-exp', '!', 'Invoice expired', 'Generate a fresh invoice first.', 'red')
    return
  }
  const to = ($('rcv-email') as HTMLInputElement | null)?.value.trim() ?? ''
  const amount = currentReceiveAmount()
  const subject = `Payment Request${amount ? ` — ${amount} USDT` : ''}`
  const st = await window.kasa.status().catch(() => null)
  const page = st?.payPage ?? 'https://kalepox.github.io/MonteKasa/pay.html'
  const link = `${page}#${encodeURIComponent(receiveInvoice.invoice)}`

  const due = new Date(receiveInvoice.expiresAt * 1000).toLocaleString()
  const body = [
    'Hello,',
    '',
    `please find below a payment request${amount ? ` for ${amount} USDT` : ''}.`,
    '',
    `Amount:      ${amount ? `${amount} USDT` : 'any amount'}`,
    `Valid until: ${due}`,
    'Network:     USDT on RGB (Bitcoin)',
    '',
    'Pay with MonteKasa:',
    link,
    '',
    'Nothing is sent automatically: you review and approve the payment in the app.',
    '',
    'Other RGB wallet? Paste this invoice:',
    receiveInvoice.invoice
  ].join('\n')

  try {
    await window.kasa.emailInvoice(to || undefined, subject, body)
    w.toast(
      'rcv-em',
      '&#x2709;',
      'Email draft opened',
      'Review it in your mail app and hit send.',
      'green'
    )
  } catch (e) {
    toastErr('Could not open mail app', e)
  }
}

w.exportInvoicesCSV = async (): Promise<void> => {
  try {
    const current = await window.kasa.snapshot()
    w.downloadFile('invoices.csv', invoicesCsv(current.invoices), 'text/csv;charset=utf-8;')
    w.toast(
      'csv-exp',
      '✓',
      'CSV exported',
      `${current.invoices.length} invoices exported.`,
      'green'
    )
  } catch (e) {
    toastErr('Export failed', e)
  }
}

w.exportTransactionPdf = async (index: number): Promise<void> => {
  try {
    const payment = shownMoves[index]
    if (!payment) throw new Error('Transaction not found. Refresh and try again.')
    const bytes = await window.kasa.transactionPdf(payment.nodeIdx)
    const name = payment.txid ? payment.txid.slice(0, 12) : `node-${payment.nodeIdx}`
    w.downloadFile(`Transaction_${name}.pdf`, new Uint8Array(bytes), 'application/pdf')
    w.toast('tx-pdf', '✓', 'PDF downloaded', `Transaction ${name} saved as PDF.`, 'green')
  } catch (e) {
    toastErr('PDF export failed', e)
  }
}
w.exportTransactionPdfByNode = async (nodeIdx: number): Promise<void> => {
  const index = shownMoves.findIndex((p) => p.nodeIdx === nodeIdx)
  if (index >= 0) return w.exportTransactionPdf(index)
  toastErr('PDF export failed', new Error('Transaction not found. Refresh and try again.'))
}
w.exportAllTransactionsCSV = (): void => {
  try {
    if (!shownMoves.length) throw new Error('There are no transactions to export yet.')
    // newest first, as listed; the whole recorded history, not just the 10 rows shown
    w.downloadFile('transactions.csv', transactionsCsv(shownMoves, snap), 'text/csv;charset=utf-8;')
    w.toast('tx-csv', '✓', 'CSV exported', `${shownMoves.length} transactions exported.`, 'green')
  } catch (e) {
    toastErr('Export failed', e)
  }
}
for (const id of ['w-tx', 'w-tx-latest'])
  $(id)?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-tx]')
    if (row) void w.exportTransactionPdf(Number(row.dataset.tx))
  })

// Invoice modal: real data + refund approval
let selectedInvoiceId: string | undefined
w.openM = (id: string): void => {
  selectedInvoiceId = undefined
  const invoice = snap.invoices.find((i) => shortId(i) === id)
  if (invoice) void w.openInvoice(invoice.id)
  else
    w.toast(
      'document',
      '!',
      'Invoice unavailable',
      'Open an invoice from the recorded ledger.',
      'red'
    )
}
w.exportCurrentInvoiceCSV = async (): Promise<void> => {
  try {
    const current = await window.kasa.snapshot()
    const invoice = current.invoices.find((i) => i.id === selectedInvoiceId)
    if (!invoice) throw new Error('Open a recorded invoice first.')
    w.downloadFile(`Invoice_${invoice.id}.csv`, invoicesCsv([invoice]), 'text/csv;charset=utf-8;')
  } catch (e) {
    toastErr('Export failed', e)
  }
}
w.downloadInvoicePdf = async (): Promise<void> => {
  try {
    if (!selectedInvoiceId) throw new Error('Open a recorded invoice first.')
    const id = selectedInvoiceId
    const bytes = await window.kasa.invoicePdf(id)
    w.downloadFile(`Invoice_${id}.pdf`, new Uint8Array(bytes), 'application/pdf')
  } catch (e) {
    toastErr('PDF export failed', e)
  }
}
w.downloadInvoicePdfById = async (id: string): Promise<void> => {
  try {
    const invoice = snap.invoices.find((i) => i.id === id)
    if (!invoice) throw new Error('Invoice not found. Refresh and try again.')
    const bytes = await window.kasa.invoicePdf(id)
    w.downloadFile(`Invoice_${shortId(invoice)}.pdf`, new Uint8Array(bytes), 'application/pdf')
    w.toast('inv-pdf', '✓', 'PDF downloaded', `${shortId(invoice)} saved as PDF.`, 'green')
  } catch (e) {
    toastErr('PDF export failed', e)
  }
}
w.exportInvoiceDetailsCSV = async (): Promise<void> => {
  try {
    const current = await window.kasa.snapshot()
    if (!current.invoices.length) throw new Error('There are no invoices to export yet.')
    w.downloadFile('invoice-details.csv', invoiceDetailsCsv(current), 'text/csv;charset=utf-8;')
    w.toast(
      'inv-csv',
      '✓',
      'CSV exported',
      `${current.invoices.length} invoices exported.`,
      'green'
    )
  } catch (e) {
    toastErr('Export failed', e)
  }
}
w.printInvoiceDoc = w.downloadInvoicePdf
w.openInvoice = async (id: string): Promise<void> => {
  const i = snap.invoices.find((x) => x.id === id)
  if (!i) return
  selectedInvoiceId = i.id
  $('modal')?.classList.add('on')
  setText('m-id', `${shortId(i)} Details`)
  document.querySelector('#modal .doc')!.innerHTML = invoiceDocumentBody(i)
  const b = $('m-badge')
  if (b) {
    b.className = `badge ${BADGE[i.state] ?? 'b-pending'}`
    b.textContent = i.state
  }

  const qb = $('qvac-box')
  const qt = $('qvac-text')
  if (!qb || !qt) return
  const btn = qb.querySelector('button') as HTMLButtonElement | null
  const p = snap.proposals.find((x) => x.invoiceId === i.id)
  qb.style.display = 'block'

  if (p) {
    const meta = [
      `Proposal: ${p.status}`,
      p.txid ? `tx ${p.txid.slice(0, 10)}…` : '',
      p.error ? esc(errText(p.error)) : ''
    ]
      .filter(Boolean)
      .join(' · ')
    qt.innerHTML =
      `${esc(p.reason)}<br><span style="color:var(--t3);">${meta}</span>` +
      (p.status === 'open'
        ? `<input id="refund-invoice" class="fi" placeholder="Client's refund rgb: invoice" style="width:100%;margin-top:10px;font-family:monospace;font-size:11px;"/>`
        : '')
    if (btn) {
      btn.style.display = p.status === 'open' ? 'inline-block' : 'none'
      btn.textContent = `Approve refund ${fmt(p.amount)} USDT`
      const approveRefund = async (): Promise<void> => {
        const refund = ($('refund-invoice') as HTMLInputElement | null)?.value.trim() ?? ''
        if (!refund.startsWith('rgb:'))
          return w.toast(
            'ref',
            '!',
            'Refund invoice needed',
            "Paste the client's rgb: invoice",
            'red'
          )
        try {
          const result = await reviewPayment({
            invoice: refund,
            amount: p.amount.toFixed(6),
            proposalId: p.id
          })
          if (!result) return
          w.closeM()
          // don't offer a retry here: the refund may already be submitted, and resending could pay twice
          w.toast(
            'ref',
            '&#x2191;',
            `Refund ${result.state}`,
            'Check Security for settlement progress. Do not resend.',
            'green'
          )
        } catch (e) {
          toastErr('Refund failed', e, () => void approveRefund())
        }
      }
      btn.onclick = (): void => void approveRefund()
    }
  } else if (['Issued', 'Pending'].includes(i.state)) {
    // show the invoice again, so the client can still scan it
    qt.innerHTML = `<img src="${await QRCode.toDataURL(i.rgbInvoice, { margin: 1, width: 160 })}" style="border-radius:6px;"/>
      <div class="mono" style="font-size:10px;word-break:break-all;margin-top:8px;">${esc(i.rgbInvoice)}</div>`
    if (btn) btn.style.display = 'none'
  } else {
    qb.style.display = 'none'
  }
}

// ---------- start ----------
window.kasa.onChanged(() => void refresh())
window.addEventListener('wallet-unlocked', () => void refresh()) // from wallet-gate.ts
window.addEventListener('wallet-unlocking', () => {
  unlocking = true
  for (const id of ['w-balance', 'w-usdt', 'w-btc', 'send-avail-bal']) setText(id, 'Loading…')
  document
    .querySelectorAll('.tb-net-pill span:last-child')
    .forEach((e) => (e.textContent = 'Opening wallet…'))
})
window.addEventListener('wallet-unlock-failed', () => {
  unlocking = false
  void refresh()
})
window.kasa.onPayment((p) => {
  const who = p.client ? `from ${p.client}` : 'to your wallet'
  w.toast(
    'payment-' + Date.now(),
    '&#x2193;',
    'Payment Received',
    `+${fmt(p.amount)} USDT ${who}.`,
    'green'
  )
  w.pushNotification(
    '&#x2193;',
    'Payment Received',
    `+${fmt(p.amount)} USDT ${who}.`,
    'green',
    p.invoiceId ? () => w.openInvoice(p.invoiceId) : undefined
  )
})
setInterval(() => void refresh(), 10_000) // balances can change without an invoice event
void refresh()

// Total Tax card (Wallet page). Empty until the tax side calculates a figure: call
// window.setTaxTotal(1234.5) or window.setTaxTotal(1234.5, 'EUR'), or dispatch
// new CustomEvent('kasa:tax-total', { detail: { amount, currency } }). null clears it back to "—".
w.setTaxTotal = (amount: number | null, currency = 'EUR'): void => {
  const el = $('stat-tax')
  if (!el) return
  el.textContent =
    typeof amount === 'number' && Number.isFinite(amount) ? `${fmt(amount)} ${currency}` : '—'
}
window.addEventListener('kasa:tax-total', (e) => {
  const d = (e as CustomEvent<{ amount: number | null; currency?: string }>).detail
  w.setTaxTotal(d?.amount ?? null, d?.currency)
})
