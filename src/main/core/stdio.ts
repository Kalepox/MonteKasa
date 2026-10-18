import type { Writable } from 'node:stream'

// A desktop app may outlive the terminal that launched it. Losing that terminal
// must not turn an otherwise harmless console warning into a fatal exception.
export function guardDisconnectedOutput(stream: Writable): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EIO' || error.code === 'EPIPE') return
    throw error
  })
}
