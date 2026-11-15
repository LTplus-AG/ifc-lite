# `.ifclite` binary cache format

> - **Current format version: 28** (`FORMAT_VERSION`, `src/types.ts:165`).
> - **Status:** descriptive contract of the format as written and read by `@ifc-lite/cache` on `main`.
>   Where this document and the code disagree, the code is the bug report: fix one of them in the same PR.
> - **Change policy:** bump `FORMAT_VERSION` and update this file (§13 history, §11 gates) in the same PR
>   for any change to the wire layout, to how a reader interprets existing bytes, or to the cache's
>   semantics (what a decoded field means or what a producer puts in it). Two writer-side choices are
>   **not** format changes and need no bump, because readers trust only the stored directory and decode
>   the same values either way: the chunk grouping policy (§9.4), and the compressed representation of a
>   chunk, i.e. which valid DEFLATE stream is stored and whether the strictly-smaller rule keeps it (§9.4,
>   §12 item 5). A bump that changes no bytes (producer semantics only) is still recorded in §13.
>   `src/spec.test.ts` fails when the version line above or the enum tables in §2 drift from the code.
> - **Scope:** the file layout, every section's wire encoding, what the reader accepts, rejects and
>   degrades, and the conformance criterion for a second (non-TypeScript) writer (§12). The IFNS
>   instanced-shard payload is a separate format owned by `@ifc-lite/geometry` and only referenced here.

All `file:line` citations are relative to `packages/cache/` unless they name another root.

## 1. Conventions

| Rule | Detail | Source |
|---|---|---|
| Endianness | Every multi-byte integer and float is **little-endian**. | `src/utils/buffer-utils.ts:42-76`, `:225-265` |
| Alignment | **None.** No field, array or section is padded or aligned; the writer never calls `align()`. Readers copy arrays out (`slice`), so unaligned typed arrays are legal. | `src/utils/buffer-utils.ts:267-321` |
| Typed arrays | `T[n]` = `n` packed little-endian elements, no length prefix unless the table shows one. | `src/utils/buffer-utils.ts:84-87` |
| `lpstr` | `u32` UTF-8 byte length, then that many UTF-8 bytes, no terminator. | `src/utils/buffer-utils.ts:89-94`, `:323-328` |
| String index | `u32` index into the Strings pool (§4). The parser's null index `-1` is stored as `0xFFFFFFFF`. | `../data/src/string-table.ts:14` |
| Absent source id | `0xFFFFFFFF` (never `0`: `0` is a real material-layer id). | `src/sections/geometry.ts:153-156` |
| Floats | IEEE-754 as produced by `DataView`. Absent-finish NaN is written as `0x7FC00000`. | `src/sections/geometry.ts:121-124` |
| Bounds | Every `BufferReader` read throws `read past end of buffer` before overrunning; `skip()` and the `position` setter do not check. | `src/utils/buffer-utils.ts:211-218`, `:189-191`, `:337-339` |

## 2. File header (64 bytes) and section table

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | `u32` | `magic` | `0x4C434649` = bytes `49 46 43 4C` ("IFCL"). Mismatch → throw. (`src/types.ts:16`, `src/sections/header.ts:75-78`) |
| 4 | `u16` | `version` | `> FORMAT_VERSION` → throw `Unsupported format version`. No lower bound. (`src/sections/header.ts:81-84`) |
| 6 | `u16` | `flags` | `HeaderFlags`, below. |
| 8 | `u64` | `sourceHash` | §3. |
| 16 | `u8` | `schema` | `SchemaVersion`, below. Not validated on read. |
| 17 | `u32` | `entityCount` | `store.entityCount \|\| entities.count` (`src/adapt.ts:109`). Not cross-checked on read. |
| 21 | `u32` | `totalVertices` | Caller-supplied `GeometryData.totalVertices`, 0 without geometry (`src/writer.ts:132-147`). |
| 25 | `u32` | `totalTriangles` | As above. |
| 29 | `u16` | `sectionCount` | |
| 31 | 33 bytes | reserved | Written as zero, skipped unread (`src/sections/header.ts:53-58`, `:103-105`). |
| 64 | 16 × `sectionCount` | section table | Entries below. |

### Header flags

`HeaderFlags` (`src/types.ts:224-238`). Unknown bits are ignored on read.

