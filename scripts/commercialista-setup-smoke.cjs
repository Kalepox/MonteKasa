// Run: npx electron scripts/commercialista-setup-smoke.cjs [--screenshots]
// Renderer-only integration: temporary files, real profile store, fixture ledger.
// The application main process, wallet services and AI model are never loaded.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const directory = mkdtempSync(path.join(tmpdir(), 'commercialista-setup-'))
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
const emptyValue = { eur: '', date: '', source: '', reference: '' }
const original = {
  version: 1,
  databaseId,
  activeTaxpayerId: 'original',
  taxpayers: [{ id: 'original', label: 'Existing personal review', profile }],
  accounts: [
    {
      id: 'account',
      taxpayerId: 'original',
      label: 'Saved account',
      ownershipBps: 10000,
      kind: 'self-custody'
    }
  ],
  assets: [
    {
      id: 'asset',
      symbol: 'BTC',
      canonicalId: 'bitcoin',
      network: 'bitcoin',
      decimals: 8,
      environment: 'live'
    }
  ],
  assignments: [{ recordKey: 'payment:1', accountId: 'account', assetId: 'asset' }],
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
        valuation: emptyValue
      },
      relatedRecordKey: ''
    }
  ]
}
const ledger = {
  invoices: [],
  payments: [
    {
      nodeIdx: 1,
      invoiceId: null,
      direction: 'in',
      received: 1,
      status: 'settled',
      blockTime: 1748736000,
      txid: 'fixture'
    }
  ],
  proposals: []
}
const sourceLedger = JSON.stringify(ledger)
const scopePath = path.join(directory, 'scopes.json')
const legacyPath = path.join(directory, 'tax-profile.json')
writeFileSync(scopePath, JSON.stringify(original))
writeFileSync(legacyPath, JSON.stringify(profile))
const sourceLegacy = readFileSync(legacyPath, 'utf8')
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
let sessionStore = store
let sessionLegacy = JSON.parse(sourceLegacy)
let failLegacyRead = false
let failCreate = false
let creations = 0
const commands = []
ipcMain.handle('fixture:legacy', () => {
  if (failLegacyRead) {
    failLegacyRead = false
    throw new Error('Simulated local read failure')
  }
  return sessionLegacy
})
ipcMain.handle('fixture:scope', () => sessionStore.get())
ipcMain.handle('fixture:change', (_, command) => {
  if (command.kind === 'create-profile' && failCreate) {
    failCreate = false
    throw new Error('Simulated local save failure')
  }
  commands.push(command.kind)
  if (command.kind === 'create-profile') creations++
  return sessionStore.change(command, null, new Set(['payment:1']))
})
ipcMain.handle('fixture:snapshot', () => ledger)

