import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

interface Envelope {
  version: 1
  iv: string
  tag: string
  data: string
}

function encryptionKey(value: string): Buffer {
  const trimmed = value.trim()
  if (/^[a-f\d]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex')
  try {
    const decoded = Buffer.from(trimmed, 'base64')
    if (decoded.length === 32) return decoded
  } catch { /* validated below */ }
  throw new Error('OPENFIT_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64.')
}

export class EncryptedStore {
  readonly #directory: string
  readonly #key: Buffer

  constructor(directory: string, key: string) {
    this.#directory = directory
    this.#key = encryptionKey(key)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  read<T>(name: string, fallback: T): T {
    try {
      const envelope = JSON.parse(fs.readFileSync(this.#file(name), 'utf8')) as Envelope
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
      return JSON.parse(clear.toString('utf8')) as T
    } catch {
      return fallback
    }
  }

  write(name: string, value: unknown): void {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }
    const file = this.#file(name)
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 })
    fs.renameSync(temporary, file)
  }

  delete(name: string): void {
    fs.rmSync(this.#file(name), { force: true })
  }

  #file(name: string): string {
    return path.join(this.#directory, name)
  }
}
