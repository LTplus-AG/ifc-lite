---
'@ifc-lite/parser': patch
'@ifc-lite/codegen': patch
---

Stop the generated schema registry answering for `Object.prototype` members.

`SCHEMA_REGISTRY.entities` is a plain object literal, so `in` and `obj[key]`
both reach the prototype chain. `getEntityMetadata('constructor')` returned
the `Object` constructor, which made three exported guards wrong:

- `isInstantiable('constructor')` was `true`. Its own docblock says it exists
  to stop authoring code writing an abstract class into an exported file.
- `normalizeIfcTypeName('constructor')` returned the string `"Object"`.
- `normalizeIfcTypeName('__proto__')` returned `undefined` from a signature
  declaring `string`.

`isKnownEntity` had the same defect and now delegates to `getEntityMetadata`
rather than repeating the lookup.
