// Scope UI test. Seeds an isolated SQLite ledger; never fetches wallet data or starts AI.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app } = require('electron')
const Database = require('better-sqlite3')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const directory = mkdtempSync(path.join(tmpdir(), 'tax-scope-smoke-'))
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'wallet.db')
delete process.env.ELECTRON_RENDERER_URL
const timeout = setTimeout(() => {
  console.error('FAIL: timed out')
  app.exit(1)
}, 60000)
app.once('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const wait = async (source) => {
      for (let n = 0; n < 100; n++) {
        if (await js(source)) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(
        `Timed out: ${source}; ${await js("document.getElementById('tax-scope-status').textContent")}`
      )
    }
    const set = (id, value) =>
      js(
        `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change')); if (${JSON.stringify(id)}.startsWith('enrichment-') && document.getElementById(${JSON.stringify(id)}).tagName === 'INPUT') document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('input', {bubbles:true}))`
      )
    const submit = async (id) => {
      await js(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`)
      await wait(
        id === 'enrichment-form'
          ? "!document.getElementById('enrichment-fields').disabled"
          : "!document.getElementById('tax-scope-fields').disabled"
      )
    }
    try {
      const db = new Database(process.env.KASA_DB)
      db.prepare(
        'INSERT INTO invoices(id,client,amount_raw,received_raw,rgb_invoice,recipient_id,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(
        'scope-invoice',
        '<script>untrusted</script>',
        1000000,
        0,
        'test',
        'scope-recipient',
        1,
        'Expired',
        1
      )
      db.close()
      const profile = {
        version: 1,
        country: 'IT',
        taxYear: 2026,
        userType: 'personal',
        personalRegime: 'dichiarativo',
        businessType: null,
        businessRegime: null,
        recordsCoverage: 'complete'
      }
      await js(`window.taxProfile.save(${JSON.stringify(profile)})`)
      await wait("!document.getElementById('tax-scope-fields').disabled")
      await js("go('tax')")
      await js(
        "window.taxProfile.get().then(profile => window.taxScope.change({kind:'create-profile',label:'Person',profile})).then(() => window.dispatchEvent(new Event('kasa:tax-profile-created')))"
      )
      await wait("!document.getElementById('tax-scope-fields').disabled")
      const taxpayer = (await js('window.taxScope.get()')).taxpayers[0]
      await set('scope-taxpayer', taxpayer.id)
      await wait("!document.getElementById('tax-scope-fields').disabled")
      await js("document.getElementById('scope-account-panel').open = true")
      await set('scope-account-label', 'Draft account')
      await js("document.getElementById('scope-account-later').click()")
      assert.equal((await js('window.taxScope.get()')).accounts.length, 0)
      await js("document.getElementById('scope-account-panel').open = true")
      await set('scope-account-ownership', 'partial')
      assert.equal(await js("document.getElementById('scope-account-share-field').hidden"), false)
      await set('scope-account-share', '25.50')
      await set('scope-account-ownership', 'unknown')
      assert.equal(await js("document.getElementById('scope-account-share').disabled"), true)
      await set('scope-account-label', 'Local declared account')
      await submit('scope-account-form')
      const account = (await js('window.taxScope.get()')).accounts[0]
      assert.equal(account.ownershipBps, null)
      assert(
        (await js("document.getElementById('scope-account-list').textContent")).includes(
          'Ownership unsure'
        )
      )
      await js("document.getElementById('scope-asset-panel').open = true")
      await set('scope-asset-symbol', 'Unresolved')
      await js("document.getElementById('scope-asset-later').click()")
      assert.equal((await js('window.taxScope.get()')).assets.length, 0)
      await js("document.getElementById('scope-asset-panel').open = true")
      await set('scope-asset-symbol', 'USDT')
      await set('scope-asset-network', 'declared-signet')
      await js("document.getElementById('scope-asset-form').requestSubmit()")
      assert.equal(await js("document.getElementById('scope-asset-technical').open"), true)
      assert.equal((await js('window.taxScope.get()')).assets.length, 0)
      await set('scope-asset-canonical', 'declared-test-contract')
      await set('scope-asset-network', 'declared-signet')
      await set('scope-asset-decimals', '6')
      await set('scope-asset-environment', 'test')
      await submit('scope-asset-form')
      const asset = (await js('window.taxScope.get()')).assets[0]
      await set('scope-account', account.id)
      await set('scope-asset', asset.id)
      await set('scope-record', 'invoice:scope-invoice')
      assert(
        (await js("document.getElementById('scope-record-preview').textContent")).includes(
          'Invoice request'
        )
      )
      assert(
        (await js("document.getElementById('scope-record-preview').textContent")).includes(
          '<script>untrusted</script>'
        )
      )
      await set('scope-assign-account', '')
      assert.equal(await js("document.getElementById('scope-assign-save').disabled"), true)
      await set('scope-assign-account', account.id)
      await set('scope-assign-asset', asset.id)
      await submit('scope-assignment-form')
      const assignedBeforeFilters = (await js('window.taxScope.get()')).assignments
      await set('scope-account', '')
      await set('scope-asset', '')
      assert.deepEqual((await js('window.taxScope.get()')).assignments, assignedBeforeFilters)
      assert(
        (await js("document.getElementById('scope-record-counts').textContent")).includes(
          '1 invoices'
        )
      )
      assert(
        (await js("document.getElementById('scope-completeness').textContent")).includes(
          'Test assets are excluded'
        )
      )
      assert(
        (await js("document.getElementById('scope-overview-totals').textContent")).includes(
          '1 invoice requests'
        )
      )
      assert(
        (await js("document.getElementById('scope-next-steps').textContent")).includes(
          'Explain what happened · 1 record(s)'
        )
      )
      await set('scope-history', 'incomplete')
      assert.equal(
        (await js('window.taxScope.get()')).taxpayers[0].profile.recordsCoverage,
        'complete'
      )
      await submit('scope-history-form')
      assert.equal(
        (await js('window.taxScope.get()')).taxpayers[0].profile.recordsCoverage,
        'incomplete'
      )
      assert(
        (await js("document.getElementById('scope-history-saved').textContent")).includes(
          'Some records are missing'
        )
      )
      await set('scope-history', 'complete')
      await submit('scope-history-form')
      assert(
        (await js("document.getElementById('scope-history-saved').textContent")).includes(
          'not verified'
        )
      )
      assert(
        (await js("document.getElementById('scope-overview-status').textContent")).includes(
          'not available'
        )
      )
      await set('scope-history', 'incomplete')
      await submit('scope-history-form')
      assert.equal(
        (await js("document.getElementById('scope-completeness').textContent")).split(
          'Confirm the ownership share'
        ).length - 1,
        1
      )
      window.setSize(1100, 950)
      await js("document.getElementById('scope-overview-title').scrollIntoView()")
      await new Promise((resolve) => setTimeout(resolve, 500))
      const overviewScreenshot = path.join(directory, 'overview.png')
      writeFileSync(overviewScreenshot, (await window.webContents.capturePage()).toPNG())
      console.log(`Overview screenshot: ${overviewScreenshot}`)
      await js(
        "[...document.querySelectorAll('#scope-next-steps button')].find(b => b.parentElement.textContent.includes('Explain what happened')).click()"
      )
      assert.equal(
        await js("document.getElementById('enrichment-record').value"),
        'invoice:scope-invoice'
      )
      assert.equal(await js("document.getElementById('scope-history').value"), 'incomplete')
      await set('enrichment-record', 'invoice:scope-invoice')
      assert.equal(await js("document.getElementById('enrichment-value-section').open"), false)
      assert.equal(await js("document.getElementById('enrichment-fee-section').open"), false)
      assert.equal(await js("document.getElementById('enrichment-related-section').hidden"), true)
      const beforeQuestions = await js('window.taxScope.get()')
      for (const classification of [
        'purchase',
        'sale',
        'income',
        'refund',
        'own-transfer',
        'unknown'
      ]) {
        await set('enrichment-classification', classification)
        assert.equal(
          await js("document.getElementById('enrichment-related-section').hidden"),
          !['refund', 'own-transfer'].includes(classification)
        )
        assert(
          (await js("document.getElementById('enrichment-value-question').textContent")).includes(
            'euros'
          )
        )
      }
      assert(
        (await js("document.getElementById('enrichment-related-help').textContent")).includes(
          'No other records'
        )
      )
      assert.deepEqual(await js('window.taxScope.get()'), beforeQuestions)
      assert.equal(await js("document.getElementById('enrichment-record').disabled"), true)
      assert.equal(await js("document.getElementById('tax-scope-fields').disabled"), true)
      await js("document.getElementById('enrichment-discard').click()")
      assert.equal(await js("document.getElementById('enrichment-record').disabled"), false)
      await set('enrichment-classification', 'goods-services')
      await set('enrichment-eur', '123456789012345.12345678')
      await set('enrichment-date', '2026-10-17')
      await set('enrichment-source', 'Manual documented rate')
      await set('enrichment-evidence', '<script>window.enrichmentInjected=true</script>')
      await set('enrichment-fee-status', 'recorded')
      await set('enrichment-fee-asset', asset.id)
      await set('enrichment-fee-amount', '0.000001')
      await set('enrichment-fee-purpose', 'Network fee')
      await set('enrichment-fee-reference', 'Fee receipt')
      await set('enrichment-fee-eur', '0.01')
      await set('enrichment-fee-date', '2026-10-17')
      await set('enrichment-fee-source', 'Rate source')
      await set('enrichment-fee-evidence', 'Rate receipt')
      await set('enrichment-fee-status', 'none')
      assert.equal(await js("document.getElementById('enrichment-fee-details').hidden"), true)
      await set('enrichment-fee-status', 'recorded')
      assert.equal(await js("document.getElementById('enrichment-fee-amount').value"), '0.000001')
      await submit('enrichment-form')
      assert.equal(
        (await js('window.taxScope.get()')).enrichments[0].valuation.eur,
        '123456789012345.12345678'
      )
      assert.equal(await js('window.enrichmentInjected'), undefined)
      assert(
        !(await js("document.getElementById('scope-completeness').textContent")).includes(
          '1 record(s) need EUR value'
        )
      )
      assert(
        !(await js("document.getElementById('scope-next-steps').textContent")).includes(
          'Add EUR value'
        )
      )
      await set('enrichment-fee-status', 'unknown')
      assert(
        (await js("document.getElementById('enrichment-change-warning').textContent")).includes(
          'removes the previously recorded fee'
        )
      )
      await js("document.getElementById('enrichment-discard').click()")
      assert.equal((await js('window.taxScope.get()')).enrichments[0].fee.amount, '0.000001')
      await set('enrichment-eur', '-1')
      await submit('enrichment-form')
      assert(
        (await js("document.getElementById('enrichment-status').textContent")).includes(
          'Could not save'
        )
      )
      assert.equal(await js("document.getElementById('enrichment-eur').value"), '-1')
      assert.equal(
        (await js('window.taxScope.get()')).enrichments[0].valuation.eur,
        '123456789012345.12345678'
      )
      await js("document.getElementById('enrichment-discard').click()")
      assert.equal(
        await js("document.getElementById('enrichment-eur').value"),
        '123456789012345.12345678'
      )
      await js(
        `window.taxProfile.save(${JSON.stringify({ ...profile, userType: 'business', personalRegime: null, businessType: 'company', businessRegime: 'ordinary' })})`
      )
      await js(
        "window.taxProfile.get().then(profile => window.taxScope.change({kind:'create-profile',label:'Company',profile})).then(() => window.dispatchEvent(new Event('kasa:tax-profile-created')))"
      )
      await wait("!document.getElementById('tax-scope-fields').disabled")
      const company = (await js('window.taxScope.get()')).taxpayers[1]
      await set('scope-taxpayer', company.id)
      await wait("!document.getElementById('tax-scope-fields').disabled")
      assert(
        (await js("document.getElementById('scope-record-counts').textContent")).includes(
          '0 invoices'
        )
      )
      assert.equal((await js('window.taxScope.get()')).taxpayers[0].profile.userType, 'personal')
      assert.equal(
        (await js('window.taxScope.get()')).taxpayers[0].profile.recordsCoverage,
        'incomplete'
      )
      assert.equal(await js("document.getElementById('scope-history').value"), 'complete')
      assert(
        (await js("document.getElementById('scope-next-steps').textContent")).includes(
          'empty review does not mean zero tax'
        )
      )
      assert.equal(await js("document.getElementById('enrichment-record').options.length"), 1)
      assert.equal(await js("document.getElementById('enrichment-fields').disabled"), true)
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
      await wait("!document.getElementById('tax-scope-fields').disabled")
      await set('scope-taxpayer', taxpayer.id)
      await wait("!document.getElementById('tax-scope-fields').disabled")
      assert(
        (await js("document.getElementById('scope-record-counts').textContent")).includes(
          '1 invoices'
        )
      )
      await set('enrichment-record', 'invoice:scope-invoice')
      assert.equal(
        await js("document.getElementById('enrichment-eur').value"),
        '123456789012345.12345678'
      )
      assert.equal(await js("document.getElementById('enrichment-fee-amount').value"), '0.000001')
      assert.equal(await js("document.getElementById('enrichment-clear').disabled"), true)
      window.setSize(1100, 950)
      await js("go('tax'); document.getElementById('enrichment-title').scrollIntoView()")
      await new Promise((resolve) => setTimeout(resolve, 500))
      const editorScreenshot = path.join(directory, 'enrichment.png')
      writeFileSync(editorScreenshot, (await window.webContents.capturePage()).toPNG())
      console.log(`Enrichment screenshot: ${editorScreenshot}`)
      await js(
        "document.getElementById('enrichment-value-section').open=true; document.getElementById('enrichment-evidence-section').open=true"
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeFileSync(
        path.join(directory, 'enrichment-expanded.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      await js("document.getElementById('enrichment-clear-confirm').click()")
      await js("document.getElementById('enrichment-clear').click()")
      await wait("!document.getElementById('tax-scope-fields').disabled")
      assert.equal((await js('window.taxScope.get()')).enrichments.length, 0)
      await set('enrichment-classification', 'income')
      await submit('enrichment-form')
      const partial = (await js('window.taxScope.get()')).enrichments[0]
      assert.equal(partial.classification, 'income')
      assert.equal(partial.valuation.eur, '')
      assert.equal(partial.fee.status, 'unknown')
      await set('scope-record', 'invoice:scope-invoice')
      assert.equal(await js("document.getElementById('scope-unassign').disabled"), true)
      await js("document.getElementById('scope-replace-confirm').click()")
      window.setSize(1100, 950)
      await js(
        "go('tax'); document.getElementById('scope-records-title').scrollIntoView(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      const screenshot = path.join(directory, 'assignment.png')
      writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
      console.log(`UI screenshot: ${screenshot}`)
      await js("document.getElementById('scope-unassign').click()")
      await wait("!document.getElementById('tax-scope-fields').disabled")
      assert.equal((await js('window.taxScope.get()')).assignments.length, 0)
      assert.equal((await js('window.agent.status()')).ready, false)
      console.log(
        'PASS scope UI: taxpayer/account/asset declarations, explicit assignment, isolated profiles, test-asset completeness, reload persistence, unassignment; enrichment save, precision, validation, discard, isolation, safe text and removal. Profile overview counts, actionable checklist, deduplicated requirements, scoped history persistence and no false readiness passed. Conditional enrichment questions, hidden fee draft preservation, unsaved navigation guard, discard and removal confirmation passed. Ownership unsure, skip without saving, technical field validation, separate filters/assignment and removal confirmation passed. SQLite fixtures only; AI stayed off.'
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
