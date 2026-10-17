// Run with node scripts/wdk-cleanup-smoke.cjs; optionally set WALLET_NODE to Node 22.
// Only reads state in empty temporary wallets. Never creates, unlocks or funds a wallet.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const serviceDirectory = path.resolve(__dirname, '../wallet-service')
const serviceOptions = (env) => ({
  cwd: serviceDirectory,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env
})

// A disposable parent represents Electron. Killing it must close the child's IPC channel.
if (process.argv.includes('--fixture-parent')) {
  const child = spawn(process.execPath, ['server.mjs'], serviceOptions(process.env))
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => process.stderr.write(data))
  child.on('error', () => process.exit(1))
  process.send({ childPid: child.pid })
  setInterval(() => {}, 1_000)
} else {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

function walletNode() {
  const versions = path.join(os.homedir(), '.nvm/versions/node')
  const candidates = process.env.WALLET_NODE
    ? [process.env.WALLET_NODE]
    : [
        process.execPath,
        ...(fs.existsSync(versions)
          ? fs
              .readdirSync(versions)
              .filter((name) => /^v22\./.test(name))
              .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
              .map((name) => path.join(versions, name, 'bin/node'))
          : []),
        '/opt/homebrew/opt/node@22/bin/node',
        '/usr/local/opt/node@22/bin/node'
      ]
  const found = candidates.find((candidate) => {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5_000 })
    return result.status === 0 && /^v22\./.test(result.stdout.trim())
  })
  assert.ok(found, 'Install Node 22 or set WALLET_NODE to its executable')
  return found
}

async function within(promise, message, milliseconds = 10_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function running(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitUntilGone(pid) {
  const deadline = Date.now() + 10_000
  while (running(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(running(pid), false, `Test wallet process ${pid} must exit`)
}

async function main() {
  const runtime = walletNode()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-wdk-cleanup-'))
  const children = []
  const descendants = []
  const results = []

  function launch(name, parent = false) {
    const dataDirectory = path.join(directory, name)
    const token = randomBytes(32).toString('hex')
    const child = spawn(
      runtime,
      parent ? [__filename, '--fixture-parent'] : ['server.mjs'],
      serviceOptions({
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        WALLET_DATA_DIR: dataDirectory,
        WALLET_TOKEN: token
      })
    )
    children.push(child)
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    )
    let buffer = ''
    let errors = ''
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`Service exited before ready: ${errors}`)))
      child.stderr.on('data', (data) => {
        errors = (errors + data).slice(-2_000)
      })
      child.stdout.on('data', (data) => {
        buffer += data
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          let value
          try {
            value = JSON.parse(line)
          } catch {
            continue
          }
          if (value.ready && Number.isInteger(value.port)) resolve(value.port)
        }
      })
    })
    // Early disconnect can deliberately exit before readiness.
    void ready.catch(() => {})
    const descendant = parent
      ? new Promise((resolve) =>
          child.once('message', ({ childPid }) => {
            descendants.push(childPid)
            resolve(childPid)
          })
        )
      : undefined
    return { child, dataDirectory, token, exited, ready, descendant }
  }

  async function verifyState(test) {
    const port = await within(test.ready, 'WDK readiness timed out', 20_000)
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${test.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'state' }),
      signal: AbortSignal.timeout(5_000)
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { result: { state: 'none' } })
    return port
  }

  async function verifyStopped(test, port) {
    const exit = await within(test.exited, 'WDK did not shut down within 10 seconds')
    assert.deepEqual(exit, { code: 0, signal: null }, 'Shutdown must finish gracefully')
    assert.equal(running(test.child.pid), false)
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/rpc`, { signal: AbortSignal.timeout(1_000) })
    )
  }

  try {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const test = launch(signal)
      const port = await verifyState(test)
      test.child.kill(signal)
      await verifyStopped(test, port)
      results.push(`${signal}: graceful exit and RPC port closed`)
    }

    const disconnected = launch('disconnect')
    const disconnectedPort = await verifyState(disconnected)
    disconnected.child.disconnect()
    await verifyStopped(disconnected, disconnectedPort)
    results.push('IPC disconnect: graceful exit and RPC port closed')

    const repeated = launch('repeated-shutdown')
    const repeatedPort = await verifyState(repeated)
    repeated.child.kill('SIGTERM')
    repeated.child.kill('SIGINT')
    repeated.child.disconnect()
    await verifyStopped(repeated, repeatedPort)
    results.push('Repeated shutdown requests: graceful exit without errors')

    const early = launch('early-disconnect')
    early.child.disconnect()
    assert.deepEqual(await within(early.exited, 'Early IPC disconnect left WDK running'), {
      code: 0,
      signal: null
    })
    results.push('IPC disconnect during startup: no orphan')

    const abrupt = launch('parent-death', true)
    const walletPid = await within(abrupt.descendant, 'Fixture parent did not start WDK')
    const abruptPort = await verifyState(abrupt)
    abrupt.child.kill('SIGKILL')
    await within(abrupt.exited, 'Fixture parent did not exit')
    await waitUntilGone(walletPid)
    await assert.rejects(
      fetch(`http://127.0.0.1:${abruptPort}/rpc`, { signal: AbortSignal.timeout(1_000) })
    )
    results.push('Abrupt parent death: WDK exits and RPC port closes')

    for (const name of fs.readdirSync(directory)) {
      assert.deepEqual(
        fs.readdirSync(path.join(directory, name)),
        [],
        'No seed, wallet or model files may be created'
      )
    }
    results.push('Every temporary wallet directory stayed empty; only state RPC was called')
    console.log(JSON.stringify({ results }, null, 2))
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    // Exact PIDs created by this script only. Never searches for or stops the user's processes.
    for (const pid of [...children.map((child) => child.pid), ...descendants]) {
      if (!pid || !running(pid)) continue
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (running(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      await waitUntilGone(pid)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