| Bit | Mask | Name | Writer | Reader |
|---|---|---|---|---|
| 0 | `0x0001` | `Compressed` | Never set. | Never consulted. |
| 1 | `0x0002` | `HasGeometry` | Set iff `includeGeometry && geometry` (even with zero meshes) (`src/writer.ts:180-182`). | Gates the geometry and shard reads (`src/reader.ts:150`). |
| 2 | `0x0004` | `HasSpatial` | Never set; no Spatial section exists (`src/writer.ts:183-188`). | Surfaced as `hasSpatialHierarchy` only (`src/sections/header.ts:128`). |
| 3 | `0x0008` | `SourceHashUnset` | Set iff `omitSourceHash` (`src/writer.ts:189-191`). | `hasSourceHash = bit clear` (`src/sections/header.ts:123`). |

### Schema

`SchemaVersion` (`src/types.ts:217-221`): `0` IFC2X3, `1` IFC4, `2` IFC4X3. `toCacheDataStore` maps `IFC5`
and anything unrecognised to `0` (`src/adapt.ts:62-70`).

### Section table entry (16 bytes)

| Offset | Type | Field | Notes |
|---|---|---|---|
| +0 | `u16` | `type` | `SectionType`, below. |
| +2 | `u16` | `flags` | `SectionFlags`: bit 0 `Compressed` (`0x0001`). Writer always `0`; reader ignores it (`src/writer.ts:169`). A writer MUST write `0`. |
| +4 | `u32` | `offset` | Absolute byte offset from file start. |
| +8 | `u32` | `size` | Section byte length. **Not used by the reader to bound decoding** (§10). |
| +12 | `u32` | `compressedSize` | Writer always `0`; never read. |

### Section types

`SectionType` (`src/types.ts:203-214`). The reader indexes sections by type into a `Map`
(`src/reader.ts:88`): unknown types are ignored, and a duplicated type resolves to the **last** entry.

| Value | Name | Written | Required on read | Section |
|---|---|---|---|---|
| 1 | `Strings` | always | yes (`src/reader.ts:91-94`) | §4 |
| 2 | `Entities` | always | yes (`src/reader.ts:99-102`) | §5 |
| 3 | `Properties` | always | yes (`src/reader.ts:107-110`) | §6 |
| 4 | `Quantities` | always | yes (`src/reader.ts:115-118`) | §6 |
| 5 | `Relationships` | always | yes (`src/reader.ts:123-126`) | §7 |
| 6 | `Geometry` | with geometry | no | §9 |
| 7 | `Spatial` | never | never read | reserved |
| 8 | `Bounds` | never | never read | reserved |
| 9 | `EntityIndex` | iff `dataStore.entityIndex` | no | §8 |
| 10 | `InstancedShards` | iff geometry has ≥1 shard | no | §9.8 |

### Section order and offsets (writer)

Sections are emitted in this order, each immediately after the previous one with no padding, the first at
`64 + 16 × sectionCount`: Strings, Entities, Properties, Quantities, Relationships, [EntityIndex],
[Geometry, [InstancedShards]] (`src/writer.ts:76-176`). The file ends at the last section's end. The reader
seeks each section by its `offset` and does not require this order, contiguity, or a file end at the last
section.

## 3. Source hash

`sourceHash` is **XXH64, seed 0, over the complete source IFC bytes** (`src/writer.ts:69`,
`src/utils/hash.ts:49-107`; reference vectors pinned in `src/cache.test.ts:73-92`).

- With `omitSourceHash`, the writer stores `0` and sets `SourceHashUnset` (`src/writer.ts:69`, `:189-191`).
- `read({ sourceBuffer })` compares only when the flag is clear; a mismatch throws
  `Cache validation failed: source file has changed` (`src/reader.ts:80-85`).
- `validate()` throws when the flag is set, otherwise returns the comparison (`src/reader.ts:47-56`).
- The viewer's lookup key is a different, sampled fingerprint plus `FORMAT_VERSION`
  (`src/source-fingerprint.ts`, `apps/viewer/src/hooks/geometryCacheKey.ts:72`); it is not part of this format.

## 4. Strings

| Type | Field |
|---|---|
| `u32` | `count` |
| `u32[count + 1]` | cumulative byte offsets into `data`; `offsets[count]` = total bytes |
| `u8[offsets[count]]` | concatenated UTF-8 |

Written from `StringTable.getAll()` in pool order (`src/sections/strings.ts:19-46`). A `StringTable` always
holds `''` at index 0 (`../data/src/string-table.ts:11`), so a TS-written pool starts with the empty string.

Reader (`src/sections/strings.ts:51-116`): throws unless `offsets[0] === 0` (`:86-90`) and offsets are
non-decreasing (`:91-97`); strings decode positionally via `StringTable.fromArray`. **`fromArray` prepends
`''` when entry 0 is not empty** (`../data/src/string-table.ts:24`), shifting every index by one: a writer
MUST emit `''` as entry 0.

