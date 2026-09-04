---
'@ifc-lite/cache': minor
---

Add `toCacheDataStore()`, exported from the package root, so callers stop
hand-rolling the `IfcDataStore` to `CacheDataStore` conversion that
`BinaryCacheWriter.write` requires (`schema: SchemaVersion`, a numeric enum,
against the parser's `schemaVersion` string union). The viewer's cache hook
carried its own copy of that mapping, spelled out as bare `1`/`2`/`0`
literals, and the package README carried a second one inline; both now go
through this one function, so the mapping can no longer drift between them.
An IFC5 source is tagged `SchemaVersion.IFC2X3` on write, since the binary
format predates IFC5, matching the fallback the viewer's read side already
uses. The store's `entityIndex` passes straight through (the parser's
`EntityByIdIndex` already iterates `[number, EntityRef]` and `EntityRef`
satisfies `CacheEntityRef`), so a cache written this way carries an
entity-index section and a reader that retains the source can re-attach the
parser's lazy accessors.

Correct the package docstring and README, which claimed the cache
pre-computes "all data structures" for a 5-10x speedup. That holds for
entities, relationships, spatial hierarchy and geometry, but not for
properties or quantities: a STEP-parsed store resolves those lazily and
never populates its property/quantity tables, so `write()` serializes them
empty and a cache-restored model queries properties exactly as slow as a
fresh parse, unless the caller separately retains the source buffer and
re-attaches on-demand extraction on read (as the viewer's cache hook does).
`docs/guide/querying.md` already documented this correctly; the package's
own docs now say the same thing. Reported as issue #3759.
