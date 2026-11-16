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
  const getAccessHandle = FileSystemFileHandle.prototype.createSyncAccessHandle
  const shortWrites = new WeakSet()
  let shortWriteName
  let shortWriteLength
  let rejectedName
  const upgradeBlobLength = Number(new URL(location.href).searchParams.get('failUpgradeBlobLength'))
  FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...args) {
    if (this.name === rejectedName) throw new Error('legacy attachment path reached OPFS')
    const handle = await getAccessHandle.apply(this, args)
    if (this.name === shortWriteName || (upgradeBlobLength && /^[0-9a-f-]{36}$/.test(this.name))) {
      shortWrites.add(handle)
    }
    return handle
  }
  FileSystemSyncAccessHandle.prototype.write = function (data, options) {
    const text = new TextDecoder().decode(data)
    for (const marker of ['SQLite format 3', 'private message - storage test', 'private attachment - storage test']) {
      if (text.includes(marker)) plaintextWrites.push(marker)
    }
    // Simulate a real torn write before returning a short byte count. The
    // replacement has a different length from the saved fixture, so saving
    // the old ciphertext in the recovery copy succeeds.
    if (shortWrites.has(this) && data.byteLength === (shortWriteLength ?? upgradeBlobLength) && options?.at === 0) {
      return write.call(this, data.subarray(0, 12), options)
    }
    return write.call(this, data, options)
  }
  self.addEventListener('message', event => {
    if (event.data?.type === 'reject-opfs-name') rejectedName = event.data.name
    if (event.data?.type === 'short-write') {
      shortWriteName = event.data.name
      shortWriteLength = event.data.length
    }
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
    const id = await rpc.miscSendTextMessage(account, chat, databaseMarker)
    check(await core.fsFlush() === 0, 'OPFS write failed')
    check((await inspectWrites(core)).length === 0, 'encrypted database wrote plaintext')
    core.worker.terminate()

    const opfs = await navigator.storage.getDirectory()
    const pool = await opfs.getDirectoryHandle('.opfs-sahpool-encrypted')
    const verifier = await pool.getFileHandle('key-check')
    const badVerifier = new Uint8Array(32)
    const keyWriter = await verifier.createWritable()
    await keyWriter.write(badVerifier)
    await keyWriter.close()

    const wrongKey = storageKey.slice()
    wrongKey[0] ^= 1
    core = startCore({ storageKey: wrongKey })
    await expectError(() => core.dc.rpc.getAllAccountIds(), 'wrong storage key')
    check(new Uint8Array(await (await verifier.getFile()).arrayBuffer()).every(byte => byte === 0),
      'wrong key replaced the damaged verifier')

    core = startCore({ storageKey })
    rpc = core.dc.rpc
    check((await rpc.getMessage(account, id)).text === databaseMarker, 'could not recover key check')
    check(new Uint8Array(await (await verifier.getFile()).arrayBuffer()).some(byte => byte !== 0),
      'correct key did not repair verifier')

    const baseline = await core.fsFailed()
    const staged = await core.stageFile('report with a private name.bin', attachment)
    check(/^\/tmp\/[0-9a-f-]{36}$/.test(staged.file), 'encrypted staging path reveals the filename')
    check(await core.fsFlush(baseline) === 0, 'staged attachment was not persisted')
    const stagedDir = await (await opfs.getDirectoryHandle('memfs-encrypted')).getDirectoryHandle('tmp')
    await stagedDir.getFileHandle(staged.file.split('/').pop())
    const fileId = await rpc.sendMsg(account, chat, {
      text: null, html: null, viewtype: 'File', ...staged,
      location: null, overrideSenderName: null, quotedMessageId: null, quotedText: null,
      width: null, height: null, duration: null,
    })
    await core.fsRemove(staged.file)
    await core.fsWrite('/damaged.bin', attachment)

    const today = new Date().toISOString().slice(0, 10)
    const previousExport = `/exports/delta-chat-backup-${today}-04-legacy@example.invalid.tar`
    await core.fsWrite(previousExport, new Uint8Array([0]))
    let archivePath
    core.dc.on('ImexFileWritten', (accountId, event) => {
      if (accountId === account && event.path.endsWith('.tar')) archivePath = event.path
    })
    await rpc.exportBackup(account, '/exports', null)
    for (let i = 0; i < 50 && !archivePath; i++) await new Promise(resolve => setTimeout(resolve, 100))
    check(archivePath, 'backup export did not produce an archive')
    check(/^\/exports\/delta-chat-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar$/.test(archivePath),
      'encrypted backup name contains account details')
    const firstArchivePath = archivePath
    check(firstArchivePath > previousExport, 'new archive sorts before an older export')
    await core.fsRemove(previousExport)
    const archive = await core.fsRead(firstArchivePath)
    const archiveText = new TextDecoder().decode(archive)
    check(archiveText.includes('SQLite format 3') && archiveText.includes(databaseMarker),
      'export is not a portable Delta Chat backup')
    const restoredAccount = await rpc.addAccount()
    const originalFile = await rpc.getMessage(account, fileId)
    await expectError(() => core.restoreBackup(restoredAccount, new Uint8Array()), 'Backup is empty')
    core.worker.postMessage({ type: 'reject-opfs-name', name: originalFile.file.split('/').pop() })
    await core.restoreBackup(restoredAccount, archive)
    core.worker.postMessage({ type: 'reject-opfs-name' })
    const restoredFile = await rpc.getMessage(restoredAccount, fileId)
    check(/^[0-9a-f-]{36}$/.test(restoredFile.file.split('/').pop()),
      'restore retained the original blob name')
    check(restoredFile.file.split('/').pop() !== originalFile.file.split('/').pop(),
      'restore did not assign a new blob name')
    check((await rpc.getMessage(restoredAccount, id)).text === databaseMarker,
      'imported database could not be read')
    await Promise.all([
      rpc.exportBackup(account, '/exports', null),
      rpc.exportBackup(restoredAccount, '/exports', null),
    ])

    await rpc.exportSelfKeys(account, '/keys', null)
    const keyImportAccount = await rpc.addAccount()
    await rpc.importSelfKeys(keyImportAccount, '/keys')
    await rpc.setConfig(keyImportAccount, 'configured_addr', 'storage-test@example.invalid')
    check((await rpc.getChatSecurejoinQrCode(keyImportAccount, null)).includes(fingerprint),
      'could not restore the default key from opaque exports')
    await rpc.removeAccount(keyImportAccount)

    const failedAccount = await rpc.addAccount()
    await core.fsWrite('/empty-backup.tar', new Uint8Array(1024))
    await expectError(() => rpc.importBackup(failedAccount, '/empty-backup.tar', null),
      'cannot import unpacked database')
    await rpc.setConfig(failedAccount, 'displayname', 'Recovered empty account')
    await rpc.removeAccount(failedAccount)
    check(await core.fsFlush(baseline) === 0, 'OPFS write failed')
    check((await inspectWrites(core)).length === 0, 'encrypted store wrote plaintext to OPFS')

    const files = await readOpfsFiles(await pool.getDirectoryHandle('.opaque'))
    check(files.some(file => file.length > 8192), 'encrypted database was not stored')
    check(files.every(file => !file.includes('SQLite format 3') && !file.includes(databaseMarker)),
      'database contains plaintext')
    const mirror = await opfs.getDirectoryHandle('memfs-encrypted')
    const archives = (await Array.fromAsync((await mirror.getDirectoryHandle('exports')).keys())).sort()
    check(archives.length === 3 && `/exports/${archives[0]}` === firstArchivePath &&
      archives.every(name => /^delta-chat-backup-\d{4}-\d{2}-\d{2}-\d{2}\.tar$/.test(name)),
      'parallel encrypted backup exports did not publish distinct sortable names')
    const keyNames = await Array.fromAsync((await mirror.getDirectoryHandle('keys')).keys())
    check(keyNames.length === 2 && keyNames.every(name =>
      /^(public|private)-key-0-[0-9a-f-]{36}\.asc$/.test(name)),
      'key export filenames contain account details')
    const mirrorFiles = await readOpfsFiles(mirror)
    check(mirrorFiles.every(file => !file.includes(attachmentMarker)), 'mirror contains plaintext')
    core.worker.terminate()

    const damaged = await mirror.getFileHandle('damaged.bin')
    const writer = await damaged.createWritable()
    await writer.write('truncated encrypted file')
    await writer.close()

    core = startCore({ storageKey: wrongKey })
    await expectError(() => core.dc.rpc.getAllAccountIds(), 'wrong storage key')

    core = startCore()
    check((await core.dc.rpc.getAllAccountIds()).length === 0, 'unkeyed worker can see encrypted accounts')
    const legacyId = await core.dc.rpc.addAccount()
    await core.dc.rpc.setConfig(legacyId, 'displayname', 'Unencrypted control')
    const ordinary = await core.stageFile('ordinary.txt', new Uint8Array([1]))
    check(ordinary.file.endsWith('/ordinary.txt'), 'ordinary staging path changed')
    await core.fsRemove(ordinary.file)
    await core.fsWrite('/import.tar', archive)
    const portableAccount = await core.dc.rpc.addAccount()
    await core.dc.rpc.importBackup(portableAccount, '/import.tar', null)
    check((await core.dc.rpc.getMessage(portableAccount, id)).text === databaseMarker,
      'ordinary store could not restore the portable archive')
    const portableFile = await core.dc.rpc.getMessage(portableAccount, fileId)
    check(portableFile.file.split('/').pop() === originalFile.file.split('/').pop(),
      'ordinary restore changed the original blob name')
    check(await core.fsFlush() === 0, 'ordinary OPFS write failed')
    check((await inspectWrites(core)).includes(databaseMarker), 'plaintext control did not observe OPFS writes')
    core.worker.terminate()

    core = startCore({ storageKey })
    rpc = core.dc.rpc
    check((await rpc.getAllAccountIds()).length === 2, 'encrypted account was lost')
    for (const accountId of [account, restoredAccount]) {
      check((await rpc.getMessage(accountId, id)).text === databaseMarker, 'message was lost')
      const message = await rpc.getMessage(accountId, fileId)
      check(message.fileName === staged.filename, 'attachment display name was lost')
      const restored = await core.fsRead(message.file)
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
  const fileOnlyPage = await browser.newPage()
  await fileOnlyPage.goto(`http://127.0.0.1:${server.address().port}`)
  await fileOnlyPage.evaluate(async () => {
    const sdk = await import('/dist/index.js')
    const worker = new URL('/dist/observed-worker.js', location.href)
    const startCore = options => sdk.startCore(options, worker)
    const storageKey = crypto.getRandomValues(new Uint8Array(32))
    const wrongKey = storageKey.slice()
    wrongKey[0] ^= 1

    let core = startCore({ storageKey })
    await core.fsWrite('/test.bin', new Uint8Array([7]))
    if (await core.fsFlush() !== 0) throw new Error('file-only OPFS write failed')
    async function failReplacement(bytes) {
      const before = await core.fsFailed()
      // The encrypted file adds a 24-byte nonce and a 16-byte tag.
      core.worker.postMessage({ type: 'short-write', name: 'test.bin', length: bytes.byteLength + 40 })
      await core.fsWrite('/test.bin', bytes)
      if (await core.fsFlush(before) !== 1) throw new Error('short write was not reported')
    }
    await failReplacement(new Uint8Array([8, 9]))
    core.worker.terminate()

    const opfs = await navigator.storage.getDirectory()
    const pool = await opfs.getDirectoryHandle('.opfs-sahpool-encrypted')
    await pool.removeEntry('key-check')
    core = startCore({ storageKey: wrongKey })
    let error
    try {
      await core.dc.rpc.getAllAccountIds()
    } catch (err) {
      error = err
    }
    core.worker.terminate()
    if (!error?.message.includes('wrong storage key')) throw new Error('wrong key accepted for file-only store')

    core = startCore({ storageKey })
    const restored = await core.fsRead('/test.bin')
    if (restored.length !== 1 || restored[0] !== 7) throw new Error('previous contents lost after short write')
    await core.fsWrite('/test.bin', new Uint8Array([8, 9]))
    if (await core.fsFlush() !== 0) throw new Error('replacement after short write failed')
    core.worker.terminate()

    core = startCore({ storageKey })
    if ((await core.fsRead('/test.bin')).join() !== '8,9') throw new Error('replacement was not persisted')
    const recovery = await opfs.getDirectoryHandle('memfs-encrypted-recovery')
    if (!(await recovery.keys().next()).done) throw new Error('committed write left a recovery copy')
    await failReplacement(new Uint8Array([10, 11, 12]))
    const failures = await core.fsFailed()
    await core.fsRemove('/test.bin')
    if (await core.fsFlush(failures) !== 0) throw new Error('deletion after short write failed')
    if (!(await recovery.keys().next()).done) throw new Error('deletion left a recovery copy')
    core.worker.terminate()

    core = startCore({ storageKey })
    if (await core.fsExists('/test.bin')) throw new Error('deletion resurrected the previous contents')
    core.worker.terminate()
  })
  const upgradePage = await browser.newPage()
  await upgradePage.goto(`http://127.0.0.1:${server.address().port}`)
  await upgradePage.evaluate(async () => {
    const { startCore, upgradeAccountStorage } = await import('/dist/index.js')
    const key = crypto.getRandomValues(new Uint8Array(32))
    const worker = new URL('/dist/observed-worker.js', location.href)
    const check = (ok, message) => { if (!ok) throw new Error(message) }
    let core = startCore({}, worker)
    const account = await core.dc.rpc.addAccount()
    const other = await core.dc.rpc.addAccount()
    await core.dc.rpc.setConfig(account, 'configured_addr', 'upgrade-test@example.invalid')
    await core.dc.rpc.setConfig(account, 'bcc_self', '0')
    const fingerprint = (await core.dc.rpc.getChatSecurejoinQrCode(account, null)).match(/#[A-F0-9]{40}/i)?.[0]
    check(fingerprint, 'upgrade fixture could not initialize its identity')
    const chat = await core.dc.rpc.createChatByContactId(account, 1)
    const text = 'private message - storage test'
    const id = await core.dc.rpc.miscSendTextMessage(account, chat, text)
    const data = new TextEncoder().encode('private attachment - storage test')
    const originalName = 'report.private-legacy-extension'
    const staged = await core.stageFile(originalName, data)
    const fileId = await core.dc.rpc.sendMsg(account, chat, {
      text: null, html: null, viewtype: 'File', ...staged,
      location: null, overrideSenderName: null, quotedMessageId: null, quotedText: null,
      width: null, height: null, duration: null,
    })
    await core.fsRemove(staged.file)
    const file = (await core.dc.rpc.getMessage(account, fileId)).file
    await core.fsWrite(file + '.waveform', new Uint8Array([5]))
    check(await core.fsFlush() === 0, 'ordinary upgrade fixture not persisted')
    core.worker.terminate()

    core = startCore({ storageKey: key }, worker)
    const existing = await core.dc.rpc.addAccount()
    core.worker.terminate()

    const wrongKey = key.slice()
    wrongKey[0] ^= 1
    let failed = false
    try {
      await upgradeAccountStorage(account, wrongKey, worker)
    } catch (error) {
      failed = error.message.includes('wrong storage key')
    }
    check(failed, 'upgrade accepted the wrong destination key')

    const faultyWorker = new URL(worker)
    faultyWorker.searchParams.set('failUpgradeBlobLength', String(data.length + 40))
    failed = false
    try {
      await upgradeAccountStorage(account, key, faultyWorker)
    } catch (error) {
      failed = error.message.includes('Account files did not reach encrypted storage')
    }
    check(failed, 'upgrade accepted an attachment write failure')

    core = startCore({}, worker)
    check((await core.dc.rpc.getMessage(account, id)).text === text, 'failed upgrade removed its source')
    core.worker.terminate()

    const upgraded = await upgradeAccountStorage(account, key, worker)
    core = startCore({ storageKey: key }, worker)
    const accounts = await core.dc.rpc.getAllAccountIds()
    check(accounts.length === 2 && accounts.includes(existing) && accounts.includes(upgraded),
      'upgrade removed an existing account or left an incomplete account behind')
    check((await core.dc.rpc.getMessage(upgraded, id)).text === text, 'upgrade lost the message')
    check(await core.dc.rpc.getConfig(upgraded, 'bcc_self') === '0', 'upgrade changed the account configuration')
    check((await core.dc.rpc.getChatSecurejoinQrCode(upgraded, null)).includes(fingerprint),
      'upgrade replaced the identity')
    const restored = await core.dc.rpc.getMessage(upgraded, fileId)
    check(restored.fileName === originalName, 'upgrade lost the attachment display name')
    check(/^[0-9a-f-]{36}$/.test(restored.file.split('/').pop()), 'upgrade kept the original blob name')
    check((await core.fsRead(restored.file)).join() === data.join(), 'upgraded attachment bytes changed')
    check((await core.fsRead(restored.file + '.waveform')).join() === '5', 'upgrade lost the waveform sidecar')
    core.worker.terminate()

    core = startCore({}, worker)
    check((await core.dc.rpc.getAllAccountIds()).join() === String(other), 'upgrade removed the wrong ordinary account')
    core.worker.terminate()

    const opfs = await navigator.storage.getDirectory()
    async function inspectDirectory(dir) {
      for await (const handle of dir.values()) {
        check(handle.name !== '.storage-transfer', 'temporary data reached OPFS')
        check(!handle.name.includes('private-legacy-extension'), 'attachment name still present in OPFS')
        if (handle.kind === 'directory') {
          await inspectDirectory(handle)
        } else {
          const content = new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())
          check(!content.includes(text), 'plaintext message still present in OPFS')
        }
      }
    }
    await inspectDirectory(opfs)
  })
  console.log('Encrypted storage, short-write recovery, portable backups, and storage upgrade checks passed')
} finally {
  await browser.close()
  server.close()
}
