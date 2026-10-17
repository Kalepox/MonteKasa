import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { guardDisconnectedOutput } from './stdio'

describe('disconnected terminal output', () => {
  it.each(['EIO', 'EPIPE'])('handles %s on an output stream', async (code) => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('Disconnected terminal'), { code }))
      }
    })
    guardDisconnectedOutput(output)
    const closed = new Promise<void>((resolve) => output.on('close', resolve))
    output.write('warning\n')
    await closed
    expect(output.destroyed).toBe(true)
  })
  it('does not suppress unrelated stream failures', () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    guardDisconnectedOutput(output)
    const error = Object.assign(new Error('Unexpected failure'), { code: 'EINVAL' })
    expect(() => output.emit('error', error)).toThrow(error)
  })
})
