// Bridge between the Kasa UI (src/UI/index.html) and the backend (window.kasa, see src/preload).
// It fills the screen with real data and replaces the UI's simulated actions with real ones.
// Everything else in the UI (views, animations, demo sections) stays as it is.
import QRCode from 'qrcode'
import { invoicesCsv } from './invoice-csv'
import { invoiceDocumentBody } from '../../shared/invoice-document'
import { searchLedger, taxRecordsCsv } from './ledger'
import { reviewPayment } from './security'
import type { KasaInvoice, KasaSnapshot, KasaStatus } from '../../preload/index.d'

// the UI's own functions (go, toast, openM, closeM, …) are globals defined in index.html
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as unknown as Record<string, any>
const $ = (id: string): HTMLElement | null => document.getElementById(id)
const fmt = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const day = (t: number): string =>
  new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
const toastErr = (title: string, e: unknown): void =>
  w.toast('err', '!', title, esc(errText(e)), 'red')

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
w.exportTaxCSV = async (): Promise<void> => {
  try {
    const current = await window.kasa.snapshot()
    w.downloadFile('tax-records-all-dates.csv', taxRecordsCsv(current), 'text/csv;charset=utf-8;')
    w.toast(
      'tax-csv',
      '✓',
      'Records exported',
      'USDT records only. Tax liability and EUR conversion are not calculated.',
      'blue'
    )
  } catch (e) {
    toastErr('Export failed', e)
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
       <td class="mono" style="color:var(--t1);font-weight:600;">${fmt(i.amount)} USDT</td>
       <td class="mono" style="color:var(--t3);">${day(i.expiresAt)}</td><td>${badge(i)}</td>
       <td style="font-size:11px;color:var(--t3);">${reason(i)}</td></tr>`
        )
        .join('') || empty(6)

  const all = $('inv-table')
  if (all)
    all.innerHTML =
      snap.invoices
        .map(
          (
            i
          ) => `<tr onclick="openInvoice('${i.id}')"><td class="mono">${shortId(i)}</td><td>${clientCell(i)}</td>
       <td class="mono" style="color:var(--t1);font-weight:600;">${fmt(i.amount)} USDT</td>
       <td class="mono" style="color:var(--t3);">${day(i.createdAt)}</td>
       <td class="mono" style="color:var(--t3);">${day(i.expiresAt)}</td><td>${badge(i)}</td>
       <td class="mono" style="font-size:9.5px;color:var(--t3);">${esc(i.recipientId.slice(-8))}</td></tr>`
        )
        .join('') || empty(7)

  const activeFilter = document.querySelector('#view-invoices .ft.on')
  if (activeFilter) w.ft(activeFilter)

  const settled = snap.invoices.filter((i) => ['Paid', 'Overpaid', 'Underpaid'].includes(i.state))
  setText('stat-received', `${fmt(settled.reduce((s, i) => s + i.received, 0))} USDT`)
  setText('stat-paid', String(snap.invoices.filter((i) => i.state === 'Paid').length))
  setText(
    'stat-awaiting',
    String(snap.invoices.filter((i) => ['Issued', 'Pending'].includes(i.state)).length)
  )
  setText('stat-review', String(snap.proposals.filter((p) => p.status === 'open').length))
}

function renderWallet(st: KasaStatus): void {
  walletBalance = st.balance
  setText('w-balance', `${fmt(st.balance)} USDT`)
  setText('w-usdt', `${fmt(st.balance)} USDT`)
  setText('w-btc', `${(st.btcSats / 1e8).toFixed(8)} BTC`)
  setText('w-usdt-id', 'rgb:lX~ToKsO…E9PA_h0 · RGB20')
  setText('send-avail-bal', `${fmt(st.balance)} USDT`)

  const tx = $('w-tx')
  if (!tx) return
  tx.innerHTML =
    snap.payments
      // real movements only: no unpaid invoices (0) and no failed transfers
      .filter((p) => p.received > 0 && p.status !== 'failed')
      .slice(0, 10)
      .map((p) => {
        const inv = snap.invoices.find((i) => i.id === p.invoiceId)
        const txid = p.txid ? `${p.txid.slice(0, 4)}…${p.txid.slice(-4)}` : '—'
        const out = p.direction === 'out'
        const refund = out && snap.proposals.some((x) => x.txid && x.txid === p.txid)
        return `<tr><td class="mono" style="color:var(--t3);">${txid}</td>
        <td style="color:var(${out ? '--red' : '--green'});font-size:12px;font-weight:600;">${out ? '&#x2191; Sent' : '&#x2193; Received'}</td>
        <td class="mono" style="color:var(--t1);font-weight:600;">${out ? '−' : '+'}${fmt(p.received)} USDT</td>
        <td class="mono">${inv ? shortId(inv) : refund ? 'refund' : 'wallet'}</td>
        <td class="mono" style="color:var(--t3);">${p.status}${p.blockTime ? ' · ' + day(p.blockTime) : ''}</td></tr>`
      })
      .join('') ||
    `<tr><td colspan="5" style="color:var(--t3);text-align:center;padding:18px;">No RGB transfers yet</td></tr>`
}

function renderStatus(st: KasaStatus): void {
  const label = st.mock
    ? 'Mock node'
    : {
        online: 'Mutinynet connected',
        syncing: 'Node syncing…',
        locked: 'Node locked',
        offline: 'Node offline'
      }[st.state]
  document.querySelectorAll('.tb-net-pill span:last-child').forEach((e) => (e.textContent = label))
}

let refreshing = false
async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const [st, s] = await Promise.all([window.kasa.status(), window.kasa.snapshot()])
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
  } catch (e) {
    toastErr('Invoice not created', e)
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
  const amount = ($('send-amt-input') as HTMLInputElement | null)?.value.trim() ?? ''
  const invoice = ($('send-addr-input') as HTMLInputElement | null)?.value.trim() ?? ''
  if (!amount || !invoice.startsWith('rgb:'))
    return w.toast('snd', '!', 'Check the form', 'Amount and an rgb: invoice are required', 'red')
  try {
    const r = await reviewPayment({ invoice, amount })
    if (!r) return
    $('send-modal')?.classList.remove('on')
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
    toastErr('Send refused', e)
  }
}

// Publish the invoice and its QR together, and never expose stale data while loading.
let receiveGeneration = 0
let receiveInvoice: { invoice: string; expiresAt: number } | undefined
const receiveButtons = (copy: boolean, fresh: boolean): void => {
  ;($('rcv-copy') as HTMLButtonElement).disabled = !copy
  ;($('rcv-fresh') as HTMLButtonElement).disabled = !fresh
}
async function fillReceive(fresh = false): Promise<void> {
  const generation = ++receiveGeneration
  receiveInvoice = undefined
  receiveButtons(false, false)
  setText('rcv-addr-text', '')
  setText('rcv-qr', '')
  setText('rcv-seal-info', 'Generating receive invoice…')
  try {
    const r = await window.kasa.receive(fresh)
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
    toastErr('No receive invoice', e)
  }
}
w.setReceiveAsset = (asset: string): void => {
  if (asset !== 'usdt') return
  void fillReceive()
}
w.generateFreshSeal = (): Promise<void> => fillReceive(true)
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
      btn.onclick = async (): Promise<void> => {
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
          w.toast(
            'ref',
            '&#x2191;',
            `Refund ${result.state}`,
            'Check Security for settlement progress. Do not resend.',
            'green'
          )
        } catch (e) {
          toastErr('Refund failed', e)
        }
      }
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
setInterval(() => void refresh(), 10_000) // balances can change without an invoice event
void refresh()