## 5. Entities

| Type | Field | Since |
|---|---|---|
| `u32` | `count` | |
| `u32[count]` | `expressId` | |
| `u16[count]` | `typeEnum` | |
| `u32[count]` | `globalId` (string index) | |
| `u32[count]` | `name` (string index) | |
| `u32[count]` | `description` (string index) | |
| `u32[count]` | `objectType` (string index) | |
| `u8[count]` | `flags` | |
| `i32[count]` | `containedInStorey` | |
| `i32[count]` | `definedByType` | |
| `i32[count]` | `geometryIndex` | |
| `u16` | `typeRangeCount` | |
| `typeRangeCount × {u16 type, u32 start, u32 end}` | type ranges | |
| `u32[count]` | `rawTypeName` (string index; zeros when the table has none) | v15 |

Source: `src/sections/entities.ts:41-78`. Every column MUST be exactly `count` long: the writer writes each
typed array whole (`:49-58`); only `rawTypeName` is clipped (`:76-77`). Type ranges are written in the
table's `typeRanges` iteration order, which the builder fills in first-appearance row order with
`[firstRow, lastRow + 1]` (`../data/src/entity-table.ts:152-158`). The reader consumes and **discards** the
ranges, re-deriving them from `typeEnum` (`src/sections/entities.ts:114-120`), because pre-#3101 caches
stored a different meaning under the same version.

## 6. Properties and quantities

### 6.1 Properties (`src/sections/properties.ts:52-72`, read `:77-93`)

`u32 count`, then columns: `entityId u32`, `psetName u32`, `psetGlobalId u32`, `propName u32`,
`propType u8` (`PropertyValueType`, `../data/src/types.ts:178-190`), `valueString u32`, `valueReal f64`,
`valueInt i32`, `valueBool u8` (`255` = null), `unitId i32`; each `[count]`. Then three row indices in order
`entityIndex`, `psetIndex`, `propIndex`.

### 6.2 Quantities (`src/sections/quantities.ts:16-34`, read `:39-53`)

`u32 count`, then `entityId u32`, `qsetName u32`, `qsetGlobalId u32` (v17), `quantityName u32`,
`quantityType u8`, `value f64`, `unitId i32`, `formula u32`; each `[count]`. Then row indices
`entityIndex`, `qsetIndex`, `quantityIndex`.

### 6.3 Row index encoding (both tables)

`u32 keyCount`, then per key in `Map` iteration order: `u32 key`, `u32 n`, `u32 rows[n]`
(`src/sections/properties.ts:207-216`). The reader throws if any row `>= count`
(`src/sections/properties.ts:229-249`, `src/sections/quantities.ts:171-191`).

### 6.4 Source-retention semantics

