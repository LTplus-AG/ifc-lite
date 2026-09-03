---
'@ifc-lite/cache': patch
---

Fix the README quickstart, which didn't typecheck (issue #3759): `parseColumnar` takes the raw `ArrayBuffer`, not a `Uint8Array` view of it, and `BinaryCacheWriter.write` needs a `CacheDataStore` (`schema: SchemaVersion`, a numeric enum) — not the parser's `IfcDataStore` (`schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'`, a string union), and nothing converted between them.

Added `toCacheDataStore()`, exported from the package root, to do that conversion (an IFC5 source is tagged `SchemaVersion.IFC2X3` on write, since the binary format predates IFC5 — matching the fallback the viewer's read-side cache hook already uses). It intentionally does not carry over an entity index (the parser's live map and the cache format's serializable byte-offset index are structurally different; nothing today converts one into the other) or materialize properties/quantities — it serializes exactly what the store's property/quantity tables hold.

Also corrected the package docstring and README, which claimed the cache pre-computes "all data structures" for a 5-10x speedup. That's true for entities/relationships/spatial hierarchy/geometry, but not for properties or quantities: a STEP-parsed store resolves those lazily and never populates its property/quantity tables, so `write()` serializes them empty and a cache-restored model queries properties exactly as slow as a fresh parse, unless the caller separately retains the source buffer and re-attaches on-demand extraction on read (as the viewer's cache hook does). `docs/guide/querying.md` already documented this correctly; the package's own docs now say the same thing.
