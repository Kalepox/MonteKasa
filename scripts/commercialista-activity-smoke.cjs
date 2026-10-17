// Run: npx electron scripts/commercialista-activity-smoke.cjs [--screenshots]
// Uses temporary declarations and a fixture ledger. Never loads the app main,
// wallet services, AI runtime, or the user's saved records.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const directory = mkdtempSync(path.join(tmpdir(), 'commercialista-activity-'))
app.setPath('userData', directory)
app.setPath('sessionData', path.join(directory, 'session'))
app.commandLine.appendSwitch('disable-background-networking')
const databaseId = path.join(directory, 'fixture-ledger.db')
const profile = {
  version: 1,
  country: 'IT',
  taxYear: 2025,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'incomplete'
}
const asset = {
  symbol: 'BTC',
  canonicalId: 'bitcoin',
  network: 'bitcoin',
  decimals: 8,
  environment: 'live'
}
const source = { id: 'fixture-btc-source', label: 'App Bitcoin records', backend: 'wdk', asset }
const testSource = {
  id: 'fixture-test-source',
  label: 'App test records',
  backend: 'wdk',
  asset: { ...asset, network: 'signet', environment: 'test' }
}
const original = {
  version: 1,
  databaseId,
  activeTaxpayerId: 'original',
  taxpayers: [
    { id: 'original', label: 'Existing personal review', profile },
    {
      id: 'other',
      label: 'Separate business review',
      profile: {
        ...profile,
        userType: 'business',
        personalRegime: null,
        businessType: 'company',
        businessRegime: 'ordinary'
      }
    }
  ],
  accounts: [
    {
      id: 'account',
      taxpayerId: 'original',
      label: 'Saved account',
      ownershipBps: 10000,
      kind: 'self-custody'
    },
    {
      id: 'other-account',
      taxpayerId: 'other',
      label: 'Separate business account',
      ownershipBps: 10000,
      kind: 'self-custody'
    }
  ],
  assets: [{ id: 'asset', ...asset }],
  assignments: [
    { recordKey: 'payment:1', accountId: 'account', assetId: 'asset' },
    { recordKey: 'payment:11', accountId: 'other-account', assetId: 'asset' }
  ],
  enrichments: [
    {
      recordKey: 'payment:1',
      accountId: 'account',
      assetId: 'asset',
      classification: 'income',
      valuation: {
        eur: '24.12345678',
        date: '2025-06-01',
        source: 'Saved source',
        reference: 'source-record'
      },
      fee: {
        status: 'unknown',
        amount: '',
        assetId: '',
        purpose: '',
        reference: '',
        valuation: { eur: '', date: '', source: '', reference: '' }
      },
      relatedRecordKey: ''
    }
  ]
}
const payment = (nodeIdx, overrides = {}) => ({
  nodeIdx,
  invoiceId: null,
  direction: 'in',
  received: 1,
  receivedRaw: 100000000,
  status: 'settled',
  blockTime: 1748736000,
  txid: `fixture-${nodeIdx}`,
  recipientId: `recipient-${nodeIdx}`,
  source,
  ...overrides
})
const invoice = (id, overrides = {}) => ({
  id,
  client: 'Fixture customer',
  amount: 1,
  amountRaw: 100000000,
  received: 0,
  receivedRaw: 0,
  rgbInvoice: 'fixture-only',
  recipientId: `recipient-${id}`,
  expiresAt: 1751328000,
  state: 'Issued',
  createdAt: 1748736000,
  source,
  ...overrides
})
const ledger = {
  invoices: [
    invoice('linked', {
      client: '<img src=x onerror="window.activityInjected=true">',
      received: 0.25,
      receivedRaw: 25000000,
      state: 'Pending'
    }),
    invoice('unpaid'),
    invoice('other-linked-unassigned', { source: undefined })
  ],
  payments: [
    payment(1),
    payment(2, {
      invoiceId: 'linked',
      received: 0.25,
      receivedRaw: 25000000,
      txid: 'shared-transaction'
    }),
    payment(3, {
      invoiceId: 'linked',
      received: 0.5,
      receivedRaw: 50000000,
      status: 'confirming',
      blockTime: null,
      txid: 'shared-transaction'
    }),
    payment(4, { direction: 'out', received: 0.2, receivedRaw: 20000000 }),
    payment(5, { source: testSource }),
    payment(6, { received: 7, receivedRaw: undefined }),
    payment(7, { source: undefined, receivedRaw: undefined }),
    payment(11, { source: undefined, invoiceId: 'other-linked-unassigned' })
  ],
  proposals: []
}
const ledgerBeforeChanges = JSON.stringify(ledger)
const scopePath = path.join(directory, 'scopes.json')
const legacyPath = path.join(directory, 'tax-profile.json')
writeFileSync(scopePath, JSON.stringify(original))
writeFileSync(legacyPath, JSON.stringify(profile))
const legacyContents = readFileSync(legacyPath, 'utf8')
const storeBundle = path.join(directory, 'store.cjs')
buildSync({
  entryPoints: [path.join(root, 'src/main/tax-scope.ts')],
  outfile: storeBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const { TaxScopeStore } = require(storeBundle)
const store = new TaxScopeStore(scopePath, databaseId)
const commands = []
let reads = 0
let failOrganisation = false
let delayProfileSelection = false
let finishProfileSelection
const recordKeys = () =>
  new Set([
    ...ledger.invoices.map((row) => `invoice:${row.id}`),
    ...ledger.payments.map((row) => `payment:${row.nodeIdx}`)
  ])
ipcMain.handle('fixture:legacy', () => profile)
ipcMain.handle('fixture:scope', () => store.get())
ipcMain.handle('fixture:organise', () => {
  if (failOrganisation) {
    failOrganisation = false
    throw new Error('Simulated local organisation failure')
  }
  return { scope: store.organise(ledger), snapshot: ledger }
})
ipcMain.handle('fixture:change', (_, command) => {
  commands.push(command.kind)
  if (command.kind === 'select-taxpayer' && delayProfileSelection)
    return new Promise((resolve) => {
      finishProfileSelection = () => resolve(store.change(command, null, recordKeys(), ledger))
    })
  return store.change(command, null, recordKeys(), ledger)
})
ipcMain.handle('fixture:snapshot', () => {
  reads++
  return ledger
})

const preload = path.join(directory, 'preload.cjs')
writeFileSync(
  preload,
  `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('taxProfile', { get: () => ipcRenderer.invoke('fixture:legacy') });
contextBridge.exposeInMainWorld('taxScope', {
  get: () => ipcRenderer.invoke('fixture:scope'),
  change: command => ipcRenderer.invoke('fixture:change', command),
  organise: () => ipcRenderer.invoke('fixture:organise')
});
contextBridge.exposeInMainWorld('kasa', {
  snapshot: () => ipcRenderer.invoke('fixture:snapshot'),
  onChanged: callback => {
    const handler = () => callback();
    ipcRenderer.on('fixture:changed', handler);
    return () => ipcRenderer.removeListener('fixture:changed', handler);
  }
});
`
)
const uiBundle = path.join(directory, 'ui.js')
const build = buildSync({
  stdin: {
    contents:
      "import './src/UI/src/commercialista-nav'; import './src/UI/src/tax-profile'; import './src/UI/src/tax-scope'; import './src/UI/src/tax-activity';",
    resolveDir: root
  },
  outfile: uiBundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  metafile: true
})
assert(
  !Object.keys(build.metafile.inputs).some((name) =>
    /wallet-service|src\/main\/rgb|src\/main\/index/.test(name)
  )
)
const html = readFileSync(path.join(root, 'src/UI/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*href="https?:[^>]*>/gi, '')
  .replace('</head>', '<link rel="stylesheet" href="./ui.css"></head>')
  .replace(
    '</body>',
    '<script>document.querySelectorAll(".view").forEach(view => view.classList.remove("on")); document.getElementById("view-tax").classList.add("on"); window.fixtureErrors=[]; window.addEventListener("error", event => window.fixtureErrors.push(event.message)); window.addEventListener("unhandledrejection", event => window.fixtureErrors.push(String(event.reason)));</script><script src="./ui.js"></script></body>'
  )
const htmlPath = path.join(directory, 'index.html')
writeFileSync(htmlPath, html)
const timeout = setTimeout(() => {
  console.error('FAIL: activity smoke test timed out')
  app.exit(1)
}, 90000)

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    const networkRequests = []
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const remote = /^https?:|^wss?:/.test(details.url)
      if (remote) networkRequests.push(details.url)
      callback({ cancel: remote })
    })
    const js = (source) => window.webContents.executeJavaScript(source)
    const wait = async (source) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(
        `Timed out: ${source}; ${await js('JSON.stringify({status:document.getElementById("tax-scope-status").textContent,errors:window.fixtureErrors})')}`
      )
    }
    const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`)
    const set = (id, value, event = 'change') =>
      js(
        `document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));`
      )
    const page = (name) => js(`document.querySelector('button[data-tax-page="${name}"]').click()`)
    const reload = async () => {
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
    }
    const checkPreserved = () => {
      const saved = store.get()
      assert.deepEqual(saved.taxpayers, original.taxpayers)
      for (const key of ['accounts', 'assets', 'assignments', 'enrichments']) {
        for (const record of original[key])
          assert.deepEqual(
            saved[key].find((item) =>
              record.id ? item.id === record.id : item.recordKey === record.recordKey
            ),
            record
          )
      }
      assert.equal(readFileSync(legacyPath, 'utf8'), legacyContents)
    }
    const screenshot = async (name, width = 1200, height = 900) => {
      if (!process.argv.includes('--screenshots')) return
      window.setSize(width, height)
      await js(
        'Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))'
      )
      const target = path.join(tmpdir(), `commercialista-activity-${name}.png`)
      writeFileSync(target, (await window.webContents.capturePage()).toPNG())
      console.log(`Screenshot: ${target}`)
    }
    try {
      await window.loadFile(htmlPath)
      await wait(
        'document.querySelectorAll("#tax-activity-rows tr[data-record-key]").length > 0 && !document.getElementById("tax-scope-fields").disabled'
      )
      await page('activity')
      const rowText = (key) =>
        js(`document.querySelector('#tax-activity-rows tr[data-record-key="${key}"]')?.textContent`)
      const bind = (sourceId) =>
        js(`document.querySelector('button[data-bind-source="${sourceId}"]').click()`)
      const ready = () =>
        wait(
          '!document.getElementById("tax-activity-refresh").disabled && !document.getElementById("tax-scope-fields").disabled'
        )

      // Existing declarations are untouched until ownership is explicitly confirmed.
      checkPreserved()
      assert.equal(store.get().accounts.length, original.accounts.length)
      assert.equal(store.get().assignments.length, original.assignments.length)
      assert.equal(await js('window.activityInjected'), undefined)
      assert.equal(await js('document.querySelectorAll("#tax-activity-rows img").length'), 0)
      // Filtering precedes request/payment grouping: a payment owned by another
      // profile cannot hide an unassigned request from this profile's review queue.
      assert.equal(await rowText('payment:11'), undefined)
      assert.match(await rowText('invoice:other-linked-unassigned'), /request|unassigned/i)
      await set('tax-activity-filter', 'all')
      assert.match(await rowText('payment:11'), /Separate business review/)
      assert.equal(await rowText('invoice:other-linked-unassigned'), undefined)
      await set('tax-activity-filter', 'profile')
      await bind(source.id)
      await wait('!document.getElementById("tax-source-form").hidden')
      assert.equal(await js('document.getElementById("scope-taxpayer").disabled'), true)
      assert.equal(
        await js('document.getElementById("tax-source-save").matches(":disabled")'),
        false
      )
      assert.equal(
        await js('document.getElementById("tax-source-cancel").matches(":disabled")'),
        false
      )
      await screenshot('ownership')
      await set('tax-source-account', 'new')
      await set('tax-source-label', 'App Bitcoin activity')
      await set('tax-source-ownership', 'full')
      await click('tax-source-save')
      assert.equal(
        store.get().accounts.length,
        original.accounts.length,
        'Ownership requires explicit confirmation'
      )
      await click('tax-source-confirm')
      await click('tax-source-save')
      await wait(
        'document.getElementById("tax-source-form").hidden && !document.getElementById("tax-activity-refresh").disabled'
      )
      await ready()
      let saved = store.get()
      const linkedAccount = saved.accounts.find((account) => account.sourceId === source.id)
      assert(linkedAccount)
      assert.equal(linkedAccount.ownershipBps, 10000)
      assert.equal(linkedAccount.taxpayerId, 'original')
      for (const key of [
        'invoice:linked',
        'invoice:unpaid',
        'payment:2',
        'payment:3',
        'payment:4',
        'payment:6'
      ])
        assert.equal(
          saved.assignments.find((assignment) => assignment.recordKey === key)?.accountId,
          linkedAccount.id
        )
      assert.equal(
        saved.assignments.some((assignment) => assignment.recordKey === 'payment:7'),
        false
      )
      checkPreserved()

      // Linked requests appear as payment evidence, never as additional cash rows.
      // Separate partial payments keep their own status and observed amount.
      assert.equal(
        await js(
          `document.querySelectorAll('#tax-activity-rows tr[data-record-key="invoice:linked"]').length`
        ),
        0
      )
      assert.equal(
        await js(
          `document.querySelectorAll('#tax-activity-rows tr[data-record-key="payment:2"], #tax-activity-rows tr[data-record-key="payment:3"]').length`
        ),
        2
      )
      assert.match(await rowText('payment:2'), /0\.25 BTC/)
      assert.match(await rowText('payment:3'), /pending|confirm|review/i)
      assert.match(await rowText('payment:6'), /unknown|unavailable|not saved|not recorded/i)
      assert.match(await rowText('payment:7'), /review|unknown|missing|unassigned/i)
      assert.match(await rowText('invoice:unpaid'), /request|unpaid/i)
      await set('tax-activity-filter', 'assigned')
      assert.equal(await rowText('payment:7'), undefined)
      assert.equal(await rowText('payment:5'), undefined)
      assert.match(await rowText('payment:2'), /0\.25 BTC/)
      await set('tax-activity-filter', 'profile')
      await screenshot('organised')
      await screenshot('organised-narrow', 480, 900)
      if (process.argv.includes('--screenshots')) {
        const dimensions = await js(`({
          page: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          workspace: document.querySelector('#view-tax .tax-workspace').clientWidth,
          workspaceScroll: document.querySelector('#view-tax .tax-workspace').scrollWidth,
          table: document.querySelector('#view-tax .tax-activity-table').clientWidth,
          tableScroll: document.querySelector('#view-tax .tax-activity-table').scrollWidth
        })`)
        assert(dimensions.page <= dimensions.viewport + 1, JSON.stringify(dimensions))
        assert(dimensions.workspaceScroll <= dimensions.workspace + 1, JSON.stringify(dimensions))
        assert(dimensions.tableScroll > dimensions.table, 'Narrow table scroll is contained')
      }
      window.setSize(1200, 900)

      // Cancelling an ownership form retains declarations; updates wait for the draft.
      await bind(testSource.id)
      await set('tax-source-label', 'Unsaved test ownership')
      ledger.payments.push(payment(9, { source: testSource, received: 0.5, receivedRaw: 50000000 }))
      window.webContents.send('fixture:changed')
      await wait('!document.getElementById("tax-activity-pending").hidden')
      assert.equal(
        await js('document.getElementById("tax-source-label").value'),
        'Unsaved test ownership'
      )
      assert.equal(
        store.get().accounts.some((account) => account.sourceId === testSource.id),
        false
      )
      await click('tax-source-cancel')
      await wait(
        `document.getElementById('tax-activity-pending').hidden && document.querySelector('#tax-activity-rows tr[data-record-key="payment:9"]')`
      )
      await bind(testSource.id)
      await set('tax-source-account', 'new')
      await set('tax-source-label', 'Test activity')
      await set('tax-source-ownership', 'full')
      await click('tax-source-confirm')
      await click('tax-source-save')
      await wait(
        'document.getElementById("tax-source-form").hidden && !document.getElementById("tax-activity-refresh").disabled'
      )
      await ready()
      assert.match(await rowText('payment:5'), /test/i)
      assert.match(await rowText('payment:5'), /exclud/i)

      // New ledger activity cannot overwrite an open enrichment draft. Once the
      // draft is discarded, automatic assignment resumes without a manual refresh.
      await set('enrichment-record', 'payment:1')
      await set('enrichment-eur', '99.5', 'input')
      assert.equal(await js('document.getElementById("view-tax").dataset.enrichmentDirty'), 'true')
      ledger.payments.push(payment(8, { direction: 'out', received: 0.1, receivedRaw: 10000000 }))
      window.webContents.send('fixture:changed')
      await wait('!document.getElementById("tax-activity-pending").hidden')
      assert.equal(await js('document.getElementById("enrichment-eur").value'), '99.5')
      assert.equal(
        store.get().assignments.some((assignment) => assignment.recordKey === 'payment:8'),
        false
      )
      await click('enrichment-discard')
      await wait(
        `document.getElementById('tax-activity-pending').hidden && document.querySelector('#tax-activity-rows tr[data-record-key="payment:8"]')`
      )
      await ready()
      assert.equal(
        store.get().assignments.find((assignment) => assignment.recordKey === 'payment:8')
          ?.accountId,
        linkedAccount.id
      )
      checkPreserved()

      // Reload/repeated change notifications are idempotent and leave saved details
      // byte-for-byte equivalent; records stay local and test history remains visible.
      const savedBeforeReload = store.get()
      await reload()
      await wait(
        'document.querySelectorAll("#tax-activity-rows tr[data-record-key]").length > 0 && !document.getElementById("tax-scope-fields").disabled'
      )
      await page('activity')
      window.webContents.send('fixture:changed')
      await click('tax-activity-refresh')
      await ready()
      assert.deepEqual(store.get(), savedBeforeReload)
      assert.equal(
        await js(
          `document.querySelectorAll('#tax-activity-rows tr[data-record-key="invoice:linked"]').length`
        ),
        0
      )
      checkPreserved()

      // Local read failures expose retry while keeping prior results and declarations.
      failOrganisation = true
      await click('tax-activity-refresh')
      await wait(
        'document.getElementById("tax-activity-status").textContent.includes("Simulated local organisation failure")'
      )
      assert.deepEqual(store.get(), savedBeforeReload)
      await click('tax-activity-refresh')
      await ready()
      assert.equal(
        await js(
          'document.getElementById("tax-activity-status").textContent.includes("Simulated local organisation failure")'
        ),
        false
      )
      checkPreserved()

      // Stopping a source link leaves reviewed history intact and prevents future
      // observations from silently acquiring the previous owner.
      const beforeUnlink = store.get()
      await js(
        `document.querySelector('button[data-unbind-account="${linkedAccount.id}"]').click()`
      )
      await wait(
        `document.querySelector('button[data-bind-source="${source.id}"]') && !document.getElementById('tax-activity-refresh').disabled`
      )
      assert.equal(
        store.get().accounts.find((account) => account.id === linkedAccount.id).sourceId,
        undefined
      )
      assert.deepEqual(store.get().assignments, beforeUnlink.assignments)
      assert.deepEqual(store.get().enrichments, beforeUnlink.enrichments)
      ledger.payments.push(payment(10))
      window.webContents.send('fixture:changed')
      await wait(
        `document.querySelector('#tax-activity-rows tr[data-record-key="payment:10"]') && !document.getElementById('tax-activity-refresh').disabled`
      )
      assert.equal(
        store.get().assignments.some((assignment) => assignment.recordKey === 'payment:10'),
        false
      )
      checkPreserved()

      // A slow profile selection must not let a still-visible source action bind
      // to the previous owner. New ownership uses the completed selected profile.
      delayProfileSelection = true
      await set('scope-taxpayer', 'other')
      await wait('document.getElementById("view-tax").dataset.scopeBusy === "true"')
      assert.equal(store.get().activeTaxpayerId, 'original')
      assert.equal(
        await js(`document.querySelector('button[data-bind-source="${source.id}"]').disabled`),
        true
      )
      await bind(source.id)
      await js(`document.querySelector('button[data-bind-source="${source.id}"]').onclick()`)
      assert.equal(await js('document.getElementById("tax-source-form").hidden'), true)
      assert.equal(typeof finishProfileSelection, 'function')
      delayProfileSelection = false
      finishProfileSelection()
      await wait(
        `document.getElementById('scope-taxpayer').value === 'other' && !document.querySelector('button[data-bind-source="${source.id}"]').disabled`
      )
      await ready()
      await bind(source.id)
      assert.match(
        await js('document.getElementById("tax-source-context").textContent'),
        /Separate business review/
      )
      await set('tax-source-account', 'new')
      await set('tax-source-label', 'Business app source')
      await set('tax-source-ownership', 'full')
      await click('tax-source-confirm')
      await click('tax-source-save')
      await wait(
        'document.getElementById("tax-source-form").hidden && !document.getElementById("tax-activity-refresh").disabled'
      )
      await ready()
      const businessAccount = store.get().accounts.find((account) => account.sourceId === source.id)
      assert.equal(businessAccount.taxpayerId, 'other')
      assert.equal(
        store.get().assignments.find((assignment) => assignment.recordKey === 'payment:10')
          .accountId,
        businessAccount.id
      )
      assert.equal(
        store.get().assignments.find((assignment) => assignment.recordKey === 'payment:2')
          .accountId,
        linkedAccount.id
      )
      checkPreserved()
      const originalRecordCount = JSON.parse(ledgerBeforeChanges).payments.length
      assert.equal(ledger.payments.length, originalRecordCount + 3)
      assert.equal(
        JSON.stringify({ ...ledger, payments: ledger.payments.slice(0, originalRecordCount) }),
        ledgerBeforeChanges
      )
      assert(reads > 0)
      assert.deepEqual(commands, [
        'bind-source',
        'bind-source',
        'unbind-source',
        'select-taxpayer',
        'bind-source'
      ])
      assert.deepEqual(await js('window.fixtureErrors'), [])
      assert.deepEqual(networkRequests, [])
      console.log(
        'PASS Commercialista saved-ledger activity: ownership confirmation; preserved existing declarations and enrichment; automatic source assignment; cross-profile filtering before grouping; pending/test exclusions; unknown amounts; legacy review; idempotent reload; queued ownership/enrichment drafts; error recovery; stopping automatic links; delayed profile selection guards and correct ownership; no app main, wallet, AI, or network access.'
      )
      clearTimeout(timeout)
      window.destroy()
      app.quit()
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
app.on('will-quit', () => rmSync(directory, { recursive: true, force: true }))
