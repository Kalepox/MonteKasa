// Tests remaining features with a temporary mock wallet. Downloads are captured in memory.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const directory = fs.mkdtempSync('/tmp/kasa-remaining-smoke-')
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'test.db')
delete process.env.ELECTRON_RENDERER_URL
const results = []
const timeout = setTimeout(() => app.exit(1), 60000)
let started = false
app.on('browser-window-created', (_, window) => {
  if (started) return
  started = true
  window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const check = async (name, source) => {
      try {
        const actual = await js(source)
        results.push({ name, pass: actual === true, actual })
      } catch (error) {
        results.push({ name, pass: false, error: error.message })
      }
    }
    try {
      await check(
        'Spotlight opens and navigates to wallet',
        `(() => { openCmdPalette(); setCmdQuery('wallet'); execCmdIndex(0); return document.getElementById('view-wallet').classList.contains('on') })()`
      )
      await check(
        'Empty search arrow navigation keeps a valid index',
        `(() => { openCmdPalette(); setCmdQuery('zzzzzzzzzzzzzzz'); handleCmdKey({key:'ArrowDown',preventDefault(){}}); return Number.isFinite(activeCmdIndex) })()`
      )
      await check(
        'Escape closes overlays and Spotlight',
        `(() => { openSend(); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); return !document.querySelector('.overlay.on') })()`
      )
      await check(
        'Reset invoice wizard restores step numbers',
        `(() => { document.querySelector('#s2 .sn').textContent = '✓'; resetFlow(); return document.querySelector('#s2 .sn').textContent === '2' })()`
      )
      // Avoid reading or replacing the user's clipboard: mock the browser clipboard API in this test window.
      await js(
        `window.qaClipboard = 'rgb:mock/~/mock:utxob:clipboard?expiry=9999999999'; Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{readText:async()=>window.qaClipboard, writeText:async text=>{window.qaCopied=text}}})`
      )
      await check(
        'Send paste reads clipboard',
        `(async () => { await autofillSendAddress(); return document.getElementById('send-addr-input').value === window.qaClipboard })()`
      )
      await check(
        'Send paste rejects invalid clipboard without overwriting address',
        `(async () => { const before = document.getElementById('send-addr-input').value; window.qaClipboard = 'not an invoice'; await autofillSendAddress(); return document.getElementById('send-addr-input').value === before })()`
      )
      await check(
        'Global invoice copy actually writes clipboard',
        `(() => { const el = document.createElement('span'); el.className='mono'; el.textContent='INV-QA-COPY'; document.body.append(el); el.click(); el.remove(); return window.qaCopied === 'INV-QA-COPY' })()`
      )
      await check(
        'PDF extraction does not claim success without a document',
        `(async () => { await simulateExtract(); return !document.getElementById('step-review').classList.contains('on') })()`
      )
      await js(
        `window.kasa.createInvoice('QA Remaining Client', '12.345678').then(i => { window.qaInvoice = i })`
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      await js(
        `(async () => { await openInvoice(window.qaInvoice.id); window.qaDownload = null; window.downloadFile = (name, content, mime) => { window.qaDownload = {name,content}; if (mime === "application/pdf") window.qaBlobs.push(new Blob([content], {type:mime})) }; window.qaBlobs = []; URL.createObjectURL = blob => { window.qaBlobs.push(blob); return 'blob:qa-captured' }; HTMLAnchorElement.prototype.click = function(){} })()`
      )
      await check(
        'Single invoice CSV includes actual client and full precision',
        `(async () => { await exportCurrentInvoiceCSV(); return window.qaDownload.content.includes('QA Remaining Client') && window.qaDownload.content.includes('12.345678') })()`
      )
      await check(
        'Invoice PDF contains PDF bytes',
        `(async () => { await downloadInvoicePdf(); return (await window.qaBlobs.at(-1).text()).startsWith('%PDF-') })()`
      )
      await check(
        'Invoice preview reports Issued and actual amount',
        `document.querySelector('#modal .doc').textContent.includes('Issued') && document.querySelector('#modal .doc').textContent.includes('12.345678') && !document.querySelector('#modal .doc').textContent.includes('VERIFIED')`
      )
      await check(
        'RGB consignment is not fixed demo data',
        `(() => { const before = window.qaBlobs.length; downloadInvoiceConsignment(); return window.qaBlobs.length === before && document.querySelector('button[onclick="downloadInvoiceConsignment()"]').disabled })()`
      )
      await check(
        'Unvalidated invoice XML is disabled and cannot download',
        `(() => { window.qaDownload = null; exportCurrentInvoiceXML(); return window.qaDownload === null && document.querySelector('button[onclick="exportCurrentInvoiceXML()"]').disabled })()`
      )
      const pdfBytes = await js(
        `window.kasa.invoicePdf(window.qaInvoice.id).then(bytes => Array.from(bytes))`
      )
      fs.writeFileSync(path.join(directory, 'invoice.pdf'), Buffer.from(pdfBytes))
      await check(
        'Unknown invoice PDF request rejected',
        `window.kasa.invoicePdf('missing').then(()=>false,()=>true)`
      )
      await check(
        'Tax XML and receipt cannot download',
        `(() => { window.qaDownload=null; const count=window.qaBlobs.length; exportTaxXML(); downloadF24ReceiptPdf(); openF24ReceiptModal(); return window.qaDownload===null && count===window.qaBlobs.length && !document.getElementById('f24-receipt-modal') })()`
      )
      await check(
        'Ledger search finds actual client',
        `(async () => { document.getElementById('qi').value = 'QA Remaining Client'; await qry(); return document.getElementById('qa').textContent.includes('QA Remaining Client') })()`
      )
      await check(
        'Tax export does not fabricate audited revenue',
        `(async () => { await exportTaxCSV(); return window.qaDownload.content.includes('QA Remaining Client') && window.qaDownload.content.includes('12.345678') && window.qaDownload.content.includes('Tax liability is not calculated') && !window.qaDownload.content.includes('63900.00') && !window.qaDownload.content.includes('Audited by QVAC') })()`
      )
      await check(
        'Ledger search shows a no-match result',
        `(async () => {
        document.getElementById('qi').value = 'nonexistent-client-qa'; await qry();
        return document.getElementById('qa').textContent.includes('No matching recorded')
      })()`
      )
      await check(
        'Ledger search renders client markup as inert text',
        `(async () => {
        await window.kasa.createInvoice('<img src=x onerror=alert(1)> QA Markup', '1');
        document.getElementById('qi').value = 'QA Markup'; await qry();
        return document.getElementById('qa').textContent.includes('<img') && !document.querySelector('#qa img')
      })()`
      )
      await check(
        'Tax payment does not falsely claim external transmission',
        `(async () => { executeTaxTransfer(); await new Promise(r=>setTimeout(r,2100)); return document.getElementById('btn-exec-tax').disabled && !document.getElementById('t-tax-paid')?.textContent.includes('successfully transmitted') })()`
      )
      await check(
        'Settings shows actual assistant model',
        `document.querySelector('#view-settings input').value.includes('Qwen')`
      )
      await check(
        'Profile updates sidebar in current session',
        `(() => { document.getElementById('prof-name').value = 'QA Profile'; saveProfile(); return document.getElementById('sidebar-name').textContent === 'QA Profile' })()`
      )
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
      await check(
        'Saved profile survives reload',
        `document.getElementById('prof-name').value === 'QA Profile'`
      )
      await check(
        'Invoice ledger survives reload',
        `window.kasa.snapshot().then(s=>s.invoices.some(i=>i.client === 'QA Remaining Client'))`
      )
      fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2))
      console.log(JSON.stringify({ directory, results }, null, 2))
      clearTimeout(timeout)
      app.exit(results.every((r) => r.pass) ? 0 : 1)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
