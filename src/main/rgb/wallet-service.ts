// Starts the Node 22 wallet service (wallet-service/server.mjs) and talks to it over local HTTP.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { rgbConfig } from './config'
import { resolveWalletNode } from './wallet-node'

export class WalletService {
  private child?: ChildProcess
  private port?: number
  private starting?: Promise<void>
  private runtime?: string
  private abortStart?: () => void
  private stopped = false
  private readonly terminating = new Map<ChildProcess, Promise<void>>()
  private readonly token = randomBytes(32).toString('hex') // new for every app run

  private start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Wallet service has stopped.'))
    if (this.port && this.child) return Promise.resolve()
    if (this.starting) return this.starting
    const attempt = Promise.resolve().then(async () => {
      // A failed startup must finish exiting before a retry opens the same wallet.
      await Promise.all(this.terminating.values())
      return this.launch()
    })
    this.starting = attempt
    // Clear failed attempts so Retry can start a new process.
    void attempt
      .finally(() => {
        if (this.starting === attempt) this.starting = undefined
      })
      .catch(() => {})
    return attempt
  }

  private launch(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Wallet service has stopped.'))
    const runtime = this.runtime ?? resolveWalletNode(rgbConfig.walletNode)
    return new Promise<void>((resolve, reject) => {
      const dir = app.isPackaged
        ? join(process.resourcesPath, 'wallet-service')
        : join(app.getAppPath(), 'wallet-service')
      const child = spawn(runtime, ['server.mjs'], {
        cwd: dir,
        // IPC is a lifetime signal, not an RPC interface. The service exits when
        // Electron disappears, including SIGTERM restarts and parent crashes.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          WALLET_DATA_DIR: join(app.getPath('userData'), 'wdk-wallet'),
          WALLET_TOKEN: this.token,
          WALLET_PARENT_PIPE: '1',
          WALLET_ASSET_ID: rgbConfig.assetId,
          WALLET_MAX_SEND_RAW: String(rgbConfig.walletMaxSendRaw)
        }
      })
      this.child = child
      let settled = false
      const fail = (error: Error, terminate = false): void => {
        clearTimeout(timer)
        if (this.child === child) {
          this.child = undefined
          this.port = undefined
          this.abortStart = undefined
        }
        if (!settled) {
          settled = true
          reject(error)
        }
        if (terminate) this.terminate(child)
      }
      const timer = setTimeout(
        () => fail(new Error('Wallet service did not start within 30 s. Try again.'), true),
        30_000
      )
      this.abortStart = () => fail(new Error('Wallet service startup was stopped.'), true)

      let buffer = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (const line of buffer.split('\n').slice(0, -1)) {
          try {
            const msg = JSON.parse(line) as { ready?: boolean; port?: number }
            if (
              !settled &&
              msg.ready &&
              Number.isInteger(msg.port) &&
              msg.port! > 0 &&
              msg.port! <= 65_535
            ) {
              settled = true
              this.port = msg.port
              this.runtime = runtime
              this.abortStart = undefined
              clearTimeout(timer)
              resolve()
            }
          } catch {
            /* not JSON: ignore */
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
      })
      child.stderr!.on('data', (d: Buffer) => console.error('[wallet]', d.toString().trim()))
      child.on('error', (error) =>
        fail(new Error(`Could not start the WDK wallet service: ${error.message}`), true)
      )
      child.on('exit', (code) => {
        fail(
          new Error(
            code === 2
              ? 'Another app is already using this wallet. Close the other MonteKasa window first.'
              : `Wallet service exited (code ${code}). Check that wallet-service dependencies are installed for Node.js 22.`
          )
        )

      })
    })
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start()
    if (this.stopped) throw new Error('Wallet service has stopped.')
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(120_000) // sends and refreshes can take a while
      })
    } catch (e) {
      // undici only says "fetch failed"; the real reason (ECONNRESET, ECONNREFUSED, timeout) is in `cause`
      const cause = (e as { cause?: { code?: string; message?: string } }).cause
      const why = cause?.code ?? cause?.message ?? (e as Error).name
      throw new Error(`Wallet service unreachable during '${method}' (${why})`)
    }
    const body = (await res.json()) as { result?: T; error?: string }
    if (body.error) throw new Error(body.error)
    return body.result as T
  }

  private terminate(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (this.terminating.has(child)) return
    let exited!: () => void
    this.terminating.set(child, new Promise<void>((resolve) => (exited = resolve)))
    const timeout = setTimeout(() => child.kill('SIGKILL'), 6000)
    timeout.unref()
    child.once('exit', () => {
      clearTimeout(timeout)
      this.terminating.delete(child)
      exited()
    })
    child.kill('SIGTERM')
  }

  stop(): void {
    this.stopped = true
    if (this.abortStart) this.abortStart()
    else {
      if (this.child) this.terminate(this.child)
      this.child = undefined
      this.port = undefined
    }
  }
}
