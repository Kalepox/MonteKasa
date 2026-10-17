// Guided setup UI + IPC + persistence in an isolated profile. No direct wallet reads.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app } = require('electron')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const directory = mkdtempSync(path.join(tmpdir(), 'tax-profile-smoke-'))
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'wallet.db')
delete process.env.ELECTRON_RENDERER_URL
const legacy = {
  version: 1,
  country: 'IT',
  taxYear: 2025,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'incomplete'
}
const legacyPath = path.join(directory, 'tax-profile.json')
writeFileSync(legacyPath, JSON.stringify(legacy))
const originalFile = readFileSync(legacyPath, 'utf8')
const timeout = setTimeout(() => {
  console.error('FAIL: timed out')
  app.exit(1)
}, 60000)
app.once('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const wait = async (source) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await js(source)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(
        `Timed out: ${source}; ${await js("document.getElementById('tax-profile-status').textContent")}`
      )
    }
    const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`)
    const set = (name, value) =>
      js(
        `document.getElementById('tax-profile-${name}').value = ${JSON.stringify(value)}; document.getElementById('tax-profile-form').dispatchEvent(new Event('change'))`
      )
    const type = (value) =>
      js(`document.querySelector('input[name="tax-profile-type"][value="${value}"]').click()`)
    const next = () => click('tax-profile-next')
    const created = () =>
      wait(
        "document.getElementById('tax-profile-status').textContent.startsWith('Created profile:') && !document.getElementById('tax-scope-fields').disabled"
      )
    try {
      await wait("!document.getElementById('tax-profile-new').disabled")
      await js("go('tax')")
      assert.equal(await js("document.getElementById('tax-profile-legacy').hidden"), false)
      await click('tax-profile-legacy')
      assert.equal(await js("document.getElementById('tax-profile-year').value"), '2025')
      await set('name', 'Reused personal profile')
      await next()
      assert(
        (await js("document.getElementById('tax-profile-summary').textContent")).includes(
          'incomplete'
        )
      )
      assert.equal((await js('window.taxScope.get()')).taxpayers.length, 0)
      await click('tax-profile-cancel')
      assert.equal((await js('window.taxScope.get()')).taxpayers.length, 0)
      await click('tax-profile-new')
      await next()
      assert.equal(await js("document.getElementById('tax-profile-step-0').hidden"), false)
      await type('personal')
      await next()
      assert.equal(await js("document.getElementById('tax-profile-business-field').hidden"), true)
      await next() // Required name/country must keep us on details.
      assert.equal(await js("document.getElementById('tax-profile-step-1').hidden"), false)
      await set('name', '<script>window.setupInjected=true</script>')
      await set('country', 'IT')
      await set('year', '2025')
      await set('personal', 'amministrato')
      await next()
      assert.equal(await js('window.setupInjected'), undefined)
      assert(
        (await js("document.getElementById('tax-profile-summary').textContent")).includes(
          'administered'
        )
      )
      await click('tax-profile-back')
      assert.equal(
        await js("document.getElementById('tax-profile-personal').value"),
        'amministrato'
      )
      await next()
      await js(
        "document.getElementById('tax-profile-form').requestSubmit(); document.getElementById('tax-profile-form').requestSubmit()"
      )
      await created()
      let scope = await js('window.taxScope.get()')
      assert.equal(scope.taxpayers.length, 1)
      const personal = scope.taxpayers[0]
      assert.equal(scope.activeTaxpayerId, personal.id)
      assert.equal(personal.profile.recordsCoverage, 'unknown')
      assert.equal(scope.assignments.length, 0)
      await wait("document.getElementById('tax-year-status').textContent.startsWith('2025')")
      await click('tax-profile-new')
      await type('business')
      await next()
      assert.equal(await js("document.getElementById('tax-profile-personal-field').hidden"), true)
      await set('name', 'Business review')
      await set('country', 'other')
      assert.equal(await js("document.getElementById('tax-profile-country-warning').hidden"), false)
      await set('business', 'sole-trader')
      await set('regime', 'forfettario')
      await set('business', 'company')
      assert.equal(await js("document.getElementById('tax-profile-regime').value"), 'unknown')
      assert.equal(
        await js("document.querySelector('#tax-profile-regime option[value=forfettario]').hidden"),
        true
      )
      await set('business', 'unknown')
      await next()
      await next()
      await created()
      scope = await js('window.taxScope.get()')
      assert.equal(scope.taxpayers.length, 2)
      assert.deepEqual(scope.taxpayers[0], personal)
      assert.equal(scope.taxpayers[1].profile.businessType, 'unknown')
      assert.equal(scope.taxpayers[1].profile.personalRegime, null)
      await wait(
        "document.getElementById('tax-year-status').textContent.includes('supports Italy only')"
      )
      await assert.rejects(
        js(
          `window.taxScope.change({kind:'create-profile',label:'Invalid',profile:${JSON.stringify({ ...legacy, userType: 'business', businessType: 'company', businessRegime: 'forfettario' })}})`
        )
      )
      assert.equal((await js('window.taxScope.get()')).taxpayers.length, 2)
      const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await reloaded
      await wait(
        "!document.getElementById('tax-profile-new').disabled && !document.getElementById('tax-scope-fields').disabled"
      )
      assert.equal(
        await js("document.getElementById('scope-taxpayer').value"),
        scope.activeTaxpayerId
      )
      assert.equal(await js("document.querySelectorAll('#tax-profile-existing li').length"), 2)
      assert.deepEqual(await js('window.taxProfile.get()'), legacy)
      assert.equal(readFileSync(legacyPath, 'utf8'), originalFile)
      await js(
        `document.getElementById('scope-taxpayer').value=${JSON.stringify(personal.id)}; document.getElementById('scope-taxpayer').dispatchEvent(new Event('change'))`
      )
      await wait("document.getElementById('tax-year-status').textContent.startsWith('2025')")
      assert.equal((await js('window.taxScope.get()')).activeTaxpayerId, personal.id)
      assert.equal((await js('window.agent.status()')).ready, false)
      console.log(
        'PASS guided setup: required fields, personal/business branching, review/back/cancel, safe text, double-submit guard, unified creation, unknown business, forfettario validation, unsupported country, profile selection, reload and legacy preservation. No wallet reads; AI stayed off.'
      )
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
