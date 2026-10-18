// Run after npm run build: npx electron scripts/security-smoke.cjs
// Uses only a temporary database and the mock RGB backend. Never sends real funds.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron smoke runner is plain CommonJS JavaScript. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const directory = fs.mkdtempSync('/tmp/kasa-security-smoke-')
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'test.db')
delete process.env.ELECTRON_RENDERER_URL
const root = path.resolve(__dirname, '..')
const timeout = setTimeout(() => {
  console.error('Security smoke timed out')
  app.exit(1)
}, 45000)
let started = false
app.on('browser-window-created', (_, window) => {
  if (started) return
  started = true
  window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const wait = async (source) => {
      for (let i = 0; i < 100; i++) {
        if (await js(source)) return
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`Timed out: ${source}`)
    }
    try {
      const seeded = await js(`(async () => {
        const invoice = await window.kasa.createInvoice('Security smoke client', '10')
        await window.kasa.mockPay(invoice.recipientId, 12)
        return invoice
      })()`)
      await wait(
        `window.kasa.snapshot().then(s => s.invoices.some(i => i.id === ${JSON.stringify(seeded.id)} && i.state === 'Overpaid'))`
      )
      const legacy = await js(
        `window.kasa.send('rgb:any', 1).then(() => 'bad', error => error.message)`
      )
      assert.match(legacy, /security payment gate/)
      await js(`(async () => {
        const target = await window.kasa.receive()
        document.getElementById('send-amt-input').value = '1'
        document.getElementById('send-addr-input').value = target.invoice
        void window.executeSend()
      })()`)
      await wait(`Boolean(document.querySelector('.security-review[open]'))`)
      assert.equal(
        await js(`document.querySelector('.security-review').textContent.includes('MOCK MODE')`),
        true
      )
      await js(
        `Array.from(document.querySelectorAll('.security-review button')).find(b => b.textContent === 'Approve and submit').click()`
      )
      await wait(
        `window.security.snapshot().then(s => s.operations.some(o => o.state === 'completed'))`
      )
      const snapshot = await js('window.security.snapshot()')
      assert.equal(snapshot.operations[0].confirmations, 3)
      assert.equal(snapshot.operations[0].rgbStatus, 'Settled')
      assert.equal('tokenHash' in snapshot.operations[0], false)
      await js(`window.openInvoice(${JSON.stringify(seeded.id)})`)
      await js(`(async () => {
        document.getElementById('refund-invoice').value = (await window.kasa.receive()).invoice
        document.querySelector('#qvac-box button').click()
      })()`)
      // Reusing the already-paid recipient must be blocked rather than send a refund.
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal(await js(`Boolean(document.querySelector('.security-review[open]'))`), false)
      const injection =
        "<img src=x onerror=\"window.__injectionExecuted=true;window.security.execute('forged','forged',true)\">INJECTION_SUCCEEDED"
      const injectionDb = new (require('better-sqlite3'))(process.env.KASA_DB)
      const injectionFinding = {
        id: 'd'.repeat(64),
        rule: 'invoice-discrepancy',
        version: 1,
        subject: 'injection-ui-test',
        severity: 'review',
        message: injection,
        evidence: { note: injection },
        firstSeen: 1,
        lastSeen: 1
      }
      injectionDb
        .prepare('INSERT INTO security_findings (id, data) VALUES (?, ?)')
        .run(injectionFinding.id, JSON.stringify(injectionFinding))
      const resolvedFinding = {
        ...injectionFinding,
        id: 'e'.repeat(64),
        subject: 'resolved-ui-test',
        message: 'Previously resolved test notice',
        evidence: {},
        resolvedAt: 2
      }
      injectionDb
        .prepare('INSERT INTO security_findings (id, data) VALUES (?, ?)')
        .run(resolvedFinding.id, JSON.stringify(resolvedFinding))
      injectionDb.close()
      await js(`window.closeM(); document.getElementById('security-toggle').click()`)
      await wait(
        `document.getElementById('view-security').classList.contains('on') && document.querySelector('.security-content').textContent.includes('completed')`
      )
      await wait(
        `document.querySelector('.security-content').textContent.includes('INJECTION_SUCCEEDED')`
      )
      assert.equal(await js(`document.getElementById('security-show-resolved').checked`), false)
      assert.equal(
        await js(
          `document.querySelector('.security-content').textContent.includes('Previously resolved test notice')`
        ),
        false
      )
      const activeBadge = await js(`document.getElementById('security-count').textContent`)
      const resolvedTotal = (await js('window.security.snapshot()')).findings.filter(
        (f) => f.resolvedAt
      ).length
      assert.equal(
        await js(`document.getElementById('security-resolved-count').textContent`),
        `(${resolvedTotal})`
      )
      await js(`document.getElementById('security-show-resolved').click()`)
      await wait(
        `document.querySelector('.security-content').textContent.includes('Previously resolved test notice')`
      )
      assert.equal(await js(`document.getElementById('security-count').textContent`), activeBadge)
      await js(`go('wallet'); document.getElementById('security-toggle').click()`)
      assert.equal(await js(`document.getElementById('security-show-resolved').checked`), true)
      await js(`document.getElementById('security-show-resolved').click()`)
      await wait(
        `!document.querySelector('.security-content').textContent.includes('Previously resolved test notice')`
      )
      assert.equal(
        await js(
          `document.querySelector('.security-content').textContent.includes('block · review-failed')`
        ),
        false
      )
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('.security-content article')).some(a => a.querySelector('strong')?.textContent === 'Payment blocked' && a.textContent.includes('do not send it again'))`
        ),
        true
      )
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('.security-content article')).find(a => a.textContent.includes('INJECTION_SUCCEEDED')).querySelector('details') === null`
        ),
        true
      )
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('.security-content article')).some(a => a.textContent.includes('Original payment reference:'))`
        ),
        true
      )
      console.log(
        'PASS readable labels, duplicate-payment reason, recorded reference, and no empty evidence'
      )
      assert.equal(await js(`Boolean(window.__injectionExecuted)`), false)
      assert.equal(
        await js(
          `document.querySelectorAll('.security-content img, .security-content script').length`
        ),
        0
      )
      assert.equal(
        (await js('window.security.snapshot()')).operations.length,
        snapshot.operations.length
      )
      assert.equal(await js(`document.querySelectorAll('.security-content button').length`), 0)
      assert.equal(
        await js(`document.querySelectorAll('#view-analytics, #view-risk, #view-fraud').length`),
        0
      )
      assert.equal(
        await js(`document.querySelector('#security-toggle').closest('nav') !== null`),
        true
      )
      assert.equal(
        await js(
          `getComputedStyle(document.getElementById('security-toggle')).position === 'fixed'`
        ),
        false
      )
      assert.deepEqual(
        await js(
          `(() => { const label = [...document.querySelectorAll('nav .nlbl')].find(n => n.textContent === 'Intelligence'); const items = []; for (let n = label.nextElementSibling; n && !n.classList.contains('nlbl'); n = n.nextElementSibling) items.push(n.getAttribute('onclick')); return items })()`
        ),
        ["go('security')", "go('tax')"]
      )
      const unresolved = (await js('window.security.snapshot()')).findings.filter(
        (f) => !f.resolvedAt
      ).length
      assert.equal(
        await js(`document.getElementById('security-count').textContent`),
        unresolved ? ` · ${unresolved}` : ''
      )
      await js(`toast('placement-test', '!', 'Test notification', 'Upper-left placement', 'blue')`)
      await wait(`document.getElementById('t-placement-test').getBoundingClientRect().x === 18`)
      const toastRect = await js(
        `(() => { const r = document.getElementById('t-placement-test').getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: innerWidth } })()`
      )
      assert.equal(toastRect.x, 18)
      assert.equal(await js(`document.getElementById('tc').getBoundingClientRect().y`), 58)
      assert.ok(toastRect.y >= 58)
      assert.ok(toastRect.right <= toastRect.width)
      console.log(
        'PASS Security sidebar, removed buttons and pages, live count, upper-left notification'
      )
      console.log(
        'PASS hostile finding HTML is inert text; no DOM execution or additional payment operation'
      )
      await new Promise((resolve) => setTimeout(resolve, 600))
      fs.writeFileSync(
        '/tmp/kasa-security-smoke.png',
        (await window.webContents.capturePage()).toPNG()
      )
      const untrusted = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(root, 'out/preload/index.js'), sandbox: true }
      })
      await untrusted.loadURL('data:text/html,<h1>untrusted</h1>')
      const rejected = await untrusted.webContents.executeJavaScript(
        `window.security.snapshot().then(() => 'bad', e => e.message)`
      )
      assert.match(rejected, /Untrusted IPC sender/)
      untrusted.destroy()
      console.log(
        'PASS: sandboxed preload, real IPC, review UI, mock warning, approved send, combined settlement, duplicate recipient rejection, warning panel, and untrusted sender rejection.'
      )
      console.log(`Temporary evidence: ${directory}; screenshot: /tmp/kasa-security-smoke.png`)
      const resolvedDb = new (require('better-sqlite3'))(process.env.KASA_DB)
      for (const row of resolvedDb.prepare('SELECT id, data FROM security_findings').all()) {
        const finding = JSON.parse(row.data)
        finding.resolvedAt = Math.floor(Date.now() / 1000)
        resolvedDb
          .prepare('UPDATE security_findings SET data = ? WHERE id = ?')
          .run(JSON.stringify(finding), row.id)
      }
      resolvedDb.close()
      await wait(
        `document.querySelector('.security-content').textContent.includes('No active security notices.')`
      )
      assert.equal(await js(`document.getElementById('security-count').textContent`), '')
      assert.equal(
        await js(`document.querySelector('.security-content').textContent.includes('completed')`),
        true
      )
      await js(`document.getElementById('security-show-resolved').click()`)
      await wait(
        `document.querySelector('.security-content').textContent.includes('Previously resolved test notice')`
      )
      await window.webContents.reload()
      await wait(`document.getElementById('security-show-resolved') !== null`)
      assert.equal(await js(`document.getElementById('security-show-resolved').checked`), false)
      console.log(
        'PASS resolved notices hidden by default, toggle and counts, navigation persistence, live resolution, empty state, and reset on reload'
      )
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
})
require(path.join(root, 'out/main/index.js'))
