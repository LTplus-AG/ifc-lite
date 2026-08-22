---
"@ifc-lite/parser": patch
"@ifc-lite/codegen": patch
---

Fix `isKnownEntity` accepting inherited `Object.prototype` members as IFC entity names (#3063).

The registry lookup used `normalized in SCHEMA_REGISTRY.entities`, and `in` walks the prototype chain. So `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `__proto__` and the rest all reported as known entities, while a plainly wrong name like `NotARealType` was correctly rejected.

That matters because this is the authoring guard: callers use it to decide whether a type name a user supplied is real. `normalizeIfcTypeName('constructor')` returns `"Object"`, so accepting it hands the next stage a name that is not an entity at all.

Fixed in `packages/codegen/src/typescript-generator.ts`, which emits the function, and applied to the three generated registries it produces.
