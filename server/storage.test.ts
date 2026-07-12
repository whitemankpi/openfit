import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EncryptedStore } from './storage.js'

const directories: string[] = []

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))

describe('EncryptedStore', () => {
  it('round-trips data without writing plaintext', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-store-'))
    directories.push(directory)
    const store = new EncryptedStore(directory, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')

    store.write('credentials.json', { secret: 'health-token' })

    expect(store.read('credentials.json', null)).toEqual({ secret: 'health-token' })
    expect(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8')).not.toContain('health-token')
  })

  it('cannot decrypt with another key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openfit-store-'))
    directories.push(directory)
    new EncryptedStore(directory, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').write('cache.json', { value: 42 })

    const other = new EncryptedStore(directory, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')
    expect(other.read('cache.json', null)).toBeNull()
  })
})
