import fs from 'node:fs'
import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto'

const kdf = (password, salt) => scryptSync(password, salt, 32, {N: 2** 15, r:8, p:1, maxmem:64 *1024*1024})

export function saveSeed(file, mnemonic, password){
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', kdf(password, salt), iv)
    const data = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()])
    const out = { v: 1, salt, iv, tag: cipher.getAuthTag(), data }
    const b64 = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('base64') : v]))
    fs.writeFileSync(file, JSON.stringify(b64), { mode: 0o600 })
}


export function loadSeed(file, password){
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  const b = (k) => Buffer.from(s[k], 'base64')
  const decipher = createDecipheriv('aes-256-gcm', kdf(password, b('salt')), b('iv'))
  decipher.setAuthTag(b('tag'))
  try {
    return Buffer.concat([decipher.update(b('data')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Wrong password')
  }
}