// Offline regression for the SDK's encrypted persistence. Run after build:wasm and build.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { chromium } from 'playwright'

const root = new URL('../packages/core-wasm/', import.meta.url)
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm' }
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
    const file = await readFile(new URL('.' + pathname, root))
    response.setHeader('Content-Type', types[extname(pathname)] ?? 'application/octet-stream')
    response.end(file)
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
    const { startCore } = await import('/dist/index.js')
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
        check(String(error).includes(message), `unexpected error: ${error}`)
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

    await expectError(() => startCore({ storageKey: new Uint8Array(31) }), 'storageKey')
    await expectError(() => startCore({ storageKey, persist: false }), 'storageKey')
    let core = startCore({ storageKey })
    let rpc = core.dc.rpc
    const account = await rpc.addAccount()
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
    check(await core.fsFlush(baseline) === 0, 'OPFS write failed')

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
    check(await core.fsFlush() === 0, 'ordinary OPFS write failed')
    core.worker.terminate()

    core = startCore({ storageKey })
    rpc = core.dc.rpc
    check((await rpc.getAllAccountIds()).length === 1, 'encrypted account was lost')
    check((await rpc.getMessage(account, id)).text === databaseMarker, 'message was lost')
    const restored = await core.fsRead((await rpc.getMessage(account, fileId)).file)
    check(restored.length === attachment.length && restored.every((byte, i) => byte === attachment[i]),
      'attachment changed on restart')
    check(!await core.fsExists('/damaged.bin'), 'corrupted file was exposed')
    check((await rpc.getChatSecurejoinQrCode(account, null)).includes(fingerprint), 'identity changed')
    core.worker.terminate()

    core = startCore()
    check(await core.dc.rpc.getConfig(legacyId, 'displayname') === 'Unencrypted control',
      'ordinary account was lost')
    core.worker.terminate()
  })
  console.log('Encrypted database, attachments, key validation, and ordinary store isolation passed')
} finally {
  await browser.close()
  server.close()
}
