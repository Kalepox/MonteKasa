// Starts the Node 22 wallet service (wallet-service/server.mjs) and talks to it over local HTTP.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { rgbConfig } from './config'

// turns a failed wallet-service start into an instruction a new user can follow
function startFailure(code: number | null, stderr: string, node: string): string {
  if (code === 2)
    return 'Another app is already using this wallet. Close the other MonteKasa window first.'
  if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(stderr))
    return 'The wallet service is not installed yet. In the project folder run: cd wallet-service && nvm exec 22 npm install'
  if (
    /NODE_MODULE_VERSION|was compiled against|ERR_DLOPEN_FAILED|invalid ELF|wrong ELF|incompatible architecture/.test(
      stderr
    )
  )
    return `The wallet service needs Node.js 22, but "${node}" is a different version. Run: nvm install 22, then reinstall with: cd wallet-service && nvm exec 22 npm install`
  return `Wallet service exited (code ${code}). See the [wallet] lines in the terminal. It needs Node.js 22 ("${node}").`
}

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
        stdio: ['pipe', 'pipe', 'pipe'], // stdin stays open: the service exits when it closes (we died)
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
      let stderr = '' // last output, to explain a failed start in plain words
      const fail = (error: Error): void => {
        clearTimeout(timer)
        this.child = this.port = this.starting = undefined // so "Try again" starts a fresh service
        reject(error)
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        fail(new Error('Wallet service did not start within 30 s. Try again.'))
      }, 30_000)
      child.on('error', (e) =>
        fail(
          new Error(
            `Could not start the wallet service with "${rgbConfig.walletNode}": ${e.message}. Install Node.js 22 (nvm install 22).`
          )
        )
      )

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
      child.stderr!.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000)
        console.error('[wallet]', d.toString().trim())
      })
      child.on('exit', (code) => {
        if (!this.starting) return // already failed (timeout / spawn error)
        fail(new Error(startFailure(code, stderr, rgbConfig.walletNode)))
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
