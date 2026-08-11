// Inline an OpenRPC document's `$ref`s, for @open-rpc/docs-react.
//
// docs-react renders a schema tree; it has no resolver and no notion of
// `#/components/schemas/…`, so handing it the raw document draws methods with
// empty parameters and results. Every $ref yerpc emits is a local pointer into
// that one map, so resolving them is a walk with a memo — and the memo doubles
// as the cycle guard: it is seeded before the target is walked, so a
// self-recursive type comes back as one shared object rather than expanding
// forever.
//
// ponytail: local `#/components/schemas/…` pointers only, which is all yerpc
// emits. A remote or file $ref would need a real dereferencer
// (@json-schema-tools/dereferencer) — it would show up as one schema rendering
// as an empty box, not as silence.
//
// Self-check: node --test packages/web-app/api-docs/openrpc/deref.test.mjs

/** @param {object} doc OpenRPC document @returns {object} the same, refs inlined */
export function dereference(doc) {
  const schemas = doc?.components?.schemas ?? {}
  const memo = new Map()
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    // Anchored: an unanchored strip would also fire mid-string, turning
    // "other.json#/components/schemas/Foo" into "other.jsonFoo" and dropping
    // the ref instead of leaving it alone.
    const target = node.$ref?.match?.(/^#\/components\/schemas\/(.+)$/)?.[1]
    if (target !== undefined) {
      if (!memo.has(target)) {
        const out = {}
        memo.set(target, out) // seed first: a cycle resolves back to this object
        Object.assign(out, walk(schemas[target]), { title: schemas[target]?.title ?? target })
      }
      return memo.get(target)
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
  }
  return walk(doc)
}
