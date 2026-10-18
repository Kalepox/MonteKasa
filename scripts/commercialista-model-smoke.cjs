// Runs real UI controls against the installed model, using an isolated wallet.
// QVAC_CONFIG_PATH must point to the existing model cache; no download is permitted.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
assert(process.env.QVAC_CONFIG_PATH, 'Set QVAC_CONFIG_PATH to the installed model configuration')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commercialista-smoke-'))
app.setPath('userData', directory)
process.env.RGB_MOCK = '1'
process.env.KASA_DB = path.join(directory, 'wallet.db')
delete process.env.ELECTRON_RENDERER_URL
const timeout = setTimeout(() => {
  console.error('FAIL: timed out')
  app.exit(1)
}, 240000)
app.once('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const sdk = await import('@qvac/sdk')
      const info = () => sdk.getModelInfo({ name: sdk.QWEN3_5_2B_MULTIMODAL_Q4_K_M.name })
      const initial = await info()
      assert(initial.isCached, 'Model missing: refusing to download')
      const metadata = () =>
        initial.cacheFiles.map((file) => {
          assert(file.isCached, 'Incomplete cache: refusing to download')
          const stat = fs.statSync(file.path)
          return { path: file.path, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
        })
      const before = metadata()
      const js = (source) => window.webContents.executeJavaScript(source)
      const wait = async (source) => {
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          if (await js(source)) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(
          `Timed out: ${source}; ${await js("document.getElementById('agent-status').textContent")}`
        )
      }
      await js(
        'window.__events = []; window.agent.onEvent(e => window.__events.push(e)); undefined'
      )
      await wait("document.getElementById('tax-ai-prepare').textContent === 'Turn on AI'")
      assert.equal((await js('window.agent.status()')).ready, false)
      const results = []
      for (const [start, close] of [
        ['tax-ai-prepare', 'tax-ai-close'],
        ['agent-prepare', 'agent-close'],
        ['tax-ai-prepare', 'agent-close'],
        ['agent-prepare', 'tax-ai-close']
      ]) {
        await js(
          "go('tax'); if (document.getElementById('agent-chat').hidden) document.getElementById('agent-toggle').click()"
        )
        await js(`document.getElementById('${start}').click()`)
        await wait(
          "!document.getElementById('agent-send').disabled && document.getElementById('tax-ai-status').textContent.includes('running')"
        )
        assert.equal((await info()).isLoaded, true)
        assert.equal((await js('window.agent.status()')).ready, true)
        await js(
          "document.getElementById('agent-input').value = 'Explain what you can do in one sentence.'; document.getElementById('agent-form').requestSubmit()"
        )
        await wait("document.getElementById('agent-status').textContent.startsWith('Ready ·')")
        const reply = await js(
          "document.querySelector('#agent-messages > div:last-child p').textContent"
        )
        assert(reply.trim(), 'Actual model must answer')
        await js(`document.getElementById('${close}').click()`)
        await wait(
          "!document.getElementById('tax-ai-prepare').disabled && !document.getElementById('tax-ai-prepare').hidden && document.getElementById('agent-send').disabled"
        )
        assert.equal((await js('window.agent.status()')).ready, false)
        const after = await info()
        assert.equal(after.isLoaded, false)
        assert.equal(after.isCached, true)
        assert.equal(
          await js("document.getElementById('tax-ai-prepare').textContent"),
          'Turn on AI'
        )
        assert.equal(await js("document.getElementById('agent-prepare').textContent"), 'Turn on AI')
        assert.deepEqual(metadata(), before)
        const events = await js('window.__events')
        assert(
          !events.some((e) => e.type === 'status' && /Downloading model:/i.test(e.text)),
          'Unexpected download'
        )
        results.push({ start, close, reply, passed: true })
        console.log(
          `PASS ${start} -> actual inference -> ${close}: synced, unloaded, cached, no download`
        )
      }
      fs.writeFileSync(
        path.join(directory, 'results.json'),
        JSON.stringify({ before, results, events: await js('window.__events') }, null, 2)
      )
      console.log(`PASS all four control combinations; report: ${directory}/results.json`)
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
