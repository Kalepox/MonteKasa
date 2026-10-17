// Starts the Node 22 wallet service (wallet-service/server.mjs) and talks to it over local HTTP.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { rgbConfig } from './config'

export class WalletService {
  private child?: ChildProcess
  private port?: number
  private starting?: Promise<void>
  private readonly token = randomBytes(32).toString('hex') // new for every app run

  private start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const dir = app.isPackaged
        ? join(process.resourcesPath, 'wallet-service')
        : join(app.getAppPath(), 'wallet-service')
      const child = spawn(rgbConfig.walletNode, ['server.mjs'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          WALLET_DATA_DIR: join(app.getPath('userData'), 'wdk-wallet'),
          WALLET_TOKEN: this.token,
          WALLET_ASSET_ID: rgbConfig.assetId,
          WALLET_MAX_SEND_RAW: String(rgbConfig.walletMaxSendRaw)
        }
      })
      this.child = child
      const timer = setTimeout(() => reject(new Error('Wallet service did not start within 30 s')), 30_000)

      let buffer = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (const line of buffer.split('\n').slice(0, -1)) {
          try {
            const msg = JSON.parse(line) as { ready?: boolean; port?: number }
            if (msg.ready && msg.port) {
              this.port = msg.port
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
      child.on('exit', (code) => {
        clearTimeout(timer)
        this.child = this.port = this.starting = undefined
        reject(new Error(`Wallet service exited (code ${code}). Is WALLET_NODE a Node 22 binary?`))
      })
    })
    return this.starting
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start()
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

  stop(): void {
    this.child?.kill('SIGTERM')
  }
}