`write()` serializes whatever the store's tables already hold. A STEP-parsed store resolves properties and
quantities lazily and never populates these tables, so **a cache written from a STEP parse carries
`count = 0` and three empty indices in both sections** (`README.md`, "Properties and quantities are not part
of that speedup"; `src/index.ts:12-18`). Empty is the correct encoding for that input, not data loss:
on-demand values come from the source bytes, which the caller must retain and re-attach
(`docs/guide/querying.md`). The cache records no flag distinguishing "empty because on-demand" from
"empty because the model has none"; a second writer given the same STEP input MUST also write empty tables.

## 7. Relationships

Two direction blocks, `forward` then `inverse` (`src/sections/relationships.ts:36-42`), each:

| Type | Field | Since |
|---|---|---|
| `u32` | `nodeCount` | |
| `nodeCount × {u32 entityId, u32 offset, u32 count}` | CSR node table, `offsets` Map iteration order | |
| `u32` | `edgeCount` | |
| `u32[edgeCount]` | `edgeTargets` | |
| `u16[edgeCount]` | `edgeTypes` (`RelationshipType`, `@ifc-lite/data`) | |
| `u32[edgeCount]` | `edgeRelIds` (the `IfcRel*` express id) | |
| `u32` | `shadowedGroupCount` (`g`) | v18 |
| `u32[g]` | `shadowedEdgeIndex` | v18 |
| `u32[g + 1]` | `shadowedGroupOffsets` | v18 |
| `u32` | `shadowedIdCount` | v18 |
| `u32[shadowedIdCount]` | `shadowedRelIds` | v18 |

Source: `src/sections/relationships.ts:44-87`. With no shadowing the trailer is `0`, `[0]`, `0`
(`:79-86`). Reader (`:207-268`): throws if any node range exceeds `edgeCount` (`:248-256`); the trailer is read
only when `version >= 18` (`:261`) and must satisfy (`:161-205`): `offsets.length == g + 1`, `offsets[0] == 0`,
`offsets[g] == shadowedIdCount`, groups non-empty (strictly increasing offsets), `shadowedEdgeIndex`
strictly ascending and `< edgeCount`.

## 8. Entity index (section 9)

### 8.1 Columns (`src/sections/entity-index.ts:48-56`, read `:58-85`)

| Type | Field |
|---|---|
| `u32` | `count` |
| `u32` | `typeNameCount` |
| `typeNameCount × lpstr` | `typeNames`, upper-case, first-appearance order |
| `u32[count]` | `ids` (express ids, non-decreasing) |
| `u32[count]` | `byteOffsets` into the source IFC |
| `u32[count]` | `byteLengths` |
| `u16[count]` | `typeIndices` into `typeNames` |

Rows are sorted by express id: the iterable path sorts (`:17-18`); the borrowed-column path accepts only
non-decreasing ids and keeps duplicate order (`src/sections/entity-index-columns.ts:20`). Type names are
upper-cased and deduplicated in first-row order (`entity-index-columns.ts:25-31`, `entity-index.ts:33-41`);
more than 65535 names throws on write. The reader throws on any `typeIndex >= typeNameCount`
(`src/sections/entity-index.ts:75-82`).

### 8.2 Parser relationship-coverage trailer (v28, #9947)

Appended inside the same section, directly after the columns (`src/writer.ts:121-125`); read only when
`version >= 28` (`src/reader.ts:146`). It exists only when the EntityIndex section exists.
Source: `src/sections/selection-relationships.ts:10-29`, read `:30-54`.

| Type | Field |
|---|---|
| `u32` | `present`: `0` → nothing follows; `1` → body; other → throw |
| `u32` | `typeRows` |
| `f64` | `typeReferences` (must be a non-negative safe integer) |
| 3 × id list | `missing`, `unverifiedTypeRows`, `retryTypeRows`; each `u32 n`, `u32[n]` |
| 3 × id map | `typeDefinitions`, `exceptionalSubjects`, `exceptionalDefinitionTargets`; each `u32 n`, then `n × {u32 key, u32 m, u32[m]}` |
| `u32 n`, `n × {u32 id, f64 references}` | `typeExceptionalReferences` (non-negative safe integers) |
| `u32 n`, `n × {u32 id, lpstr reason}` | `typeRefusals` |

## 9. Geometry (section 6)

All offsets in this section are relative to the **geometry section start**. The reader refuses geometry
for `version < 13` (§11).

### 9.1 Head (`src/sections/geometry-chunks.ts:8-33`, write `:210-236`, read `:247-270`)

| Type | Field | Since |
|---|---|---|
| `u32` | `headLength`: bytes from offset 4 to the end of the directory | 13 |
| `u32` | `meshCount` (meshes surviving `validateMeshes`) | 13 |
| `u32` | `totalVertices` (recomputed from surviving meshes) | 13 |
| `u32` | `totalTriangles` (`Σ indexCount / 3`) | 13 |
| CoordinateInfo | §9.2 | |
| source pool | §9.6 | v19 |
| `u32` | `chunkCount` | 13 |
| `chunkCount × 44` | directory, §9.3 | 13 |

The reader validates `4 + headLength` against where the head parse actually ended
(`src/sections/geometry-directory.ts:32-36`). It does **not** check `meshCount` against the directory's mesh
counts or the totals against decoded data.

### 9.2 CoordinateInfo (`src/sections/coordinate-info.ts:8-40`, read `:84-142`)

| Type | Field | Since | Read rule |
|---|---|---|---|
| `f64×3` | `originShift` | | |
| `f64×6` | `originalBounds` (min xyz, max xyz) | | |
| `f64×6` | `shiftedBounds` | | |
| `u8` | `hasLargeCoordinates` | | `=== 1` |
| `u8` [+ `f64×3`] | `wasmRtcOffset` presence [+ value] | v3 | `=== 1` (lenient) |
| `u8` [+ `f64`] | `buildingRotation` presence [+ radians] | v3 | `=== 1` (lenient) |
| `u8` [+ `f64×3` + `u8`] | `wasmRtcFrame` presence [+ x y z, `needsShift`] — RTC frame provenance | v20 | flags must be 0/1; frame validated (below) |
| `u8` [+ `f64`] | `boundsRecoveryFallbackCount` (recovery count) | v24 | flag must be 0/1 |
| `u8` [+ `f64`] | `lengthUnitScale` | v24 | flag must be 0/1 |
| `u8` [+ `f64×3`] | `siteOrigin` (IfcSite world origin, #9480) | v27 | flag must be 0/1 |

Absent optional values stay `undefined`; a recorded `0` count or scale is known, not absent (`:33-35`).
`wasmRtcFrame` is validated on write and read (`:55-76`): finite components, `needsShift` equal to
"`wasmRtcOffset` present", and when shifting, components `Object.is`-equal to the offset.

### 9.3 Chunk directory entry (44 bytes, `src/sections/geometry-chunks.ts:55-56`, `:223-236`)

| Offset | Type | Field |
|---|---|---|
| +0 | `f32×3` | `aabbMin` (world: `origin + position`, min in f64 then rounded to f32) |
| +12 | `f32×3` | `aabbMax`; an empty chunk stores all zeros (`:127-144`) |
| +24 | `u32` | `byteOffset` of the stored record, relative to section start |
| +28 | `u32` | `byteLength`: stored bytes (compressed length when compressed) |
| +32 | `u32` | `uncompressedLength` |
| +36 | `u32` | `meshCount` |
| +40 | `u32` | `flags` (`GeometryChunkFlags`, below) |

Layout rules the reader **enforces** (`src/sections/geometry-directory.ts:62-77`): chunk 0 starts at
`4 + headLength`, and each chunk starts exactly where the previous one ends (no gaps, directory order =
file order). A chunk whose `[byteOffset, byteOffset + byteLength)` runs past the buffer is rejected
(`src/sections/geometry-chunks.ts:372-376`).

### Geometry chunk flags

`GeometryChunkFlags` (`src/types.ts:179-183`). The reader tests only `DeflateRaw`; other bits are ignored
(`src/sections/geometry-chunks.ts:301`).

| Bit | Mask | Name | Meaning |
|---|---|---|---|
| 0 | `0x0001` | `DeflateRaw` | Stored bytes are a raw DEFLATE stream (RFC 1951, no zlib/gzip wrapper) of the record. |

### 9.4 Chunk records and compression

A chunk record is the concatenation of `meshCount` mesh records (§9.5), stored raw or deflate-raw.

Decode (`src/sections/geometry-chunks.ts:293-330`): inflate if flagged; throw unless the inflated length equals
`uncompressedLength` (`:302-304`); decode `meshCount` records; throw unless they consume the record exactly
(`:324-328`). A corrupt DEFLATE stream rejects with the platform `DecompressionStream` error, unwrapped.

Write-side storage rule (`src/sections/geometry-chunks.ts:183-187`, `src/sections/geometry-codec.ts:19-24`):

1. If compression is disabled (`compressGeometryChunks: false`) or `uncompressedLength < 65536`
   (`GEOMETRY_CHUNK_COMPRESS_MIN_BYTES`, `src/types.ts:176`): store raw, flag clear.
2. Otherwise `chooseStoredGeometryChunk`: deflate-raw the record; store the compressed bytes and set
   `DeflateRaw` **only when the compressed length is strictly smaller** than the raw length; else store raw,
   flag clear. The worker path uses the same function (`src/workers/geometry-compression-handler.ts:24`).

The TS writer's compressor is `CompressionStream('deflate-raw')`; nothing in the format requires that
compressor. Compression concurrency (4 chunks) does not affect output order (`:196-202`).

**Chunk grouping policy (write side only).** Readers trust only the directory; the grouping can change
without a version bump (`src/types.ts:168-171`). The TS writer, for reproducibility
(`src/sections/geometry-chunks.ts:78-125`):

- Cell key per mesh: `floor((origin + firstVertex) / 32)` per axis in f64 (`GEOMETRY_CHUNK_CELL_SIZE`);
  meshes with no vertex use `origin`; a non-finite cell uses the single key `nan`.
- Meshes are visited in input order. A mesh joins the open chunk of its cell unless that chunk is non-empty
  and adding the mesh's exact record size would exceed 8 MiB (`GEOMETRY_CHUNK_SOFT_BYTES`); then that chunk
  is closed (appended to the output) and a new one opened **under the same Map key, keeping the key's
  original insertion position**. A mesh never splits.
- Output order: chunks in the order they were closed, then the still-open chunks in cell-key first-insertion
  order. `onGeometryOrder` receives the meshes in this order (`:159`).

### 9.5 Mesh record (`src/sections/geometry.ts:58-115`, read `:205-300`)

| Type | Field | Since | Read behaviour |
|---|---|---|---|
| `u32` | `expressId` | | |
| `u32` | `vertexCount` (`positions.length / 3`) | | `> 100,000,000` → throw |
| `u32` | `indexCount` | | `> 300,000,000` → throw |
| `f32×4` | `color` RGBA | | |
| `lpstr` | `ifcType` | v2 | `''` → `undefined` |
| `u8` | `geometryClass` | v5 | |
| `u32` | `geometryItemId` (`0xFFFFFFFF` absent) | v14 | |
| `u32` | `materialId` (`0xFFFFFFFF` absent) | v14 | |
| `f64×3` | `origin` (world = origin + position; zeros when absent) | v6 | all-zero (incl. `-0`) → `undefined` |
| `f32[3V]` | `positions` | | any NaN/±Inf → throw |
| `f32[3V]` | `normals` | | any NaN/±Inf → throw |
| `u32[I]` | `indices` | | not range-checked unless provenance present |
| provenance | §9.6 | v19 | |
| `f32`, `f32` | finish `metallic`, `roughness` (NaN = absent) | v22 | non-finite → absent |
| metadata | `u8 flags` + payloads, below | v25 | unknown flag bit → throw |

Write-side filter (`src/sections/geometry.ts:18-51`): meshes with `vertexCount`/`indexCount` over the caps
above, or `normals.length !== positions.length`, are dropped with a warning before grouping. NaN vertex data
is **not** filtered on write.

Mesh-metadata trailer (`src/sections/mesh-metadata.ts:25-79`), payloads in flag order:

| Bit | Mask | Field | Payload |
|---|---|---|---|
| 0 | `0x01` | `shadingColor` | `f32×4` (RGBA) |
| 1 | `0x02` | `localBounds` | `f32×3` min, `f32×3` max |
| 2 | `0x04` | `localToWorld` | `f64×16`, row-major (`../geometry/src/types.ts:191-198`) |

### 9.6 Appearance provenance (v19)

Head pool (`src/sections/appearance-provenance.ts:78-92`), after CoordinateInfo: `u32 poolCount`, then per
entry `u32 length`, `u32[length]`. Read rules: `poolCount <= meshCount`; each `length` non-zero, a multiple
of 3, `<= 300,000,000`, and within the declared head. Meshes whose mode would be 0 or 1 (no provenance, or
canonical identity) are skipped before pooling, so a model of only such meshes writes `poolCount = 0`. Over the
rest, the pool holds each distinct `sourceIndices` array **by object identity**, in first-appearance order over
the surviving meshes in input order (`:69-77`).

Per-mesh record (`:40-67`): `u8 mode`, then:

| Mode | Meaning | Payload |
|---|---|---|
| 0 | no provenance | — |
| 1 | canonical identity: source indices equal the mesh indices **and** no corner map (`:31`); with a corner map the mesh is mode 3 or 5 even when the indices are equal | — |
| 2 | inline source indices | `u32 n`, `u32[n]` |
| 3 | inline source + corner map | `u32 n`, `u32[n]`, `u32[indexCount]` |
| 4 | pooled source | `u32 poolIndex` |
| 5 | pooled source + corner map | `u32 poolIndex`, `u32[indexCount]` |
| > 5 | — | throw |

Through `buildGeometrySectionV13` every mode-2/3 source is in the pool, so the TS writer emits only modes
0, 1, 4 and 5; readers accept 2 and 3. Both sides run the same validation (`:13-27`): `geometryItemId` in
`(0, 0xFFFFFFFF)`, no `entityIds`, non-empty `indices` with length a multiple of 3 and every index
`< vertexCount`, and corner entries in range. Failure throws `malformed canonical appearance provenance`.

### 9.7 Header vs geometry-head totals

The file header's `totalVertices`/`totalTriangles` come from the caller (`src/writer.ts:146-147`), the
geometry head's from the meshes actually written (`src/sections/geometry.ts:46-47`). They differ when
`validateMeshes` drops a mesh. Readers return the geometry head's values (`src/sections/geometry-chunks.ts:394-398`).

### 9.8 Instanced shards (section 10)

`u32 count`, then per shard `u32 length`, `u8[length]` (`src/sections/instanced-shards.ts:17-27`). Each shard
is an opaque, self-describing IFNS blob stored verbatim (layout, versioning and stride rules:
`../geometry/src/packed-instanced-decoder.ts:6-80`, matching the Rust `wire.rs`). The reader checks each
length against remaining bytes (`:29-52`), and reads the section only when geometry was read
(`src/reader.ts:168-172`). Shard order is the producer's.

## 10. Truncated and corrupt input

Every failure below is a thrown `Error` (or a rejected promise for geometry). Callers treat a throw as a miss
and rebuild; the viewer does (`apps/viewer/src/hooks/ifcCacheDecode.ts:139-144`). Representative cases are
pinned in `src/cache.test.ts:471` and `src/sections/*.test.ts`.

| Input | Result |
|---|---|
| Buffer shorter than any declared field or array | `BufferReader: read past end of buffer` (`src/utils/buffer-utils.ts:211-218`) |
| Bad magic / newer version | throw (`src/sections/header.ts:75-84`) |
| Missing Strings/Entities/Properties/Quantities/Relationships | `Missing required … section` (`src/reader.ts:91-126`) |
| Section bytes overrun into the next section | **Not detected**: the reader never applies the table's `size`; decoding continues into whatever follows until a structural check or end of buffer stops it |
| Corrupt string offsets, row indices, CSR ranges, shadow trailer, type indices, coverage flag | throw (§4, §6.3, §7, §8) |
| Geometry `headLength` / chunk-0 anchor / contiguity mismatch | throw (`src/sections/geometry-directory.ts:32-77`) |
| Chunk range past buffer end; inflated length ≠ `uncompressedLength`; record under- or over-consumption | throw / reject (§9.3, §9.4) |
| Non-finite vertex data, unknown metadata bits, bad provenance, bad CoordinateInfo presence flags | throw (§9.2, §9.5, §9.6) |
| Truncated shard | `Truncated InstancedShards` (`src/sections/instanced-shards.ts:37-45`) |

## 11. Reader compatibility (current reader)

`readHeader` accepts any `version <= 28` (`src/sections/header.ts:82`). `read()` then decodes each section with
the current layout plus the version gates below. Only `read()`'s geometry path refuses old versions outright:
`version < 13` with `HasGeometry`, a Geometry section and `!skipGeometry` throws
`… geometry is no longer readable (v13+ only); discard and rebuild` (`src/reader.ts:153-161`). The viewer refuses
any `version < 13` before decoding (`apps/viewer/src/hooks/ifcCacheDecode.ts:141-144`), and its lookup key embeds
`FORMAT_VERSION`, so it never opens an older entry in normal operation.

| Data | Introduced | Gate | Older entry reads as |
|---|---|---|---|
| `Entities.rawTypeName` | v15 | `src/sections/entities.ts:125` | absent; enum-only type names |
| Relationship shadow trailer | v18 | `src/sections/relationships.ts:261` | no `shadowedRelationshipIds` |
| Entity-index coverage trailer | v28 | `src/reader.ts:146` | `selectionRelationshipIndex` undefined |
| Mesh `geometryItemId`/`materialId` | v14 | `src/sections/geometry.ts:243` | both undefined |
| Provenance + head pool | v19 | `src/sections/geometry.ts:296`, `src/sections/geometry-chunks.ts:254` | no `appearanceSource` |
| Finish trailer | v22 | `src/sections/geometry.ts:297` | no `material` |
| Mesh-metadata trailer | v25 | `src/sections/geometry.ts:298` | fields absent |
| `wasmRtcFrame` | v20 | `src/sections/coordinate-info.ts:101` | undefined |
| Recovery count, `lengthUnitScale` | v24 | `src/sections/coordinate-info.ts:117` | undefined |
| `siteOrigin` | v27 | `src/sections/coordinate-info.ts:122` | absent |
| `ifcType`/`geometryClass`/`origin`; CoordinateInfo RTC offset + rotation | v2/v5/v6; v3 | `src/sections/geometry.ts:227-259`, `src/sections/coordinate-info.ts:96` | unreachable through `read()` (geometry < 13 refused) |
| `Quantities.qsetGlobalId` | v17 | **none** | v ≤ 16 with `count > 0` is misread (column shift); `count = 0` is layout-identical |
| `Properties.psetGlobalId` | at v16 (#3603), no bump | **none** | pre-#3603 v ≤ 16 with `count > 0` is misread |

Direct use of the exported `readGeometryHeadV13`, `openGeometryChunksV13` and `decodeGeometryChunk` takes the
version as an argument; `readGeometryHeadV13` defaults it to `FORMAT_VERSION` (`src/sections/geometry-chunks.ts:247`).

## 12. Conformance for a second writer

A second writer (e.g. a native Rust writer) conforms when all of the following hold. **Counts alone are
never sufficient**: equal mesh, edge or row counts can hide wrong ids, coordinates, units, colours or
relationships.

1. **Self-reproducible.** For the same input, it produces byte-identical files across runs and across thread
   counts (e.g. every `RAYON_NUM_THREADS` value).
2. **Readable.** `BinaryCacheReader.read()` on `main` accepts the file and `FORMAT_VERSION` matches the TS
   writer's.
3. **Scalar sections byte-identical.** For the same input, the header (except as allowed in 5), Strings,
   Entities, Properties, Quantities, Relationships, EntityIndex (including the v28 trailer) and
   InstancedShards (verbatim IFNS, never compressed) are byte-identical to the TS writer's. That fixes every
   order this document leaves to iteration order: pool order, row order, `typeRanges`, row-index and CSR
   node order, entity-index row and type-name order, and coverage map order.
4. **Geometry compared by exact decoded payload and directory semantics.** After inflating every chunk with
   `DeflateRaw` set:
   - the head bytes (`headLength` through `chunkCount`, i.e. counts, CoordinateInfo and the source pool) are
     byte-identical;
   - the chunk count and order, and per chunk `aabbMin`, `aabbMax`, `uncompressedLength`, `meshCount` and
     every flag bit other than `DeflateRaw`, are identical;
   - each chunk's decoded record bytes are byte-identical (so every mesh field: express id, f32 position,
     normal and index bits, colour, origin, source ids, provenance, finish, `shadingColor`, `localBounds`,
     `localToWorld`).
5. **Storage representation may differ, and every difference is checked, not ignored.** Different valid
   DEFLATE streams may change a chunk's stored `byteLength`, every later `byteOffset`, the per-chunk
   `DeflateRaw` bit (which follows the strictly-smaller rule of §9.4 under each writer's own compressor), and
   consequently the Geometry section's `size` and the `offset` of any section after it. For each such
   difference the test MUST check: the stored bytes inflate (when flagged) or equal (when not) the identical
   decoded payload; `byteLength` equals the stored byte count; offsets satisfy the §9.3 layout rules; the flag
   is clear for chunks under 64 KiB or with compression disabled. A comparison that masks the flag, skips the
   inflate, or loosens a value tolerance does not meet this criterion.
6. **Same semantics for empty tables.** Given a STEP-parsed store, Properties and Quantities are empty in both
   writers (§6.4).
7. **Negative cases.** The conformance suite also covers truncated input, bad magic, a newer version, and a
   corrupt chunk length (§10), against both writers' outputs.

## 13. Version history

Every bump changes the viewer's cache key, so entries written by an older version re-parse once.

| Version | Change | Bytes changed | Source |
|---|---|---|---|
| ≤ 12 | Sequential geometry section; layouts no longer written or read | — | `src/types.ts:19-77` |
| 13 | Chunked geometry: head, directory, per-chunk deflate-raw (#1682) | yes | `src/types.ts:78-89` |
| 14 | Mesh `geometryItemId`, `materialId` (#3199) | yes | `src/types.ts:91-106` |
| 15 | Entities `rawTypeName` column | yes | `src/types.ts:108-119` |
| 16 | IFNS v2 shards (92-byte stride, #2985); deliberate key split | shard payload | `src/types.ts:121-135` |
| 17 | Quantities `qsetGlobalId` (#3606) | yes | `src/types.ts:137-143` |
| 18 | Relationship shadowed-rel-ids trailer (#3782) | yes | `src/types.ts:145-155` |
| 19 | Appearance provenance per mesh + head source pool | yes | `src/types.ts:157-159` |
| 20 | CoordinateInfo `wasmRtcFrame` (#4842) | yes | `src/types.ts:160-161` |
| 21 | Relationship indexing covers every exact `IfcRel*` class (#4205) | no | `src/types.ts:162-164` |
| 22 | Mesh finish trailer (#5582) | yes | `src/sections/geometry.ts:117-124` |
| 23 | Finishes on type, mapped and instanced geometry (IFNS field 2, #5984) | shard payload | commit `888a9a72e` |
| 24 | CoordinateInfo `boundsRecoveryFallbackCount`, `lengthUnitScale` (#7239) | yes | `src/types.ts:166` |
| 25 | Mesh `shadingColor`/`localBounds`/`localToWorld` trailer (#7350) | yes | `src/types.ts:166` |
| 26 | Keys miss v25 graphs with a misread relationship edge (#9192) | no | `src/types.ts:166` |
| 27 | CoordinateInfo `siteOrigin` (#9480) | yes | `src/types.ts:166` |
| 28 | Parser relationship-coverage trailer in the EntityIndex section (#9947) | yes | `src/types.ts:165` |
