---
"@ifc-lite/codegen": minor
"@ifc-lite/export": patch
"@ifc-lite/ids": patch
---

Expose the runtime hierarchy helpers as their own subpath,
`@ifc-lite/codegen/schema-hierarchy`, and import them from there in the two
runtime call sites (`lod0-generator`, the IDS classification bridge).

The package root exports two things with different audiences: the generator,
which imports `node:fs` and `node:path` because it reads `.exp` files and
writes source, and the `isSubtypeOf` family, which is pure and is meant to be
called at runtime against a generated `SCHEMA_REGISTRY`. Importing the second
therefore dragged the first along. In a bundler that tree-shakes, the generator
falls away and nothing is wrong. In a dev server that does not, it is fetched
and evaluated, the `node:fs` stub throws at import, and the viewer never
mounts — it cycles through boot-self-heal reloads on a blank page.

`schema-hierarchy.ts` has no imports at all, so the subpath is browser-safe by
construction rather than by convention, and the existing build already emits
`dist/schema-hierarchy.js` and its declarations. The root entry keeps every
export it had, so nothing that imports it today has to change.
