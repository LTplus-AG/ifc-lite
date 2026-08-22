---
'@ifc-lite/parser': patch
'@ifc-lite/codegen': patch
---

Stop the generated schema registry answering for `Object.prototype` members.

`SCHEMA_REGISTRY.entities` is a plain object literal, so `in` and `obj[key]`
both reach the prototype chain. `getEntityMetadata('constructor')` returned
the `Object` constructor. Two exported guards were wrong as a result:

- `isInstantiable('constructor')` was `true`. Its own docblock says it exists
  to stop authoring code writing an abstract class into an exported file.
- `normalizeIfcTypeName` returned the string `"Object"` for `constructor`, and
  `undefined` for `__proto__` from a signature declaring `string`.

`isKnownType('constructor')` was already `false` and is unchanged. It is worth
naming, because the guard that reads as looser was the one answering correctly,
and the guard documented as the strict authoring boundary was the one letting
it through.

`isKnownEntity` had the same defect and now delegates to `getEntityMetadata`
rather than repeating the lookup.

The same generator emits a second registry with the same defect, also fixed:
`getTypeId('constructor')` returned the `Object` constructor from a signature
declaring `number | undefined`.
