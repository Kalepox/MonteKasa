import type { KasaInvoice } from '../preload/index.d'

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

export function invoiceDocumentHtml(i: KasaInvoice): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>@page{size:A4;margin:22mm}body{font:12px/1.6 Arial,sans-serif;color:#18212d}
  h1{font-size:26px;border-bottom:2px solid #18212d;padding-bottom:12px}h2{font-size:14px;margin-top:24px}
  p{overflow-wrap:anywhere;white-space:pre-wrap}table{width:100%;border-collapse:collapse;margin:24px 0}
  th,td{text-align:left;padding:10px 6px;border-bottom:1px solid #d5dbe2;overflow-wrap:anywhere}
  th{width:48%;font-weight:normal;color:#455568}tr{break-inside:avoid}</style></head>
  <body>${invoiceDocumentBody(i)}</body></html>`
}
