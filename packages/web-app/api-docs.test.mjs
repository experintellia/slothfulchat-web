// The one runnable check behind api-docs.mjs's regex parsing: fixture snippets
// shaped like the real api.rs / events.rs, covering the cases that actually
// break a naive regex (wrapped signatures, tuple/generic params, banner
// grouping, fielded vs unit event variants). Dependency-free (node:test), no
// submodule needed — so it runs in CI's `lint` job.
//   node --test packages/web-app/api-docs.test.mjs
import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { parseEvents, parseMethods } from './api-docs.mjs'

const API = `
impl CommandApi {
    async fn not_an_rpc_method(&self) -> u32 { 0 }
}

#[rpc(all_positional, ts_outdir = "typescript/generated")]
impl CommandApi {
    /// Test function.
    async fn sleep(&self, delay: f64) {
    }

    // ---------------------------------------------
    //  Account Management
    // ---------------------------------------------

    async fn add_account(&self) -> Result<u32> {
    }

    /// Multi-line doc.
    ///
    /// Second paragraph mentioning \`Chat\`.
    #[allow(clippy::too_many_arguments)]
    async fn get_chatlist_entries(
        &self,
        account_id: u32,
        list_flags: Option<u32>,
        query: Option<String>,
    ) -> Result<Vec<u32>> {
    }

    async fn get_locations(&self, ranges: Vec<(u32, u32)>) -> Result<BTreeMap<String, u32>> {
    }
}

impl Something {
    async fn also_not_an_rpc_method(&self) {}
}
`

const EVENTS = `
pub enum EventType {
    /// Informational string.
    Info { msg: String },

    /// Emitted before going into IDLE.
    ImapInboxIdle,

    /// Like MsgRead, but fires on subsequent MDNs.
    #[serde(rename_all = "camelCase")]
    MsgReadCountChanged {
        /// ID of the chat.
        chat_id: u32,

        /// ID of the message that was read.
        msg_id: u32,
    },
}

impl From<CoreEventType> for EventType {
    fn from(event: CoreEventType) -> Self { todo!() }
}
`

const groups = parseMethods(API)
const byName = Object.fromEntries(groups.flatMap(g => g.methods).map(m => [m.name, m]))

test('only the #[rpc] impl block is scanned', () => {
  deepStrictEqual(Object.keys(byName).sort(), [
    'addAccount',
    'getChatlistEntries',
    'getLocations',
    'sleep',
  ])
})

test('banner comments group the methods', () => {
  deepStrictEqual(
    groups.map(g => [g.title, g.methods.length]),
    [
      ['General', 1],
      ['Account Management', 3],
    ]
  )
})

test('wrapped signature: params and return type survive the line breaks', () => {
  deepStrictEqual(byName.getChatlistEntries.params, [
    { name: 'accountId', type: 'number' },
    { name: 'listFlags', type: 'number | null' },
    { name: 'query', type: 'string | null' },
  ])
  strictEqual(byName.getChatlistEntries.returns, 'number[]')
})

test('doc paragraphs are kept; an attribute does not eat the doc block', () => {
  strictEqual(byName.getChatlistEntries.doc.join('\n').includes('Second paragraph'), true)
  deepStrictEqual(byName.addAccount.doc, [])
})

test('a comma inside a generic does not split a param', () => {
  deepStrictEqual(byName.getLocations.params, [{ name: 'ranges', type: '[number, number][]' }])
  strictEqual(byName.getLocations.returns, 'Record<string, number>')
})

test('a method with no return type is void', () => {
  strictEqual(byName.sleep.returns, 'void')
  deepStrictEqual(byName.sleep.params, [{ name: 'delay', type: 'number' }])
})

const events = parseEvents(EVENTS)

test('inline, unit and multi-line event variants, fields camelCased and documented', () => {
  deepStrictEqual(events.map(e => e.name), ['Info', 'ImapInboxIdle', 'MsgReadCountChanged'])
  deepStrictEqual(events[0].fields, [{ name: 'msg', type: 'string', doc: [] }])
  deepStrictEqual(events[1].fields, [])
  deepStrictEqual(
    events[2].fields.map(f => [f.name, f.type]),
    [
      ['chatId', 'number'],
      ['msgId', 'number'],
    ]
  )
  strictEqual(events[2].fields[1].doc.join(' ').includes('was read'), true)
  strictEqual(events[2].doc.join(' ').includes('subsequent MDNs'), true)
})
