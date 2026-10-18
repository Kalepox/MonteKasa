import type { KasaPayment, KasaSnapshot } from '../preload/index.d'
import { turinAddress } from './invoice-document'

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
const utc = (t: number): string =>
  new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
const rome = (t: number): string =>
  new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'Europe/Rome',
    dateStyle: 'medium',
    timeStyle: 'medium'
  })

// Invoice document for one wallet transfer. Times, IDs and amounts come from the ledger; the counterparty
// address of a linked invoice is the same sample Turin address used on the invoice PDF.
export function transactionDocumentHtml(p: KasaPayment, snap: KasaSnapshot): string {
  const out = p.direction === 'out'
  const invoice = snap.invoices.find((i) => i.id === p.invoiceId)
  const refund = out ? snap.proposals.find((x) => x.txid && x.txid === p.txid) : undefined
  const kind = out ? (refund ? 'Refund' : 'Payment sent') : 'Payment received'
  const row = (label: string, value: string, mono = false): string =>
    `<tr><td class="l">${label}</td><td${mono ? ' class="mono"' : ''}>${value}</td></tr>`
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>@page{size:A4;margin:18mm}body{font:12px/1.55 Arial,sans-serif;color:#18212d;margin:0}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #18212d;padding-bottom:14px}
  .brand{font-size:22px;font-weight:800;letter-spacing:-.5px}.sub{color:#455568;font-size:11px}
  .doc{text-align:right}.doc h1{font-size:20px;margin:0 0 2px}.badge{display:inline-block;margin-top:6px;padding:2px 10px;border:1px solid #18212d;border-radius:12px;font-size:11px;font-weight:700}
  .amt{margin:26px 0 8px;font-size:30px;font-weight:800;letter-spacing:-1px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#455568;margin:22px 0 4px}
  table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-bottom:1px solid #d5dbe2;vertical-align:top;overflow-wrap:anywhere}
  .l{width:32%;color:#455568}.mono{font-family:Menlo,Courier,monospace;font-size:10.5px}
  p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
  .foot{margin-top:26px;color:#6b7785;font-size:10px;border-top:1px solid #d5dbe2;padding-top:10px}</style></head>
  <body>
  <div class="top"><div><div class="brand">MonteKasa</div><div class="sub">Self-custodial invoicing · USDT on Bitcoin (RGB)</div></div>
    <div class="doc"><h1>Invoice</h1><div class="sub">${kind}</div><div class="badge">${escape(p.status).toUpperCase()}</div></div></div>
  <div class="amt">${p.received.toFixed(6)} USDT</div>
  <h2>Transaction</h2>
  <table><tbody>
    ${row('Transaction ID', escape(p.txid ?? '—'), true)}
    ${row('Date / time', p.blockTime ? `${utc(p.blockTime)} (${escape(rome(p.blockTime))} Rome)` : 'Awaiting confirmation')}
    ${row('Direction', out ? 'Outgoing' : 'Incoming')}
    ${row('Asset', 'USDT (RGB20)')}
    ${row('Network', 'Bitcoin · Mutinynet')}
    ${row('Status', escape(p.status))}
    ${p.recipientId ? row('Recipient ID', escape(p.recipientId), true) : ''}
  </tbody></table>
  ${
    invoice
      ? `<h2>${out ? 'Related invoice' : 'Paid invoice'}</h2><table><tbody>
    ${row('Invoice', 'INV-' + escape(invoice.id.slice(0, 6).toUpperCase()))}
    ${row('Client', `<b>${escape(invoice.client)}</b>\n${escape(turinAddress(invoice.id))}`)}
    ${row('Invoice amount', invoice.amount.toFixed(6) + ' USDT')}
    ${row('Received on invoice', invoice.received.toFixed(6) + ' USDT')}
    ${row('Invoice status', escape(invoice.state))}
  </tbody></table>`
      : ''
  }
  ${refund ? `<h2>Refund</h2><table><tbody>${row('Proposal', escape(refund.id))}${row('Reason', escape(refund.reason))}</tbody></table>` : ''}
  <div class="foot">Transaction details come from the local ledger at export time and are not an independent settlement proof.
  The client address is a sample address; this invoice is not a validated tax document.</div>
  </body></html>`
}
