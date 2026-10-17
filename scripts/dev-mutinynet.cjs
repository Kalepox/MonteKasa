/* eslint-disable @typescript-eslint/no-require-imports -- Node launcher uses CommonJS. */
// Explicit development profile for the team's Mutinynet RGB node.
// Checkpoint 100000 was cross-checked against both HTTPS sources below.
const { spawn } = require('node:child_process')
const { resolve } = require('node:path')

if (process.env.RGB_NETWORK && process.env.RGB_NETWORK !== 'SignetCustom') {
  throw new Error('dev:mutinynet requires RGB_NETWORK=SignetCustom.')
}
const child = spawn(
  process.execPath,
  [resolve(__dirname, '../node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--watch'],
  {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      RGB_NETWORK: 'SignetCustom',
      RGB_NODE_CHAIN_API:
        process.env.RGB_NODE_CHAIN_API ?? 'https://esplora.signet.kaleidoswap.com',
      RGB_EXPLORER_API: process.env.RGB_EXPLORER_API ?? 'https://mutinynet.com/api',
      RGB_CHAIN_CHECKPOINT_HEIGHT: process.env.RGB_CHAIN_CHECKPOINT_HEIGHT ?? '100000',
      RGB_CHAIN_CHECKPOINT_HASH:
        process.env.RGB_CHAIN_CHECKPOINT_HASH ??
        '00000166f046342c6b499798686eb13cd2b4c6e5fd4189157922dca54705eb71'
    }
  }
)
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
