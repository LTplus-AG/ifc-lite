---
'@ifc-lite/mcp': patch
---

`verifyLayerAgainstClaims` (publish-time scope verification for draft layers) now derives a `model.mutate:children` / `model.mutate:inherits` op when a published layer's node only changes its `children` or `inherits` slots, matching the CLI's `deriveScopeOps`. Previously `deriveLayerDescriptors` only walked a node's `attributes`, so a layer that reparented an entity (or changed its type inheritance) without touching any Pset/attribute produced zero ops and verified as in-scope under any claim, including one that covered nothing at all — a pure structural edit could bypass scope enforcement entirely.
