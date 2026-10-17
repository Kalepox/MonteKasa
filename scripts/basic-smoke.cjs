// Run after npm run build. Uses a temporary mock wallet; no real funds or model downloads.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app, ipcMain } = require('electron')
const QRCode = require('qrcode')
const fs = require('node:fs')
const path = require('node:path')
const directory = fs.mkdtempSync('/tmp/kasa-basic-smoke-')
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'test.db')
delete process.env.ELECTRON_RENDERER_URL
const results = []
const timeout = setTimeout(() => app.exit(1), 60000)
let started = false
let receiveMode = 'normal'
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  register(channel, async (...args) => {
    if (channel === 'kasa:receive') {
      if (receiveMode === 'failure') throw new Error('QA node unavailable')
      if (receiveMode === 'expired') return { invoice: 'rgb:expired', expiresAt: 1 }
      if (receiveMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return listener(...args)
  })
app.on('browser-window-created', (_, window) => {
  if (started) return
  started = true
  window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const check = async (name, source) => {
      const actual = await js(source)
      results.push({ name, pass: actual === true, actual })
    }
    try {
      await check(
        'Empty dashboard',
        `document.getElementById('dash-invoices').textContent.includes('No invoices yet')`
      )
      await check(
        'All navigation views open',
        `Array.from(document.querySelectorAll('.view')).every(v => { go(v.id.slice(5)); return v.classList.contains('on') && document.querySelectorAll('.view.on').length === 1 })`
      )
      await check(
        'Invalid invoice amounts rejected',
        `(async () => {
        for (const amount of ['0', '-1', 'abc', '0.0000001']) {
          try { await window.kasa.createInvoice('QA invalid', amount); return false } catch {}
        }
        return (await window.kasa.snapshot()).invoices.length === 0
      })()`
      )
      await check(
        'Create invoice through UI and render QR',
        `(async () => {
        go('new'); document.getElementById('rv-client').value = 'QA Basic Client';
        document.getElementById('rv-total').value = '10'; await issueRGB();
        const s = await window.kasa.snapshot(); window.qaInvoice = s.invoices[0];
        return s.invoices.length === 1 && s.invoices[0].client === 'QA Basic Client' && !!document.querySelector('#done-invoice img')
      })()`
      )
      await check(
        'Invoice detail shows actual client',
        `(async () => { await openInvoice(window.qaInvoice.id); return document.getElementById('doc-to').textContent === 'QA Basic Client' })()`
      )
      await js(
        `closeM(); go('invoices'); ft(Array.from(document.querySelectorAll('.ft')).find(e => e.textContent.startsWith('Paid')))`
      )
      await check(
        'Paid filter excludes unpaid invoices',
        `Array.from(document.querySelectorAll('#inv-table tr')).every(r => r.style.display === 'none')`
      )
      await js(`window.kasa.createInvoice('QA refresh', '2')`)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await check(
        'Selected filter survives data refresh',
        `Array.from(document.querySelectorAll('#inv-table tr')).every(r => r.style.display === 'none')`
      )
      await check(
        'Max matches empty wallet balance',
        `(() => { setSendMax(); return Number(document.getElementById('send-amt-input').value) === 0 })()`
      )
      await js(`openReceiveModal()`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await check(
        'Receive uses backend invoice',
        `document.getElementById('rcv-addr-text').textContent.startsWith('rgb:mock/')`
      )
      await js(
        `window.qaOldReceive = document.getElementById('rcv-addr-text').textContent; window.qaOldQr = document.getElementById('rcv-qr').innerHTML; generateFreshSeal()`
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      await check(
        'Fresh seal uses backend invoice',
        `document.getElementById('rcv-addr-text').textContent.startsWith('rgb:mock/') && document.getElementById('rcv-addr-text').textContent !== window.qaOldReceive && document.getElementById('rcv-qr').innerHTML !== window.qaOldQr`
      )
      await check(
        'BTC receive does not present hardcoded address',
        `(() => { setReceiveAsset('btc'); return document.getElementById('rcv-tab-btc').disabled && !document.getElementById('rcv-addr-text').textContent.includes('bc1qxy2kgdy') })()`
      )
      const receiveText = await js(`document.getElementById('rcv-addr-text').textContent`)
      const expectedQr = await QRCode.toString(receiveText, { type: 'svg', margin: 4 })
      await check(
        'QR encodes exactly the displayed invoice',
        `(() => {
        const expected = document.createElement('div'); expected.innerHTML = ${JSON.stringify(expectedQr)};
        return expected.querySelector('svg').innerHTML === document.querySelector('#rcv-qr svg').innerHTML
      })()`
      )
      receiveMode = 'slow'
      await js(`void generateFreshSeal()`)
      await check(
        'Loading clears old invoice and QR and disables copying',
        `document.getElementById('rcv-copy').disabled && document.getElementById('rcv-fresh').disabled && !document.getElementById('rcv-addr-text').textContent && !document.querySelector('#rcv-qr svg')`
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      await check(
        'Controls recover after generation',
        `!document.getElementById('rcv-copy').disabled && !document.getElementById('rcv-fresh').disabled`
      )
      receiveMode = 'failure'
      await js(`generateFreshSeal()`)
      await check(
        'Backend failure exposes no stale invoice and allows retry',
        `document.getElementById('rcv-copy').disabled && !document.getElementById('rcv-fresh').disabled && !document.getElementById('rcv-addr-text').textContent && !document.querySelector('#rcv-qr svg')`
      )
      receiveMode = 'expired'
      await js(`generateFreshSeal()`)
      await check(
        'Expired backend invoice cannot be copied',
        `document.getElementById('rcv-copy').disabled && !document.querySelector('#rcv-qr svg')`
      )
      receiveMode = 'normal'
      await js(`generateFreshSeal()`)
      await check(
        'Retry returns a usable backend invoice',
        `!document.getElementById('rcv-copy').disabled && document.getElementById('rcv-addr-text').textContent.startsWith('rgb:mock/')`
      )
      await check(
        'CSV export contains actual invoice client',
        `(async () => { window.qaDownload = null; window.downloadFile = (name, content) => { window.qaDownload = {name, content} }; await exportInvoicesCSV(); return window.qaDownload.content.includes('QA Basic Client') })()`
      )
      await check(
        'AI panel opens without downloading model',
        `(() => { document.getElementById('agent-toggle').click(); return !document.getElementById('agent-chat').hidden && document.getElementById('agent-send').disabled })()`
      )
      await js(`document.getElementById('agent-close').click()`)
      await check('AI panel closes', `document.getElementById('agent-chat').hidden`)
      await js(`document.getElementById('receive-modal').classList.remove('on'); go('invoices')`)
      fs.writeFileSync(
        path.join(directory, 'screen.png'),
        (await window.webContents.capturePage()).toPNG()
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
