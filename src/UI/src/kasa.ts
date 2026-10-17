// Bridge between the Kasa UI (src/UI/index.html) and the backend (window.kasa, see src/preload).
// It fills the screen with real data and replaces the UI's simulated actions with real ones.
// Everything else in the UI (views, animations, demo sections) stays as it is.
import QRCode from 'qrcode'
import type { KasaInvoice, KasaSnapshot, KasaStatus } from '../../preload/index.d'

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
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
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
          (i) => `<tr onclick="openInvoice('${i.id}')"><td class="mono">${shortId(i)}</td><td>${clientCell(i)}</td>
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
          (i) => `<tr onclick="openInvoice('${i.id}')"><td class="mono">${shortId(i)}</td><td>${clientCell(i)}</td>
       <td class="mono" style="color:var(--t1);font-weight:600;">${fmt(i.amount)} USDT</td>
       <td class="mono" style="color:var(--t3);">${day(i.createdAt)}</td>
       <td class="mono" style="color:var(--t3);">${day(i.expiresAt)}</td><td>${badge(i)}</td>
       <td class="mono" style="font-size:9.5px;color:var(--t3);">${esc(i.recipientId.slice(-8))}</td></tr>`
        )
        .join('') || empty(7)

  const settled = snap.invoices.filter((i) => ['Paid', 'Overpaid', 'Underpaid'].includes(i.state))
  const awaiting = snap.invoices.filter((i) => ['Issued', 'Pending'].includes(i.state))
  setText('stat-received', `${fmt(settled.reduce((s, i) => s + i.received, 0))} USDT`)
  setText('stat-paid', String(snap.invoices.filter((i) => i.state === 'Paid').length))
  setText('stat-awaiting', String(awaiting.length))
  setText('stat-review', String(snap.proposals.filter((p) => p.status === 'open').length))

  // Invoices page: summary cards, record count, and per-status filter tab counts
  setText('inv-record-count', `${snap.invoices.length} Records`)
  setText('inv-stat-total', `${fmt(snap.invoices.reduce((s, i) => s + i.amount, 0))} USDT`)
  setText('inv-stat-settled', `${fmt(settled.reduce((s, i) => s + i.received, 0))} USDT`)
  setText('inv-stat-awaiting', `${fmt(awaiting.reduce((s, i) => s + i.amount, 0))} USDT`)

  const settlementDays = settled
    .map((i) => snap.payments.find((p) => p.invoiceId === i.id && p.blockTime))
    .filter((p): p is NonNullable<typeof p> => !!p?.blockTime)
    .map((p) => (p.blockTime! - (settled.find((i) => i.id === p.invoiceId)?.createdAt ?? p.blockTime!)) / 86400)
  setText(
    'inv-stat-avgtime',
    settlementDays.length
      ? `${(settlementDays.reduce((a, b) => a + b, 0) / settlementDays.length).toFixed(1)} Days`
      : '—'
  )

  setText('ft-count-all', String(snap.invoices.length))
  setText('ft-count-issued', String(snap.invoices.filter((i) => i.state === 'Issued').length))
  setText('ft-count-pending', String(snap.invoices.filter((i) => i.state === 'Pending').length))
  setText('ft-count-paid', String(snap.invoices.filter((i) => i.state === 'Paid').length))
  setText('ft-count-overpaid', String(snap.invoices.filter((i) => i.state === 'Overpaid').length))
  setText(
    'ft-count-flagged',
    String(snap.invoices.filter((i) => ['Underpaid', 'Expired', 'Flagged'].includes(i.state)).length)
  )
}

function renderWallet(st: KasaStatus): void {
  setText('w-balance', `${fmt(st.balance)} USDT`)
  setText('w-usdt', `${fmt(st.balance)} USDT`)
  setText('w-btc', `${(st.btcSats / 1e8).toFixed(8)} BTC`)
  setText('w-usdt-id', 'rgb:lX~ToKsO…E9PA_h0 · RGB20')
  setText('send-avail-bal', `${fmt(st.balance)} USDT`)

  const tx = $('w-tx')
  if (!tx) return
  tx.innerHTML =
    snap.payments
      .filter((p) => p.received > 0)
      .slice(0, 10)
      .map((p) => {
        const inv = snap.invoices.find((i) => i.id === p.invoiceId)
        const txid = p.txid ? `${p.txid.slice(0, 4)}…${p.txid.slice(-4)}` : '—'
        return `<tr><td class="mono" style="color:var(--t3);">${txid}</td>
        <td style="color:var(--green);font-size:12px;font-weight:600;">&#x2193; Received</td>
        <td class="mono" style="color:var(--t1);font-weight:600;">+${fmt(p.received)} USDT</td>
        <td class="mono">${inv ? shortId(inv) : 'wallet'}</td>
        <td class="mono" style="color:var(--t3);">${p.status}${p.blockTime ? ' · ' + day(p.blockTime) : ''}</td></tr>`
      })
      .join('') ||
    `<tr><td colspan="5" style="color:var(--t3);text-align:center;padding:18px;">No RGB transfers yet</td></tr>`

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
  const amount = parseFloat(($('rv-total') as HTMLInputElement | null)?.value ?? '')
  if (!client || !(amount > 0))
    return w.toast('rgb', '!', 'Check the draft', 'Client and total are required', 'red')
  try {
    const inv = await window.kasa.createInvoice(client, amount)
    setText('done-text', `${shortId(inv)} for ${client}: ${fmt(amount)} USDT. Awaiting payment on RGB.`)
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
w.executeSend = async (): Promise<void> => {
  const amtInput = $('send-amt-input') as HTMLInputElement | null
  const addrInput = $('send-addr-input') as HTMLInputElement | null
  const amount = parseFloat(amtInput?.value ?? '')
  const invoice = addrInput?.value.trim() ?? ''

  if (amtInput) amtInput.style.borderBottomColor = 'var(--borderB)'
  if (addrInput) addrInput.style.borderColor = 'var(--borderB)'
  if (!(amount > 0) || !invoice.startsWith('rgb:')) {
    if (!(amount > 0) && amtInput) amtInput.style.borderBottomColor = 'var(--red)'
    if (!invoice.startsWith('rgb:') && addrInput) addrInput.style.borderColor = 'var(--red)'
    return w.toast('snd', '!', 'Check the form', 'Amount and an rgb: invoice are required', 'red')
  }

  const btn = $('btn-confirm-send') as HTMLButtonElement | null
  if (btn) {
    btn.innerHTML =
      '<span class="spinner" style="width:14px;height:14px;border-top-color:#fff;margin:0 8px 0 0;display:inline-block;"></span> Signing…'
    btn.style.pointerEvents = 'none'
  }

  try {
    const r = await window.kasa.send(invoice, amount)
    if (btn) {
      btn.innerHTML = '&#x2191; Sign &amp; Send RGB Transfer'
      btn.style.pointerEvents = 'auto'
    }

    w.saveRecentRecipient?.(invoice)

    // Switch the Send modal over to the success confirmation view
    setText('send-success-amt', `${fmt(amount)} USDT`)
    setText('send-success-to', invoice.length > 26 ? `${invoice.slice(0, 14)}…${invoice.slice(-9)}` : invoice)
    setText('send-success-fee', $('send-fee-summary')?.textContent ?? '—')
    setText('send-success-txid', r.txid ? `${r.txid.slice(0, 10)}…${r.txid.slice(-6)}` : '—')
    const mhdr = $('send-mhdr')
    if (mhdr) mhdr.style.display = 'none'
    const formView = $('send-form-view')
    if (formView) formView.style.display = 'none'
    const successView = $('send-success-view')
    if (successView) successView.style.display = 'block'
    void w.showSendReceipt?.()

    w.toast(
      'snd',
      '&#x2713;',
      `Sent ${fmt(amount)} USDT`,
      `tx ${r.txid.slice(0, 10)}… · waiting for the receiver`,
      'green'
    )
    void refresh()
  } catch (e) {
    if (btn) {
      btn.innerHTML = '&#x2191; Sign &amp; Send RGB Transfer'
      btn.style.pointerEvents = 'auto'
    }
    toastErr('Send refused', e, () => void w.executeSend())
  }
}

// Receive modal: real invoice + real QR (the BTC tab keeps the UI's demo content for now)
async function fillReceive(): Promise<void> {
  try {
    const r = await window.kasa.receive()
    setText('rcv-addr-text', r.invoice)
    const svg = $('rcv-qr-svg')
    if (svg?.parentElement)
      svg.parentElement.innerHTML = (await QRCode.toString(r.invoice, { type: 'svg', margin: 0 })).replace(
        '<svg',
        '<svg id="rcv-qr-svg" width="100%" height="100%"'
      )
    setText('rcv-seal-info', `Blinded UTXO · valid until ${new Date(r.expiresAt * 1000).toLocaleTimeString()}`)
  } catch (e) {
    toastErr('No receive invoice', e, () => void fillReceive())
  }
}
const uiSetReceiveAsset = w.setReceiveAsset
w.setReceiveAsset = (asset: string): void => {
  uiSetReceiveAsset?.(asset)
  if (asset === 'usdt') void fillReceive()
}

// Invoice modal: real data + refund approval
w.openInvoice = async (id: string): Promise<void> => {
  const i = snap.invoices.find((x) => x.id === id)
  if (!i) return
  w.openM('INV-0009') // let the UI open and lay out the modal, then overwrite the fields
  setText('m-id', `${shortId(i)} Details`)
  setText('doc-id', shortId(i))
  setText('doc-date', new Date(i.createdAt * 1000).toDateString())
  setText('doc-due', new Date(i.expiresAt * 1000).toDateString())
  setText('doc-amt', `${fmt(i.amount)} USDT`)
  setText('doc-pay-amt', `${fmt(i.amount)} USDT`)
  const to = $('doc-to')
  if (to) to.innerHTML = `<strong>${esc(i.client)}</strong>`
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
          return w.toast('ref', '!', 'Refund invoice needed', "Paste the client's rgb: invoice", 'red')
        try {
          await window.kasa.approve(p.id, refund)
          const after = (await window.kasa.snapshot()).proposals.find((x) => x.id === p.id)
          w.closeM()
          if (after?.status === 'executed')
            w.toast('ref', '&#x2191;', 'Refund sent', `${fmt(p.amount)} USDT · waiting for the client`, 'green')
          else toastErr('Refund failed', after?.error ?? 'unknown error', () => void approveRefund())
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
setInterval(() => void refresh(), 10_000) // balances can change without an invoice event
void refresh()
