// Helper for harness.test.mjs: the watchdog calls process.exit, so it has to
// be observed from a child process rather than in the test's own.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServers } from './harness.mjs'

const dir = await mkdtemp(join(tmpdir(), 'harness-watchdog-'))
await writeFile(join(dir, 'main.html'), '<p>up</p>')

await startServers({
  app: 8763,
  appRoot: dir,
  settleMs: 100,
  watchdogMs: 300,
  label: 'wedged-example',
})

// Never finish — the watchdog is what must end this process.
await new Promise(() => {})