const preload = path.join(directory, 'preload.cjs')
writeFileSync(
  preload,
  `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('taxProfile', { get: () => ipcRenderer.invoke('fixture:legacy') });
contextBridge.exposeInMainWorld('taxScope', { get: () => ipcRenderer.invoke('fixture:scope'), change: command => ipcRenderer.invoke('fixture:change', command) });
contextBridge.exposeInMainWorld('kasa', { snapshot: () => ipcRenderer.invoke('fixture:snapshot'), onChanged: () => () => {} });
`
)
const uiBundle = path.join(directory, 'ui.js')
const build = buildSync({
  stdin: {
    contents:
      "import './src/UI/src/commercialista-nav'; import './src/UI/src/tax-profile'; import './src/UI/src/tax-scope';",
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
    '<script>document.querySelectorAll(".view").forEach(view => view.classList.remove("on")); document.getElementById("view-tax").classList.add("on"); document.querySelectorAll(".ni").forEach(item => item.classList.toggle("on", item.getAttribute("onclick") === "go(\'tax\')")); window.fixtureErrors=[]; window.addEventListener("error", event => window.fixtureErrors.push(event.message)); window.addEventListener("unhandledrejection", event => window.fixtureErrors.push(String(event.reason)));</script><script src="./ui.js"></script></body>'
  )
const htmlPath = path.join(directory, 'index.html')
writeFileSync(htmlPath, html)
const timeout = setTimeout(() => {
  console.error('FAIL: smoke test timed out')
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
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await js(source)) return
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(
        `Timed out: ${source}; ${await js('JSON.stringify({status:document.getElementById("tax-profile-status").textContent,errors:window.fixtureErrors})')}`
      )
    }
    const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`)
    const set = (id, value) =>
      js(
        `document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}));`
      )
    const value = (id) => js(`document.getElementById(${JSON.stringify(id)}).value`)
    const visibleStep = (number) =>
      js(`!document.getElementById('tax-profile-step-${number}').hidden`)
    const next = () => click('tax-profile-next')
    const choose = (type) =>
      js(`document.querySelector('input[name="tax-profile-type"][value="${type}"]').click()`)
    const page = (name) => js(`document.querySelector('button[data-tax-page="${name}"]').click()`)
    const assertPage = async (name) => {
      assert.equal(await js('document.getElementById("view-tax").dataset.taxPage'), name)
      assert.equal(
        await js(
          `document.querySelector('button[data-tax-page="${name}"]').getAttribute('aria-current')`
        ),
        'page'
      )
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('[data-tax-panel]')).every(panel => panel.hidden === (panel.dataset.taxPanel !== '${name}'))`
        ),
        true
      )
    }
    const ready = () =>
      wait(
        '!document.getElementById("tax-profile-new").disabled && !document.getElementById("tax-scope-fields").disabled'
      )
    const reload = async () => {
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
    }
    const checkPreserved = () => {
      const saved = store.get()
      assert.deepEqual(saved.taxpayers[0], original.taxpayers[0])
      for (const key of ['accounts', 'assets', 'assignments', 'enrichments'])
        assert.deepEqual(saved[key], original[key])
      assert.equal(readFileSync(legacyPath, 'utf8'), sourceLegacy)
      assert.equal(JSON.stringify(ledger), sourceLedger)
    }
    const screenshot = async (name, width = 1200, height = 900) => {
      if (!process.argv.includes('--screenshots')) return
      window.setSize(width, height)
      await js(
        'Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))'
      )
      const target = path.join(tmpdir(), `commercialista-${name}.png`)
      writeFileSync(target, (await window.webContents.capturePage()).toPNG())
      console.log(`Screenshot: ${target}`)
    }
    try {
      await window.loadFile(htmlPath)
      await ready()
      await assertPage('overview')
      await screenshot('overview')
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      for (const name of ['activity', 'reports', 'profile', 'overview']) {
        await page(name)
        await assertPage(name)
      }

      // Reuse is a draft, never a mutation of the standalone legacy profile.
      await page('profile')
      await click('tax-profile-legacy')
      assert.equal(await value('tax-profile-year'), '2025')
      await set('tax-profile-name', 'Legacy copy draft')
      await next()
      await click('tax-profile-cancel')
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      assert.equal(await js('document.getElementById("tax-profile-resume").hidden'), false)
      checkPreserved()
      await click('tax-profile-resume')
      assert.equal(await value('tax-profile-name'), 'Legacy copy draft')
      await click('tax-profile-cancel')
      await click('tax-profile-discard')
      assert.equal(await js('document.getElementById("tax-profile-resume").hidden'), true)

      // Required questions, personal branching, escaped text, and back navigation.
      await click('tax-profile-new')
      await next()
      assert.equal(await visibleStep(0), true)
      await choose('personal')
      await next()
      await next()
      assert.equal(await visibleStep(1), true)
      const label = '<script>window.setupInjected=true</script>'
      await set('tax-profile-name', label)
      await set('tax-profile-country', 'IT')
      await set('tax-profile-year', '2025')
      await next()
      assert.equal(await visibleStep(2), true)
      assert.equal(await js('document.getElementById("tax-profile-business-field").hidden'), true)
      await screenshot('personal-setup')
      await screenshot('personal-setup-narrow', 480, 900)
      window.setSize(1200, 900)
      await set('tax-profile-personal', 'amministrato')
      await next()
      assert.equal(await visibleStep(3), true)
      assert.equal(
        await js(
          'document.querySelectorAll("#tax-profile-step-3 input, #tax-profile-step-3 select").length'
        ),
        0
      )
      await next()
      assert.equal(await visibleStep(4), true)
      assert.equal(await js('window.setupInjected'), undefined)
      assert(
        (await js('document.getElementById("tax-profile-summary").textContent')).includes(label)
      )
      await click('tax-profile-back')
      await click('tax-profile-back')
      assert.equal(await visibleStep(2), true)
      assert.equal(await value('tax-profile-personal'), 'amministrato')
      await click('tax-profile-cancel')
      await reload()
      await ready()
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      await page('profile')
      await click('tax-profile-resume')
      assert.equal(await visibleStep(2), true)
      assert.equal(await value('tax-profile-name'), label)
      assert.equal(await value('tax-profile-personal'), 'amministrato')
      await next()
      await next()
      failCreate = true
      await next()
      await wait(
        'document.getElementById("tax-profile-status").textContent.includes("Profile not created")'
      )
      assert.equal(await visibleStep(4), true)
      assert.equal(await value('tax-profile-name'), label)
      assert.equal(store.get().taxpayers.length, 1)
      await js(
        'document.getElementById("tax-profile-form").requestSubmit(); document.getElementById("tax-profile-form").requestSubmit()'
      )
      await wait(
        'document.getElementById("tax-profile-form").hidden && !document.getElementById("tax-scope-fields").disabled'
      )
      assert.equal(store.get().taxpayers.length, 2)
      assert.equal(creations, 1)
      assert.equal(store.get().taxpayers[1].profile.personalRegime, 'amministrato')
      assert.equal(store.get().taxpayers[1].profile.recordsCoverage, 'unknown')
      await assertPage('overview')
      assert.equal(await js('document.getElementById("tax-profile-resume").hidden'), true)
      checkPreserved()

      // Company cannot inherit a forfettario selection; professional can declare it.
      await page('profile')
      await click('tax-profile-new')
      await choose('business')
      await next()
      await set('tax-profile-name', 'New professional review')
      await set('tax-profile-country', 'other')
      assert.equal(await js('document.getElementById("tax-profile-country-warning").hidden'), false)
      await set('tax-profile-year', '2026')
      await next()
      assert.equal(await js('document.getElementById("tax-profile-personal-field").hidden'), true)
      await set('tax-profile-business', 'sole-trader')
      await set('tax-profile-regime', 'forfettario')
      await set('tax-profile-business', 'company')
      assert.equal(await value('tax-profile-regime'), 'unknown')
      assert.equal(
        await js(
          'document.querySelector("#tax-profile-regime option[value=forfettario]").disabled'
        ),
        true
      )
      await set('tax-profile-business', 'professional')
      await set('tax-profile-regime', 'forfettario')
      await next()
      await next()
      await next()
      await wait(
        'document.getElementById("tax-profile-form").hidden && !document.getElementById("tax-scope-fields").disabled'
      )
      const business = store.get().taxpayers.at(-1)
      assert.equal(business.profile.userType, 'business')
      assert.equal(business.profile.personalRegime, null)
      assert.equal(business.profile.businessRegime, 'forfettario')
      assert.equal(business.profile.country, 'other')
      checkPreserved()

      // Existing profile selection, next-step deep links, and unsaved record protection.
      await page('profile')
      await js(
        "window.dispatchEvent(new CustomEvent('kasa:tax-profile-select',{detail:{taxpayerId:'original'}}))"
      )
      await wait(
        'document.getElementById("scope-taxpayer").value === "original" && !document.getElementById("tax-scope-fields").disabled'
      )
      assert.equal(store.get().activeTaxpayerId, 'original')
      await js(
        "window.dispatchEvent(new CustomEvent('kasa:tax-navigate',{detail:{target:'enrichment-form'}}))"
      )
      await assertPage('activity')
      await set('enrichment-record', 'payment:1')
      await js(
        'document.getElementById("enrichment-eur").value="99.5"; document.getElementById("enrichment-eur").dispatchEvent(new Event("input",{bubbles:true}))'
      )
      assert.equal(await js('document.getElementById("view-tax").dataset.enrichmentDirty'), 'true')
      await page('reports')
      await assertPage('reports')
      await page('profile')
      await click('tax-profile-new')
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      await js(
        `window.dispatchEvent(new CustomEvent('kasa:tax-profile-select',{detail:{taxpayerId:${JSON.stringify(business.id)}}}))`
      )
      assert.equal(store.get().activeTaxpayerId, 'original')
      await page('activity')
      assert.equal(await value('enrichment-eur'), '99.5')
      await click('enrichment-discard')
      assert.equal(await value('enrichment-eur'), '24.12345678')
      checkPreserved()

      // Navigation saves and closes a wizard so a checklist destination stays visible.
      await page('profile')
      await click('tax-profile-new')
      await choose('personal')
      await next()
      await set('tax-profile-name', 'Navigation draft')
      await page('overview')
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      await js(
        'Array.from(document.querySelectorAll("#scope-next-steps li")).find(item => item.textContent.includes("all relevant history")).querySelector("button").click()'
      )
      await assertPage('profile')
      assert.equal(
        await js('document.getElementById("scope-history-form").checkVisibility()'),
        true
      )
      assert.equal(
        await js('document.getElementById("tax-profile-resume").checkVisibility()'),
        true
      )
      await click('tax-profile-resume')
      assert.equal(await visibleStep(1), true)
      assert.equal(await value('tax-profile-name'), 'Navigation draft')
      await click('tax-profile-cancel')
      assert.equal(await js('document.activeElement.id'), 'tax-profile-resume')
      await click('tax-profile-discard')
      assert.equal(await js('document.activeElement.id'), 'tax-profile-new')

      // Loading failures expose retry and preserve data, including on a renderer restart.
      failLegacyRead = true
      await reload()
      await wait('!document.getElementById("tax-profile-retry").hidden')
      checkPreserved()
      await click('tax-profile-retry')
      await ready()
      assert.equal(await value('scope-taxpayer'), 'original')
      assert.equal(store.get().taxpayers.length, 3)
      assert.equal(await js('document.querySelectorAll("#tax-profile-existing li").length'), 3)
      // First visit uses a separate empty fixture store and never alters saved profiles.
      sessionStore = new TaxScopeStore(path.join(directory, 'empty-scopes.json'), 'empty-fixture')
      sessionLegacy = null
      await reload()
      await wait('!document.getElementById("tax-profile-form").hidden')
      await assertPage('profile')
      assert.equal(await visibleStep(0), true)
      assert.equal(await js('document.getElementById("tax-profile-legacy").hidden'), true)
      await choose('business')
      await next()
      await set('tax-profile-name', 'Unfinished first visit')
      await page('activity')
      await assertPage('activity')
      await page('profile')
      assert.equal(await js('document.getElementById("tax-profile-form").hidden'), true)
      await click('tax-profile-resume')
      assert.equal(await visibleStep(1), true)
      assert.equal(await value('tax-profile-name'), 'Unfinished first visit')
      await js(
        'window.fixtureSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error("Simulated storage full") }; void 0'
      )
      await set('tax-profile-name', 'Answers retained in memory')
      assert(
        (await js('document.getElementById("tax-profile-draft-note").textContent')).includes(
          'could not save'
        )
      )
      await click('tax-profile-cancel')
      assert(
        (await js('document.getElementById("tax-profile-status").textContent')).includes(
          'could not save'
        )
      )
      await js('Storage.prototype.setItem = window.fixtureSetItem; void 0')
      await click('tax-profile-resume')
      assert.equal(await value('tax-profile-name'), 'Answers retained in memory')
      await click('tax-profile-cancel')
      await js(
        'window.fixtureRemoveItem = Storage.prototype.removeItem; Storage.prototype.removeItem = function() { throw new Error("Simulated removal failure") }; void 0'
      )
      await click('tax-profile-discard')
      assert(
        (await js('document.getElementById("tax-profile-status").textContent')).includes(
          'could not remove'
        )
      )
      assert.equal(await js('document.getElementById("tax-profile-resume").hidden'), false)
      await js('Storage.prototype.removeItem = window.fixtureRemoveItem; void 0')
      await click('tax-profile-discard')
      assert.equal(await js('document.getElementById("tax-profile-resume").hidden'), true)
      assert.equal(sessionStore.get().taxpayers.length, 0)
      checkPreserved()
      assert.deepEqual(await js('window.fixtureErrors'), [])
      assert.deepEqual(networkRequests, [])
      assert(commands.every((kind) => ['create-profile', 'select-taxpayer'].includes(kind)))
      console.log(
        'PASS Commercialista setup: five steps; personal/business questions; required fields; Back/save/resume across reload; discard; legacy preservation; save failure/retry; duplicate-submit guard; existing-profile selection; four navigation destinations; deep links; dirty enrichment retained across navigation and protected from profile changes; no wallet/AI/network calls.'
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
