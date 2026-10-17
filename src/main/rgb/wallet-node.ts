// RGB's native addon requires Node 22; Electron and the development CLI can use other versions.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function isNode22(binary: string): boolean {
  try {
    return /^v22\./.test(
      execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    )
  } catch {
    return false
  }
}

export function resolveWalletNode(explicit?: string): string {
  if (explicit !== undefined) {
    if (explicit.trim() && isNode22(explicit)) return explicit
    throw new Error(
      'WALLET_NODE must point to a working Node.js 22 executable. Update it and restart the app.'
    )
  }
  if (isNode22('node')) return 'node'

  const versions = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node')
  let installed: string[] = []
  try {
    installed = readdirSync(versions)
      .filter((version) => /^v22\.\d+\.\d+$/.test(version))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(versions, version, 'bin', 'node'))
  } catch {
    // NVM is optional; Homebrew and an explicit WALLET_NODE are supported too.
  }
  for (const binary of [
    ...installed,
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node'
  ]) {
    if (isNode22(binary)) return binary
  }
  throw new Error(
    'The WDK wallet needs Node.js 22. Install it, or set WALLET_NODE to its executable, then restart the app.'
  )
}
