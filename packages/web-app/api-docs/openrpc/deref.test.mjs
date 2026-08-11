import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import { dereference } from './deref.mjs'

const doc = (schemas, methods) => ({ openrpc: '1.0.0', methods, components: { schemas } })

test('inlines a local $ref and keeps a title to name it by', () => {
  const out = dereference(
    doc({ ChatId: { type: 'integer', description: 'a chat' } }, [
      { name: 'get_chat', params: [{ name: 'id', schema: { $ref: '#/components/schemas/ChatId' } }] },
    ]),
  )
  deepEqual(out.methods[0].params[0].schema, {
    type: 'integer',
    description: 'a chat',
    title: 'ChatId',
  })
})

test('a self-recursive type terminates instead of expanding forever', () => {
  const out = dereference(
    doc({ Node: { type: 'object', properties: { kid: { $ref: '#/components/schemas/Node' } } } }, [
      { name: 'tree', result: { schema: { $ref: '#/components/schemas/Node' } } },
    ]),
  )
  const node = out.methods[0].result.schema
  equal(node.properties.kid, node, 'the cycle resolves back to the same object')
  equal(node.title, 'Node')
})

// The external ref carries a FRAGMENT on purpose: a fragment-less URL passes
// however sloppily the prefix is matched. `other.json#/components/schemas/Foo`
// is what an unanchored strip mangles into `other.jsonFoo`.
test('leaves a non-local $ref alone rather than inventing an empty schema', () => {
  const ref = { $ref: 'https://example.invalid/other.json#/components/schemas/Foo' }
  const out = dereference(doc({}, [{ name: 'x', result: { schema: ref } }]))
  deepEqual(out.methods[0].result.schema, ref)
})
