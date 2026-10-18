import type { KasaInvoice, KasaPayment } from '../preload/index.d'

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c]!
  )

export function invoiceDocumentBody(i: KasaInvoice): string {
  return `<h1>Invoice record</h1>
    <p id="doc-id">${escape(i.id)}</p>
    <h2>Client</h2><p id="doc-to">${escape(i.client)}</p>
    <table><tbody>
    <tr><th>Issued (UTC)</th><td>${new Date(i.createdAt * 1000).toISOString()}</td></tr>
    <tr><th>Expires (UTC)</th><td>${new Date(i.expiresAt * 1000).toISOString()}</td></tr>
    <tr><th>Invoice amount</th><td id="doc-amt">${i.amount.toFixed(6)} USDT</td></tr>
    <tr><th>Recorded received amount</th><td>${i.received.toFixed(6)} USDT</td></tr>
    <tr><th>Recorded payment state</th><td>${escape(i.state)}</td></tr>
    </tbody></table>
    <p>Payment state reflects the local ledger at export time. It is not an independent settlement proof.</p>
    <p>Issuer details, item descriptions and tax treatment are not recorded. This is an invoice record, not a validated tax invoice.</p>`
}

// Billing addresses are not recorded, so each invoice gets a stable sample address in Turin.
const TURIN_STREETS = [
  'Via Roma',
  'Via Po',
  'Corso Vittorio Emanuele II',
  'Via Giuseppe Garibaldi',
  'Corso Francia',
  'Via Nizza',
  'Corso Re Umberto',
  'Via Pietro Micca',
  'Corso Unione Sovietica',
  'Via Madama Cristina',
  'Via Lagrange',
  'Corso Giulio Cesare',
  'Via Cernaia',
  'Corso Regina Margherita'
]
export function turinAddress(seed: string): string {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  const street = TURIN_STREETS[h % TURIN_STREETS.length]
  const number = 1 + ((h >>> 8) % 120)
  const cap = 10121 + ((h >>> 16) % 36) // Turin postcodes run 10121–10156
  return `${street} ${number}\n${cap} Torino (TO)\nItalia`
}

const utc = (t: number): string => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
const rome = (t: number): string =>
  new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Rome', dateStyle: 'medium', timeStyle: 'medium' })

export function invoiceDocumentHtml(i: KasaInvoice, payments: KasaPayment[] = []): string {
  const number = 'INV-' + i.id.slice(0, 6).toUpperCase()
  const mine = payments.filter((p) => p.invoiceId === i.id && p.received > 0 && p.status !== 'failed')
  const balance = i.amount - i.received
  const payRows = mine
    .map(
      (p) => `<tr><td>${p.blockTime ? `${utc(p.blockTime)}<br><span class="m">${escape(rome(p.blockTime))} (Rome)</span>` : 'Awaiting confirmation'}</td>
      <td class="mono">${escape(p.txid ?? '—')}</td><td class="r">${p.received.toFixed(6)} USDT</td><td>${escape(p.status)}</td></tr>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>@page{size:A4;margin:18mm}body{font:12px/1.55 Arial,sans-serif;color:#18212d;margin:0}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #18212d;padding-bottom:14px}
  .brand{font-size:22px;font-weight:800;letter-spacing:-.5px}.sub{color:#455568;font-size:11px}
  .doc{text-align:right}.doc h1{font-size:20px;margin:0 0 2px}.badge{display:inline-block;margin-top:6px;padding:2px 10px;border:1px solid #18212d;border-radius:12px;font-size:11px;font-weight:700}
  .cols{display:flex;gap:40px;margin:24px 0}.cols>div{flex:1}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#455568;margin:0 0 6px}
  p{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;margin:8px 0 20px}
  th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:#455568;border-bottom:1px solid #18212d;padding:8px 6px}
  td{padding:9px 6px;border-bottom:1px solid #d5dbe2;vertical-align:top;overflow-wrap:anywhere}
  .r{text-align:right;white-space:nowrap}.mono{font-family:Menlo,Courier,monospace;font-size:10px}.m{color:#6b7785;font-size:10.5px}
  .dt{margin:0}.dt td{padding:2px 0;border:0}.dt td:last-child{text-align:right}
  .tot{width:55%;margin-left:auto}.tot td{border:0;padding:4px 6px}.tot .g td{border-top:2px solid #18212d;font-weight:700;font-size:14px;padding-top:9px}
  tr{break-inside:avoid}.foot{margin-top:26px;color:#6b7785;font-size:10px;border-top:1px solid #d5dbe2;padding-top:10px}</style></head>
  <body>
  <div class="top"><div><div class="brand">MonteKasa</div><div class="sub">Self-custodial invoicing · USDT on Bitcoin (RGB)</div></div>
    <div class="doc"><h1>Invoice ${escape(number)}</h1><div class="sub" id="doc-id">${escape(i.id)}</div><div class="badge">${escape(i.state).toUpperCase()}</div></div></div>
  <div class="cols">
    <div><h2>Billed to</h2><p id="doc-to"><b>${escape(i.client)}</b>\n${escape(turinAddress(i.id))}</p></div>
    <div><h2>Details</h2><table class="dt"><tbody>
      <tr><td>Issued</td><td>${utc(i.createdAt)}</td></tr>
      <tr><td>Due</td><td>${utc(i.expiresAt)}</td></tr>
      <tr><td>Status</td><td>${escape(i.state)}</td></tr>
      <tr><td>Network</td><td>Bitcoin · RGB20 · Mutinynet</td></tr>
    </tbody></table></div></div>
  <table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>
    <tr><td>Payment request in USDT (RGB20 on Bitcoin)</td><td class="r" id="doc-amt">${i.amount.toFixed(6)} USDT</td></tr></tbody></table>
  <table class="tot"><tbody>
    <tr><td>Invoice amount</td><td class="r">${i.amount.toFixed(6)} USDT</td></tr>
    <tr><td>Received</td><td class="r">${i.received.toFixed(6)} USDT</td></tr>
    <tr class="g"><td>${balance < 0 ? 'Overpaid' : 'Balance due'}</td><td class="r">${Math.abs(balance).toFixed(6)} USDT</td></tr></tbody></table>
  <h2>Payments received</h2>
  ${payRows ? `<table><thead><tr><th>Date / time</th><th>Transaction ID</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${payRows}</tbody></table>` : '<p class="m" style="margin:8px 0 20px">No payment recorded yet.</p>'}
  <h2>Payment reference</h2>
  <p class="mono" style="margin-bottom:6px">Recipient ID: ${escape(i.recipientId)}</p>
  <p class="mono">${escape(i.rgbInvoice)}</p>
  <div class="foot">Payment state and transaction details come from the local ledger at export time and are not an independent settlement proof.
  The billing address is a sample address; issuer details, item descriptions and tax treatment are not recorded, so this is not a validated tax invoice.</div>
  </body></html>`
}
