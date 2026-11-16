// Offline regression for the SDK's encrypted persistence. Run after build:wasm and build.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { chromium } from 'playwright'

const root = new URL('../packages/core-wasm/', import.meta.url)
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm' }
// Observe writes as they happen. A plaintext backup staged and then deleted
// from the SQLite pool would be invisible to the final disk scan.
const probe = `
  const write = FileSystemSyncAccessHandle.prototype.write
  const plaintextWrites = []
  FileSystemSyncAccessHandle.prototype.write = function (data, options) {
    const text = new TextDecoder().decode(data)
    for (const marker of ['SQLite format 3', 'private message - storage test', 'private attachment - storage test']) {
      if (text.includes(marker)) plaintextWrites.push(marker)
    }
    return write.call(this, data, options)
  }
  self.addEventListener('message', event => {
    if (event.data?.type === 'inspect-opfs-writes') {
      self.postMessage({ type: 'inspect-opfs-writes', plaintextWrites })
    }
  })
`
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost')
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Encrypted storage test</title>')
    return
  }
  if (!/^\/(dist|wasm-dist)\/[\w.-]+$/.test(pathname)) {
    response.writeHead(404).end()
    return
  }
  try {
    const observed = pathname === '/dist/observed-worker.js'
    const file = await readFile(new URL(observed ? 'dist/worker.js' : '.' + pathname, root))
    response.setHeader('Content-Type', types[extname(pathname)] ?? 'application/octet-stream')
    response.end(observed ? probe + file.toString('utf8') : file)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const browser = await chromium.launch(
  process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {},
)
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(async () => {
    const sdk = await import('/dist/index.js')
    const worker = new URL('/dist/observed-worker.js', location.href)
    const startCore = options => sdk.startCore(options, worker)
    const storageKey = crypto.getRandomValues(new Uint8Array(32))
    const databaseMarker = 'private message - storage test'
    const attachmentMarker = 'private attachment - storage test'
    const attachment = new Uint8Array(2 * 1024 * 1024)
    attachment.set(new TextEncoder().encode(attachmentMarker), 1024)
    const check = (value, label) => {
      if (!value) throw new Error(label)
    }
    const expectError = async (operation, message) => {
      try {
        await operation()
      } catch (error) {
        const detail = error instanceof Error ? error.message : JSON.stringify(error)
        check(detail.includes(message), `unexpected error: ${detail}`)
        return
      }
      throw new Error(`expected error: ${message}`)
    }

    async function readOpfsFiles(dir, result = []) {
      for await (const handle of dir.values()) {
        if (handle.kind === 'directory') {
          await readOpfsFiles(handle, result)
        } else {
          const bytes = await (await handle.getFile()).arrayBuffer()
          result.push(new TextDecoder().decode(bytes))
        }
      }
      return result
    }

    function inspectWrites(core) {
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          core.worker.removeEventListener('message', onMessage)
          resolve(['OPFS write observer did not respond'])
        }, 5000)
        function onMessage(event) {
          if (event.data?.type !== 'inspect-opfs-writes') return
          clearTimeout(timeout)
          core.worker.removeEventListener('message', onMessage)
          resolve(event.data.plaintextWrites)
        }
        core.worker.addEventListener('message', onMessage)
        core.worker.postMessage({ type: 'inspect-opfs-writes' })
      })
    }

    await expectError(() => startCore({ storageKey: new Uint8Array(31) }), 'storageKey')
    await expectError(() => startCore({ storageKey, persist: false }), 'storageKey')
    let core = startCore({ storageKey })
    let rpc = core.dc.rpc
    const account = await rpc.addAccount()
    await expectError(() => rpc.migrateAccount('/not-a-backup.db'), 'use importBackup')
    check((await rpc.getAllAccountIds()).join() === String(account), 'migration changed the registry')
    await rpc.setConfig(account, 'configured_addr', 'storage-test@example.invalid')
    const fingerprint = (await rpc.getChatSecurejoinQrCode(account, null)).match(/#[A-F0-9]{40}/i)?.[0]
    check(fingerprint, 'test identity did not initialize')
    const chat = await rpc.createChatByContactId(account, 1)
    const baseline = await core.fsFailed()
    const id = await rpc.miscSendTextMessage(account, chat, databaseMarker)
    await core.fsWrite('/input/photo.bin', attachment)
    const fileId = await rpc.sendMsg(account, chat, {
      text: null, html: null, viewtype: 'File', file: '/input/photo.bin', filename: 'photo.bin',
      location: null, overrideSenderName: null, quotedMessageId: null, quotedText: null,
      width: null, height: null, duration: null,
    })
    await core.fsRemove('/input')
    await core.fsWrite('/damaged.bin', attachment)

    let archivePath
    core.dc.on('ImexFileWritten', (accountId, event) => {
      if (accountId === account && event.path.endsWith('.tar')) archivePath = event.path
    })
    await rpc.exportBackup(account, '/exports', null)
    for (let i = 0; i < 50 && !archivePath; i++) await new Promise(resolve => setTimeout(resolve, 100))
    check(archivePath, 'backup export did not produce an archive')
    const archive = await core.fsRead(archivePath)
    const archiveText = new TextDecoder().decode(archive)
    check(archiveText.includes('SQLite format 3') && archiveText.includes(databaseMarker),
      'export is not a portable Delta Chat backup')
    const restoredAccount = await rpc.addAccount()
    await rpc.importBackup(restoredAccount, archivePath, null)
    check((await rpc.getMessage(restoredAccount, id)).text === databaseMarker,
      'imported database could not be read')

    const failedAccount = await rpc.addAccount()
    await core.fsWrite('/empty-backup.tar', new Uint8Array(1024))
    await expectError(() => rpc.importBackup(failedAccount, '/empty-backup.tar', null),
      'cannot import unpacked database')
    await rpc.setConfig(failedAccount, 'displayname', 'Recovered empty account')
    await rpc.removeAccount(failedAccount)
    check(await core.fsFlush(baseline) === 0, 'OPFS write failed')
    check((await inspectWrites(core)).length === 0, 'encrypted store wrote plaintext to OPFS')

    const opfs = await navigator.storage.getDirectory()
    const pool = await opfs.getDirectoryHandle('.opfs-sahpool-encrypted')
    const files = await readOpfsFiles(await pool.getDirectoryHandle('.opaque'))
    check(files.some(file => file.length > 8192), 'encrypted database was not stored')
    check(files.every(file => !file.includes('SQLite format 3') && !file.includes(databaseMarker)),
      'database contains plaintext')
    const mirror = await opfs.getDirectoryHandle('memfs-encrypted')
    const mirrorFiles = await readOpfsFiles(mirror)
    check(mirrorFiles.every(file => !file.includes(attachmentMarker)), 'mirror contains plaintext')
    core.worker.terminate()

    const damaged = await mirror.getFileHandle('damaged.bin')
    const writer = await damaged.createWritable()
    await writer.write('truncated encrypted file')
    await writer.close()

    const wrongKey = storageKey.slice()
    wrongKey[0] ^= 1
    core = startCore({ storageKey: wrongKey })
    await expectError(() => core.dc.rpc.getAllAccountIds(), 'wrong storage key')

    core = startCore()
    check((await core.dc.rpc.getAllAccountIds()).length === 0, 'unkeyed worker can see encrypted accounts')
    const legacyId = await core.dc.rpc.addAccount()
    await core.dc.rpc.setConfig(legacyId, 'displayname', 'Unencrypted control')
    await core.fsWrite('/import.tar', archive)
    const portableAccount = await core.dc.rpc.addAccount()
    await core.dc.rpc.importBackup(portableAccount, '/import.tar', null)
    check((await core.dc.rpc.getMessage(portableAccount, id)).text === databaseMarker,
      'ordinary store could not restore the portable archive')
    check(await core.fsFlush() === 0, 'ordinary OPFS write failed')
    check((await inspectWrites(core)).includes(databaseMarker), 'plaintext control did not observe OPFS writes')
    core.worker.terminate()

    core = startCore({ storageKey })
    rpc = core.dc.rpc
    check((await rpc.getAllAccountIds()).length === 2, 'encrypted account was lost')
    for (const accountId of [account, restoredAccount]) {
      check((await rpc.getMessage(accountId, id)).text === databaseMarker, 'message was lost')
      const restored = await core.fsRead((await rpc.getMessage(accountId, fileId)).file)
      check(restored.length === attachment.length && restored.every((byte, i) => byte === attachment[i]),
        'attachment changed on restart')
      check((await rpc.getChatSecurejoinQrCode(accountId, null)).includes(fingerprint), 'identity changed')
    }
    check(!await core.fsExists('/damaged.bin'), 'corrupted file was exposed')
    core.worker.terminate()

    core = startCore()
    check(await core.dc.rpc.getConfig(legacyId, 'displayname') === 'Unencrypted control',
      'ordinary account was lost')
    core.worker.terminate()
  })
  console.log('Encrypted database, attachments, portable backup, key validation, and ordinary store isolation passed')
} finally {
  await browser.close()
  server.close()
}
