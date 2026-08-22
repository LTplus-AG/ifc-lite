---
'@ifc-lite/export': patch
---

Stop `resolveExpressBase` throwing on an `Object.prototype` member name.

`SCHEMA_REGISTRY.types` is a plain object literal, so `types['constructor']`
returned the `Object` constructor. That is truthy, so the `!underlying` guard
let it through and the next line called `.replace()` on a function:

    TypeError: underlying.replace is not a function

The documented contract is to return `null` for a type the registry does not
know.

Reachable through `IfcAttributeValue`'s `{ typed: { type, value } }` marker,
whose `type` is a caller-supplied string, via `createEntity` and
`setPositionalAttribute`. The throw escapes `StepExporter.export()`, so one bad
marker name aborts the whole file export rather than one attribute.
