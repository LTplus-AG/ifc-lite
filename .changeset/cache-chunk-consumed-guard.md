---
'@ifc-lite/cache': patch
---

Pin the reject path of `decodeGeometryChunk`'s consumed-bytes guard.

`decodeGeometryChunk` (v13 chunked geometry) ends with
`if (reader.position !== raw.byteLength) throw ...` — it requires a chunk's
mesh records to consume exactly the decoded buffer. Mutation testing showed
this guard was unpinned: deleting it left the full suite green, even though
the sibling `uncompressedLength` mismatch guard immediately above it already
had a dedicated test.

The gap is structural, not incidental: `meshCount` and `uncompressedLength`
are directory-level fields and can both be truthful while a mesh record's
*own* `vertexCount` field disagrees with how many vertices were actually
written for it (truncation or corruption mid record). That desync doesn't
move the chunk's overall decoded length or its declared mesh count, so
neither of the two checks that run before this guard can catch it —
`readMeshRecord` simply under-reads, and only the consumed-bytes check
notices the reader stopped short of the chunk's end.

The new test builds one real chunk, then corrupts only the lone mesh
record's `vertexCount` field (leaving the directory's `meshCount` and
`uncompressedLength` untouched and correct) so the record under-consumes by
exactly the bytes two shortened arrays account for. It fails when the guard
is removed and passes with it restored; a control decode with the field
restored round-trips fine, confirming the corruption — not an unrelated
fixture bug — is what triggers the throw.

As a calibration check, the analogous mutation on the neighbouring
`validateGeometryDirectory` `headLength` guard (`geometry-directory.ts:32-36`)
was confirmed to fail exactly one existing test, showing the harness and
build are sound and the new test's win is real.
