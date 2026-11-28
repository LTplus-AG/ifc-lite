<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Tiled federation streaming (proposed)

Status: design, nothing here is implemented. The only code that ships with this
document is a golden fixture and the renderer test that pins it (see
[Golden fixture](#golden-fixture)).

## Summary

Today a server-backed model opens by downloading one geometry blob for the whole
file and one data-model blob for the whole file. Open time and memory grow with
the size and the number of federated models, whatever the camera looks at.

This design cuts every prepared model version into immutable spatial tiles at
prepare time. The tiles follow the structure the renderer already draws from:
32 m chunk cells as leaves and the HLOD octree above them. The viewer then
streams only the tiles the camera needs, across all federation slots, inside one
memory budget. Open time and memory follow the view.

It is the map-tile idea applied to BIM. The parts are:

| Part | Where | What it does |
| --- | --- | --- |
| Tiler | `apps/server`, a stage after the geometry pass | Sorts meshes into cells with bounded memory, writes leaf tiles, proxy tiles, a manifest and an indexed data model |
| Tile store | `apps/server` | Immutable pack files with range reads: local directory first, S3-compatible later |
| Tile routes | `apps/server` | Resolve, manifest, pack and data-model reads, behind an authorisation hook |
| Tile source | `packages/server-client` | Manifest decode, coalesced range requests, grants |
| Tile scheduler | `packages/renderer` | One scheduler for all slots: screen-space error, one budget, LRU, priorities |
| Scene adoption | `packages/renderer` | Leaf tiles become chunk-cell buckets, proxy tiles become HLOD nodes |

## Goals and non-goals

Goals:

1. First complete frame of an N-model federation after a bounded number of
   requests (manifest and overview pack per model), independent of model size.
2. Peak viewer memory bounded by one configured budget, independent of the
   number and size of models.
3. Pixel parity with the whole-model path wherever leaf tiles are resident.
4. Tiles are immutable, cacheable forever, never public, and usable offline.
5. The tiler adds a bounded amount of memory on top of the geometry pass.

Non-goals:

- Producing standard 3D Tiles for other viewers. The manifest borrows 3D Tiles
  semantics so that an exporter is a later, small step, but the tile content is
  the renderer's own buffer layout.
- Server-side clash, section or search. Those stay in the client and fetch the
  leaf tiles of their scope.
- Lowering the memory of the geometry pass itself (measured at 12 to 39 times
  the IFC size). The tiler must not add to it; reducing it is separate work.
- Editing. A tiled slot is read-only geometry. Overlay edits keep working
  through the mutation overlay, which draws its own meshes.

## What exists and is reused

| Existing piece | Reused as |
| --- | --- |
| `packages/renderer/src/chunk-grid.ts`: 32 m cells, a mesh assigned by its anchor (`origin + first vertex`), never split | The leaf tile rule, bit for bit |
| `draw-stream-hlod.ts`: octree of 64 m, 128 m, ... nodes, parent coordinates `child >> 1`, proxy error `nodeEdge / grid`, selection by projected error (#11370, #11405) | The tile tree, its geometric error and the client selection loop |
| `draw-stream-proxy-worker.ts`: vertex clustering per colour slot | The proxy clustering rule; for tiled slots the server runs it once instead of every client |
| 12-byte compact records (`rust/wasm-bindings/src/zero_copy/mesh_compact.rs`, `packages/geometry/src/compact-geometry.ts`, `compact-store.ts`, #11606) | The leaf tile vertex payload: uploaded with `writeBuffer`, no vertex walk |
| `residency.ts` (`selectEvictions`, `MIN_EVICTION_AGE_FRAMES`), `scene-subset-residency.ts`, `ColdGeometryProvider` | Eviction policy and the cold tier interface; the tile source becomes the cold provider |
| Entity lane (24-bit id plus colour salt), `entityIdAnchor`, entity visibility and colour tables | Per-vertex feature ids; hide, isolate and colour overrides work on tiles that arrive later |
| `federation-registry.ts` (`reserveModel`, `publishRange`, `toGlobalId`) | Slot id ranges; the manifest states `maxExpressId` so a range is reserved before any tile arrives |
| `cache_key_from_parts` (`{sha256}-{opening_filter}{-q quality}{-layers}`), `is_file_digest` | The request part of the prepare identity |
| `parquet_instancing.rs` and the `shared-shapes` layout (`world = origin + R * p`) | Shared shapes inside a tile |
| `ProcessedModelRef` (`packages/server-client`): "the hash selects a stored result, it does not grant access to it" | The handle a host passes; the grant is the access |
| `Admission`, `in_flight.rs`, `middleware/auth.rs` | Prepare admission, single flight, and the place the authorisation hook goes |
| `packages/tiles3d` | Not reused as code (it reads context tilesets). Its traversal is the reference for the semantics the manifest mirrors |

## Terms

- **Slot**: one federated model in the viewer: a `modelId`, an id range in the
  `FederationRegistry` and an optional placement.
- **Tileset**: all tiles of one model version under one prepare identity and one
  format revision. Immutable.
- **Leaf tile**: the real geometry of one 32 m cell (level 0).
- **Proxy tile**: the simplified geometry of one coarser node (level 1 and up).
- **Pack**: a file holding many tiles back to back. Tiles are read from packs by
  byte range.
- **Mesh frame**: the frame the server already emits meshes in: Y-up, metres,
  relative to the model's RTC offset, `world = origin + position`.

## 1. Keys, manifest, tile bytes

### 1.1 Tile key

A tile is named by:

```text
(sha256, prepare, rev, level, x, y, z, part)
```

- `sha256`: the source file hash, 64 lowercase hex characters, as today.
- `prepare`: the prepare identity, 16 hex characters: the first 8 bytes of
  SHA-256 over a canonical, length-framed encoding of
  - the request options that change geometry: opening filter, tessellation
    quality, layer slicing (the inputs of `cache_key_from_parts`);
  - the tiler parameters: leaf cell (32), proxy grid (24), root rule, part and
    pack size targets;
  - `GEOMETRY_REVISION`, an integer in the server bumped whenever a release
    changes mesh output (the same event that re-pins
    `mesh_determinism.json`).
- `rev`: the tile format revision, a small integer, `t1` in paths.
- `level`, `x`, `y`, `z`: the node (section 2). Level 0 is a leaf.
- `part`: 0 unless a dense cell was split into parts (section 1.5).

`tileset = {prepare}-t{rev}` is the path segment that names a tileset.

The key is logical. Its physical address, a pack number and a byte range, comes
from the manifest. Every URL contains `sha256`, because authorisation is decided
per source hash.

Rejected:

- *A random or sequential tileset id.* Two servers preparing the same file
  would produce different URLs, which defeats CDN and offline reuse, and a
  client could not tell from a key what it describes.
- *Content-addressed tile URLs (URL = hash of the tile bytes).* Attractive for
  deduplication across model versions, but the URL would no longer name the
  model, so a grant listing allowed source hashes could not be checked without a
  lookup per request. The manifest carries a content digest per tile instead,
  and a store may deduplicate on it.
- *Leaving the format revision out of the key.* Then a format change would have
  to overwrite immutable objects.

### 1.2 Manifest

One manifest per tileset, immutable, fetched once per slot. It mirrors these
OGC 3D Tiles semantics, because they are the right ones and because a later
exporter can then emit a real `tileset.json`:

| 3D Tiles concept | Manifest equivalent |
| --- | --- |
| Implicit octree, tiles addressed by `(level, x, y, z)`, availability | Node table with `(level, x, y, z)` and a child mask per node |
| `geometricError` | Per level: `nodeEdge / grid` metres for proxies, 0 for leaves. Stated in the head, not per node |
| `boundingVolume.box` | Tight axis-aligned box of the node's content in the mesh frame. It can exceed the nominal cell, because meshes are never split |
| `refine: REPLACE` | A proxy replaces its whole subtree. `ADD` is never used |
| Root `transform` | Not in the manifest. The slot placement is applied by the client, so one tileset serves any placement |
| `maximumScreenSpaceError` | The existing `hlodPx` setting |
| `EXT_mesh_features` feature ids | A per-vertex feature id attribute (the entity lane) plus a feature table per tile with one row per draw range |
| `EXT_structural_metadata` property tables | The indexed data model (section 4), joined by `expressId` |
| Implicit subtree files | Reserved: a node flag "children listed in external subtree N", unused in `t1` |

Not mirrored: `region` volumes, `viewerRequestVolume`, `ADD` refinement, glTF
content.

Layout: the same container as a tile (section 1.3) with two sections.

Head (JSON):

```json
{
  "format": "ifc-lite-tiles",
  "rev": 1,
  "sha256": "…",
  "prepare": "…",
  "frame": { "up": "Y", "unit": "m", "rtcOffset": [0, 0, 0], "meshCoordinateSpace": "site_local" },
  "grid": { "leafCell": 32, "proxyGrid": 24, "rootLevel": 5 },
  "bounds": [0, 0, 0, 0, 0, 0],
  "counts": { "elements": 0, "meshes": 0, "triangles": 0, "maxExpressId": 0 },
  "palette": [],
  "packs": [{ "bytes": 0, "digest": "…" }],
  "overviewPacks": 1,
  "dataModel": { "packs": [], "directory": {} },
  "model": {}
}
```

`model` carries what `X-IFC-Metadata` carries today (schema, unit scale,
georeferencing, site and building transforms), unchanged. `palette` is the
tileset's colour slots (colour and finish), sorted by their bytes so the order
does not depend on traversal.

Node table (binary, fixed 80-byte rows, sorted by level descending, then Morton
code of `(x, y, z)`, then part):

| Field | Type | Meaning |
| --- | --- | --- |
| `level`, `part`, `childMask`, `flags` | 4 × `u8` | Flags: has transparent, has shared shapes, has f32 fallback meshes, stray |
| `x`, `y`, `z` | 3 × `i32` | Node coordinates at `level` |
| `box` | 6 × `f32` | Content box, relative to `bounds` minimum |
| `pack`, `offset`, `length` | `u32`, `u64`, `u32` | Where the tile bytes are |
| `triangles`, `elements` | 2 × `u32` | For budgeting before the fetch |
| `gpuBytes` | `u32` | Exact GPU bytes the tile occupies once uploaded |
| `digest` | 8 bytes | xxh3-64 of the tile bytes: integrity and store deduplication |
| reserved | `u32` | Zero in `t1` |

A 100,000-node model has an 8 MB node table before compression. Past that size
the reserved external-subtree flag is the way out; `t1` does not need it.

Rejected:

- *A literal `tileset.json` with explicit tiles.* About five times larger for
  the same information, and it cannot state pack ranges or GPU bytes without
  extensions on every tile.
- *One request per node to discover children.* It serialises the open into a
  chain of round trips. The whole tree in one object lets the scheduler plan
  every slot before the first tile request.

### 1.3 Container

Leaf tiles, proxy tiles and the manifest share one container:

```text
header   16 bytes   magic "IFLT", u16 rev, u16 kind, u32 sectionCount, u32 flags
directory           sectionCount × 24 bytes:
                    u16 type, u8 filter, u8 codec, u32 stride,
                    u64 offset, u32 storedLength, u32 rawLength
sections            each starting on an 8-byte boundary
```

All integers are little-endian. A reader skips section types it does not know,
so adding a section is not a format bump.

`filter` is applied before `codec` on write and undone after it on read:
`0` none, `1` byte shuffle over `stride` (all first bytes, then all second
bytes, ...), `2` delta then shuffle (for indices).

`codec`: `0` stored, `1` LZ4 block.

Decision: LZ4 block with the shuffle filters, chosen per section by the tiler.
The exact default per section type is fixed in phase 1 from measured ratios on
the reference models; because filter and codec are per section in the
directory, that choice is not a format change.

Rejected:

- *zstd.* The server deliberately ships without the C `zstd` dependency
  (LZ4_RAW only), and browsers have no native zstd decoder to lean on.
- *Draco or meshopt.* Both re-order or re-quantise vertices. Leaf records sit on
  the renderer's global lattice so that coincident surfaces stay bit-coincident;
  a codec that moves a vertex by one step reintroduces seams. Both also need a
  decoder module on the hot path.
- *HTTP `Content-Encoding` only.* Tiles are read by byte range out of packs, so
  the stored bytes must be the addressed bytes, and compressing per request
  spends server CPU on immutable data. Pack responses are sent with
  `no-transform` and are excluded from the server's compression layer.

### 1.4 Leaf tile

A leaf tile is a set of **draw groups**. A group is exactly one compact page of
`compact-store.ts`: one lattice level, one lattice window, one colour and
finish, at most 65,536 vertices, one 2^24 id page. So a group uploads as it is.

| Section | Content |
| --- | --- |
| `GROUPS` | Per group: palette slot, lattice level, window origin (3 × `i64`, in steps), vertex start and count, index start and count, flags (transparent) |
| `RECORDS` | 12-byte records, groups back to back: `u16` x, y, z offsets from the window, `u16` octahedral normal, `u32` entity lane. The layout of `quantize.ts` |
| `INDICES` | `u16` indices, local to their group |
| `FEATURES` | Per draw range, sorted by `(group, firstIndex)`: `expressId`, group, first index, index count, first vertex, vertex count, source vertex count, box (6 × `f32`), geometry class, IFC type id |
| `TYPES` | String table for the IFC type ids used in this tile |
| `MESHES_F32` | Optional. Meshes the compact encoder refuses (textured, wider than a window, more than 1% area lost on the lattice, ...): positions, normals, `u32` indices, `f64` origin, colour, plus their own feature rows |
| `SHAPES`, `OCCURRENCES` | Optional. Shared shapes inside this tile and their occurrences: shape index, `expressId`, `f64` origin, 3 × 3 rotation, colour. The `shared-shapes` contract, `world = origin + R * p` |

Feature ids. The entity lane of every vertex holds
`(expressId & 0xFFFFFF) | (colourSalt << 24)`, exactly what the encoder writes
today, with the model-local `expressId`. The `FEATURES` table gives the full id
and the draw range of each element, so the client never scans vertices to learn
which element is where.

In a federated slot the renderer draws global ids (`expressId + offset`). The
decode worker adds the slot offset to the low 24 bits of each lane when
`offset & 0xFFFFFF` is not zero. That is one pass over 4 of every 12 bytes, in
the worker that already decompresses the section. The first slot has offset 0
and skips it, which keeps the single-model rule `globalId === expressId`. The
batch anchor is pinned to the group's global id page. A group whose ids straddle
a global 2^24 boundary after the shift is split at a draw-range boundary using
`FEATURES`.

Rejected: a per-batch id offset in the shader. It touches the main, pick,
shadow and selection pipelines for a cost the worker pays in microseconds.

Colour buckets. Groups are keyed by palette slot, and the client derives the
Scene bucket key from the tile, not from the mesh:
`slot ~ cell ~ colourKey`, through `bucketBaseKeyFor` and `entityIdPageKey`.

Shared shapes are limited to one tile in `t1`. A shape repeated across tiles is
stored once per tile. A model-wide shape pack (section type reserved) is the
follow-up if measurements on instancing-heavy models justify it; it is left out
because a shape shared across tiles makes tile memory depend on other tiles,
which breaks the budget arithmetic.

### 1.5 Size targets and parts

| Object | Target | Hard rule |
| --- | --- | --- |
| Leaf tile | at most 4 MiB stored | A cell above the target is written as parts |
| Proxy tile | at most 512 KiB stored | Bounded by the cluster grid, no split |
| Pack | 8 MiB | A tile never spans packs; a larger tile is its own pack |
| Manifest | under 1 MiB for most models | See external subtrees |

Parts. The renderer has no structure below the 32 m cell, so a dense cell is not
subdivided in space. Its meshes are sorted by box diagonal, largest first, and
cut into parts at the size target. Part 0 holds the envelope and the structure,
later parts hold the small items. The scheduler fetches parts in order, so a
dense cell fills in by visual importance.

Packs. Leaf tiles are appended to packs in Morton order of their cell. Proxy
tiles go into the overview packs, coarsest level first, so that the first pack
request of a slot yields a complete far-field picture. A model whose tiles total
under 8 MiB is one pack and one request, so small models do not regress.

Rejected: one object per tile. Sparse models produce thousands of tiles of a few
kilobytes, which costs a request, a store object and an index entry each. Packs
with range reads are how PMTiles and COPC solve the same problem, and the repo
already streams COPC by range.

## 2. Cell, anchor and clustering rules

These rules are normative for the Rust tiler and for the TypeScript renderer.

**R1 Frame.** All rules are evaluated in the mesh frame, on the values the
server emits: `origin` as `f64`, positions as `f32`.

**R2 Unit.** The unit of assignment is one emitted mesh. A mesh is never split.
An element with several meshes can land in several tiles.

**R3 Anchor.** `anchor[a] = origin[a] + f64(positions[a])` for the first vertex,
computed in `f64`. A mesh with no vertex anchors at its origin.

**R4 Leaf cell.** `cell[a] = floor(anchor[a] / 32)`. A point on a cell face
belongs to the higher cell. `-0` is cell 0.

**R5 Range.** A cell is valid when every coordinate is an integer in
`[-2^20, 2^20 - 1]` (about 33,000 km each way). A mesh with a non-finite or
out-of-range coordinate goes to the tileset's single **stray** tile, which has
no parent and is always wanted when its box is in view. The renderer's `nan`
cell is the same idea.

**R6 Nodes.** The node of a cell at level `L` is `cell >> L` per axis
(arithmetic shift, which floors). Node edge is `32 * 2^L` metres. Levels are
added while the top level has more than 4 nodes and `L < 10`, the stopping rule
of `HlodTree.build`.

**R7 Membership.** A mesh belongs to node `(L, c)` exactly when its leaf cell
shifted by `L` equals `c`. The tree is strict: every leaf has one parent chain.

**R8 Proxy clustering.** For node `(L, c)`:

- Node origin `N = c * edge`, exact in `f64`.
- Cluster size `s = edge / proxyGrid`.
- Input vertices, in order: at level 1 the node's meshes in tile order (R9); at
  higher levels the child proxies in child order `dx + 2 * dy + 4 * dz`, each
  child's palette slots ascending.
- Per vertex: `p = f32(world - N)`, cluster coordinate
  `clamp(floor(f64(p) * (1 / s)), -65536, 65535)` per axis. Clusters are separate
  per palette slot.
- A cluster's position is the mean of its input vertices, summed in `f64` in
  input order, stored as `f32`. Its feature id is the id of the first vertex
  that created it.
- A triangle with two corners in one cluster is dropped. A triangle whose
  unordered cluster triple was already emitted in its slot is dropped.

This is the rule of `draw-stream-proxy-worker.ts` with one change: the origin is
the nominal node corner instead of the centre of the content box, so the grid
does not depend on the data and adjacent nodes cluster on one global grid.

**R9 Order.** Inside a tile, groups are ordered by (lattice level, window,
palette slot, id page), and draw ranges inside a group by (`expressId`, emission
ordinal). The tiler sorts; nothing depends on thread scheduling.

A proxy tile stores, per palette slot, cluster positions (`f32`, relative to
`N`), cluster feature ids (`u32`) and `u32` triangle indices. The client expands
that to the flat-shaded 28-byte vertices the proxy pipeline draws (face normal
per triangle), which is the second loop of today's worker. Shipping the indexed
form is several times smaller than shipping the expanded vertices.

### Where this differs from the renderer today

The renderer currently has three related rules, and only one of them is R4:

| Site | Rule today | For tiled slots |
| --- | --- | --- |
| `chunkCellKey` (Scene buckets) | Anchor, `floor(/ 32)` | Unchanged: this is R4 |
| `buildStreamNodes` (stream leaf nodes) | Centre of the batch box, `floor(/ 32)` | The tile's cell, taken from the manifest |
| `HlodTree.build` (level 1 membership) | Centre of the piece box, `floor(/ 64)` | `cell >> 1` (R7), taken from the manifest |

Because today's level-1 membership is by box centre, a piece can sit in a
level-1 node that is not the parent of its leaf cell. `linkHlodLeaves` handles
that by linking leaves to every node their bounds touch and by marking shared
nodes dirty. A streamed tree cannot work that way: refining a node must be
answerable from the tree alone. So tiled slots use the strict tree of R7, and
dirty marking becomes exact by key. Locally loaded slots keep their current
builder; the two never mix inside one slot. Moving the local builder to R7 as
well is recommended once tiled slots have pixel parity, so that one rule
remains.

The compact encoder's lattice window (the cell holding the box minimum, on a
grid offset by half a cell) is a quantisation detail, not a tile rule. It stays
as it is and appears only as the group window.

### Golden fixture

`tests/fixtures/tiled-federation/tile-grid.json` holds:

- `cells`: anchors (origin and first vertex as IEEE-754 bit patterns) with the
  expected cell, or `null` for stray. It covers cell faces, the largest `f32`
  below a face, negative zero, the smallest negative value, an empty mesh, a
  case where an `f32` sum would pick the wrong cell, both ends of the valid
  range, NaN, infinity and a finite out-of-range value.
- `nodes`: leaf cells with their node coordinates at levels 1, 2, 3, 4, 10 and
  20, including negative coordinates.
- `clustering`: a small triangle soup with the expected cluster coordinate per
  vertex and the surviving triangles (corner ids and centroid bits): a survivor,
  a duplicate, a collapsed triangle, a second colour slot, the negative side, a
  vertex on a cluster face and a reversed duplicate.

Floats are stored as bit patterns in hex, so no JSON number parser is part of
the contract.

The fixture was generated by running `chunk-grid.ts` and the proxy worker
source. `packages/renderer/src/tile-grid-golden.test.ts` asserts that the
renderer still produces it. The Rust tiler gets the mirror test in phase 1,
reading the same file. Either side changing its rule alone turns its test red.

## 3. Client

### 3.1 One load path

A tiled open is a branch inside `useIfcLoader.loadFile(file, target)`, selected
when the source is a `ProcessedModelRef` and the server resolves a tileset for
it. It is not a second pipeline. Everything `loadFile` does at load time
(registry reservation, model slice, data store wiring) runs once for both
branches; only the geometry source differs.

At open, per slot:

1. `GET` resolve, then the manifest.
2. `FederationRegistry.reserveModel(modelId, counts.maxExpressId)`.
3. Register the slot's node table with the scheduler.
4. Fetch the data-model skeleton (section 4).

### 3.2 Scheduler

One `TileScheduler` serves every slot. It runs when the camera, the viewport,
the visibility state or the pinned scopes change, throttled while the camera
moves.

Selection, per slot, top down from the roots, with the slot placement applied
to node boxes:

```text
visit(node):
  if node box outside frustum and node not pinned: return
  if visibility(node) == all hidden: return
  sse = geometricError(node) * pxPerMetre(distance to node box)
  if node.level > 0 and sse <= errorPx and not mustRefine(node):
      want proxy of node
  else if node.level == 0:
      want leaf parts of node
  else:
      for child in node.children: visit(child)
```

`pxPerMetre` and the box distance are the functions the draw stream already
uses, and `errorPx` starts at `hlodPx`. `mustRefine` is true for nodes that a
pinned scope intersects.

Priorities:

| Class | What | Notes |
| --- | --- | --- |
| P0 | Interaction: tiles of the selected elements, the leaf under the cursor for pick, measure and snap | Small, never throttled |
| P1 | Wanted by the view, ordered coarse first, then by projected size | Proxies before leaves, so a frame is complete early and sharpens |
| P2 | Scope jobs: section, clash, 2D, export | Own queue per job, with progress and cancel |
| P3 | Prefetch: neighbours of wanted nodes and one level finer along the camera motion | Only when P0 to P2 are idle |
| P4 | Offline pin fill | Background |

Requests. Wanted tiles are grouped per pack. Ranges closer than 64 KiB are
merged into one `Range` request. Requests for tiles that are no longer wanted
are aborted. Decode (decompress, lane shift, proxy expansion) runs in a worker
pool; the main thread only uploads.

Budget. One budget for all slots, in three numbers: GPU bytes, CPU bytes, and
bytes in flight. The manifest states `gpuBytes` per tile, so the scheduler knows
the cost of a selection before fetching it.

- Eviction is the existing policy, across slots: never a tile drawn this frame,
  least recently drawn first, and only after `MIN_EVICTION_AGE_FRAMES`.
- When the wanted set of the current view exceeds the budget, the scheduler
  raises `errorPx` for all slots by a common factor until the selection fits,
  and lowers it again with hysteresis. Memory follows the view by coarsening the
  far field, not by dropping what is on screen.
- If the view cannot fit even at the coarsest selection, it draws anyway and
  reports the overshoot, as the residency policy does today.

Tile states:

```text
absent -> fetching -> decoded -> resident
                        ^           |
                        +-- warm <--+   (GPU buffers freed, CPU bytes kept)
                        |
                     cold  (neither; back through the browser cache or network)
```

The cold tier is the tile source. It implements `ColdGeometryProvider`, mapping
a world box to leaf tiles through the node table. A persistent browser store
(OPFS or the Cache API, keyed by tileset and node) sits between the network and
the decode worker; it is also where offline pins live.

### 3.3 Chunk cells, HLOD nodes, residency

Leaf tiles. A decoded leaf tile is handed to the Scene as compact groups. Each
group becomes a compact page, uploaded with `writeBuffer`, filed under the
bucket key `slot ~ cell ~ colour`. The stream leaf node for the cell is created
from the tile, with the manifest box. Meshes in `MESHES_F32` and shared shapes
take the paths they take today (f32 buckets, instance pool).

Compact pages cannot move: today a model with a placement decodes back to f32.
For tiled slots each slot gets its own compact store whose origin is the slot's
placement translation, so a translated slot stays on 12-byte records. A slot
whose placement includes a rotation decodes to the f32 path in the first
release; that costs memory, not correctness.

Proxy tiles. `HlodTree` gets a second way to fill a node beside its worker:
adopting a decoded proxy. For a tiled slot the tree's nodes come from the node
table, `pump` asks the scheduler instead of submitting worker jobs, and a node
becomes `ready` when its proxy tile is adopted. One tree per slot, node keys
prefixed by slot.

Selection in the draw stream gains one rule. Today a node that cannot draw its
proxy refines, and its leaves are always present. With streaming they may not
be:

- A node draws its proxy when its error is within `errorPx`, **or** when a
  wanted descendant is not resident yet. Refinement replaces the proxy only once
  every wanted child of that node is resident. There are no holes and no popping
  to empty.
- The roots' proxies of every open slot are pinned and exempt from eviction.
  They are the guaranteed fallback and they are small.

### 3.4 Hide, isolate and colour overrides

Visibility and colour overrides are id sets held in the entity visibility and
colour tables, keyed by global id. They do not depend on which geometry is
resident, so a tile that arrives later is drawn with the current state. Nothing
is patched per tile.

What changes is refinement. Today any hidden or painted element forces its nodes
to refine to leaves. Under streaming, isolating one storey would then fetch the
whole model. Two additions prevent that:

1. **Membership without geometry.** The entity index (section 4) maps an
   `expressId` to the tiles that hold it. With the manifest's element count per
   node, the scheduler classifies each node as all visible, all hidden or mixed
   without fetching it. All-hidden nodes are skipped entirely. Isolate therefore
   fetches only the isolated elements' tiles.
2. **Proxies honour the tables.** Proxy vertices carry element ids. The proxy
   pipeline reads the entity visibility and colour tables by that id, as leaf
   batches do. A cluster carries the id of one of its elements, so the result is
   approximate, but a cluster projects below `errorPx`, so the approximation is
   bounded by the same screen-space error that allowed the proxy in the first
   place. Mixed nodes that are far away keep drawing their proxy.

Mixed nodes within range refine to leaves as today, and partly hidden batches
there use the existing sub-batch path and its residency rules
(`scene-subset-residency.ts`).

X-ray and transparency overrides still force leaves where they are in range;
beyond it the proxy is drawn with the override's alpha.

### 3.5 Picking and selection

- **Pick over resident leaves**: unchanged.
- **Pick over a proxy**: the pick pass draws proxies where leaves are not
  resident. The id under the cursor is the cluster's representative element, so
  the hit is provisional. The scheduler pins the leaf tiles the pick ray crosses
  inside that node at P0, nearest first, and the pick is repeated when they are
  resident. Hover shows the provisional hit; a click commits the exact one. If
  the tiles do not arrive within a short timeout the provisional hit is
  committed and marked approximate.
- **Selection from the tree or search**: the element may have no resident
  geometry. Its tiles come from the entity index and are pinned at P0; the
  highlight appears when they arrive. Zoom-to-selection does not wait: the
  entity row carries the element's box.
- **Measure and snap**: only on exact geometry. The leaf under the cursor is
  pinned at P0 and snapping is offered once it is resident.

### 3.6 Clash, 2D and section

Tools that need real geometry for a scope ask for it and consume it tile by
tile:

```text
tileSource.leafMeshes(scope, { signal, onProgress }) -> async iterator of mesh batches
scope = { slots, ids? , box?, slab?, storey? }
```

- The iterator yields CPU meshes. It does not make them GPU-resident and does
  not spend the GPU budget. It applies back-pressure against the CPU budget, so
  a consumer must work tile by tile and release as it goes.
- **Clash**: broad phase on the node tables of both slots first. Only pairs of
  leaf tiles whose boxes overlap (with the clash tolerance) are fetched.
- **Section and 2D**: the leaf tiles whose box meets the cut slab. The 3D
  section preview on proxies is drawn clipped; the exact cut waits for the
  scope job, which reports progress.
- **Export and other whole-model consumers**: a scope covering the model. They
  stream every leaf in Morton order and never hold the whole model.

## 4. Properties on demand

Today `/api/v1/parse/data-model/{cache_key}` returns one blob: eight Parquet
tables behind length prefixes, read whole. For a tiled model the same tables are
written as an **indexed data model** in the tileset's data-model packs.

Order. The tiler knows the primary tile of every element (the tile of its first
mesh by R9; elements without geometry go last, grouped by their spatial
container). Entities are sorted by (Morton code of the primary cell,
`expressId`). Property and quantity sets are sorted by the first entity that
references them, so the sets of a cell are contiguous while a set shared by many
elements is stored once.

Shards. Tables are cut into shards of at most 8,192 entities (and the matching
property rows). Each shard is a complete, self-contained Parquet file inside a
pack, addressed by byte range through a directory in the manifest head. A shard
is the row group, made independently readable.

Rejected: one large Parquet file read through its footer and row-group offsets.
It is the textbook answer, but it makes correctness depend on the browser
decoder supporting partial reads. Self-contained shards work with any reader,
and the footer overhead per shard is a kilobyte or two.

Indexes, fixed-width and sorted, so they can be binary searched by range read or
fetched whole when small:

| Index | Row | Use |
| --- | --- | --- |
| Entity index | `expressId` `u32`, entity ordinal `u32`, primary node ordinal `u32`, flags `u8` (multi-tile, has geometry) | Id to shard, id to tile |
| Multi-tile table | `expressId`, node ordinal | Elements whose meshes span tiles |
| GlobalId index | 16-byte decoded GlobalId, `expressId` | BCF, links, federation by GlobalId |
| Set index | set id, first row, row count per table | Set rows by range |

Each index has a sparse page table in the directory (every 4,096th key), so a
single lookup is one range read of one page.

Skeleton. Fetched at open: the spatial hierarchy table and three columns per
entity (`expressId`, type id, container id). It is what the model tree, the type
filters and the counts need, at 12 bytes per entity before compression. Names, attributes
and property sets are fetched per shard as rows scroll into view or an element
is selected.

Entity rows carry the element's box (6 × `f32`), which is what lets selection
and zoom work before any geometry is resident.

Full-text search over names of a model that is not loaded stays open: see
[Open questions](#open-questions).

## 5. Server

### 5.1 Tiler stage and its memory bound

The tiler is a `ProcessingSink` on the streaming pass. The request runs with
`retain_meshes = false`, so the pass never holds the model's meshes, and the
tiler never does either.

```text
geometry pass ──batches──▶ spill  ──per cell──▶ leaf tiles ──per node──▶ proxy tiles
                             │                      │                        │
                         disk runs              leaf packs             overview packs
```

1. **Spill.** For each mesh in a batch: compute its cell (R3 to R5), append its
   bytes to that cell's run in a spill file, record `expressId -> cell`. Write
   buffers are bounded in total (default 256 MiB) and flushed largest first.
2. **Leaf tiles.** For each cell in Morton order: read its runs, sort (R9),
   find shared shapes, run the compact encoder, cut parts, write the tile to the
   current pack. Memory is one cell at a time. A cell larger than a fixed cap
   (default 512 MiB of mesh bytes) is processed part by part with the diagonal
   sort done on an index of boxes, not on the meshes.
3. **Proxy tiles.** Level 1 from its up to eight leaf cells, read back from the
   spill; each higher level from its children's proxies, kept in a temporary
   file until the parent is built. Memory is one node's input.
4. **Data model.** Built by the pass as today, then ordered and sharded with the
   `expressId -> cell` map (8 bytes per element with geometry).
5. **Manifest**, then an atomic publish: the tileset directory is renamed into
   place, and only then does resolve return it.

Bound. Tiler memory above the pass is
`write buffers + largest cell (capped) + 8 bytes per element + node table`,
which does not grow with model size beyond the last two small terms. The
acceptance check is in section 7.

The compact encoder moves out of `rust/wasm-bindings` into a crate both the wasm
bindings and the tiler depend on, so there is one encoder. Proxy clustering
(R8) is new Rust, pinned by the fixture.

Disk. Spill plus packs need about twice the tileset size during prepare. The
prepare is refused up front when the cache volume cannot hold it.

### 5.2 Storage

```text
trait TileStore
  put_pack(tileset, n, bytes stream)
  get_range(tileset, n, range) -> bytes stream
  publish(tileset) / resolve(sha256, prepare) / delete(sha256)
```

- **Local directory first**: plain files under
  `{cache_dir}/tiles/{sha256[0..2]}/{sha256}/{tileset}/`. Not `cacache`, which
  has no ranged read and re-hashes content on read. Range reads are positional
  file reads.
- **S3-compatible later**: one object per pack, ranged `GET`. Optionally the
  route answers with a short-lived redirect to a presigned URL so that tile
  bytes bypass the server.

Retention follows the existing cache age rule. The access stamp is updated on
resolve, not on every range read.

### 5.3 Routes

| Route | Result | Caching |
| --- | --- | --- |
| `POST /api/v1/tiles/{sha256}/prepare` (options as on the parse routes; body is the file unless the source is already stored) | Progress events, then the tileset id. Single flight per `(sha256, prepare)`, under `Admission` | none |
| `GET /api/v1/tiles/{sha256}` (same options) | `{ tileset, manifestBytes }`, or `404` when not prepared | `private, max-age=60` |
| `GET /api/v1/tiles/{sha256}/{tileset}/manifest` | Manifest | immutable |
| `GET /api/v1/tiles/{sha256}/{tileset}/pack/{n}` | Pack bytes, `Range` supported (`206`) | immutable |
| `GET /api/v1/tiles/{sha256}/{tileset}/dm/{n}` | Data-model pack bytes, `Range` supported | immutable |
| `DELETE /api/v1/tiles/{sha256}` | Removes the model's tilesets | none |

Immutable responses carry:

```text
Cache-Control: private, max-age=31536000, immutable, no-transform
ETag: "<pack digest>"
Accept-Ranges: bytes
```

`private` is the default because tiles are never public. A host that
authenticates at its edge can configure `public` for the edge-auth deployment
described below.

`sha256` is validated with `is_file_digest` and `tileset` against its exact
shape before any path is built. The existing whole-model routes stay; a model is
tiled only when a prepare asked for it.

### 5.4 Authorisation hook

Tile requests are frequent, so the check must be local and constant time, with
no call to the host per request.

```text
trait TileAuthorizer
  authorize(request headers, sha256, action: Read | Prepare | Delete) -> Allow | Deny
```

It runs as middleware on `/api/v1/tiles/*`, where the bearer check runs today.

| Implementation | Behaviour |
| --- | --- |
| Static bearer | The existing `api_token` check. For single-tenant and development servers |
| Grant | A short-lived token signed by the host: expiry (15 minutes at most), audience, allowed actions, and the list of allowed `sha256` values (up to 256 per grant). The server verifies the signature with a configured key and checks that the request's `sha256` is in the list |

With a grant key configured, no tile, manifest or data-model byte is served
without a valid grant. The host decides who may see which model and mints the
grant; the server only enforces it. The client takes a
`grantProvider` and refreshes before expiry. The token travels in the
`Authorization` header, never in the URL, so it is not logged or cached with
the path.

Rejected: a callback from the server to the host on each request (latency and a
hard dependency on every tile read), and unguessable URLs as the only protection
(a leaked URL is permanent access to immutable data).

## 6. Offline, CDN, versioning

### 6.1 Offline pins

A pin is a tile list, not a copy of a file:

```json
{ "tileset": "…", "sha256": "…", "nodes": [[0, 412], [9000, 9041]], "dataModel": "all" }
```

`nodes` are ranges of node ordinals in the manifest. Kinds of pin:

| Kind | Tiles |
| --- | --- |
| Whole model | Every node, every data-model shard |
| Viewpoints | All proxies plus the leaves wanted by the saved viewpoints |
| Scope | The tiles of a storey, zone or id set, from the entity index, plus all proxies |

Pinned tiles are stored per (tileset, node) in the persistent browser store and
are exempt from its LRU. The manifest and the data-model directory are always
part of a pin. Because every pin includes all proxies, a pinned model opens
complete offline and is exact where pinned. Storage use is known before the pin
starts, from the manifest. A grant is needed to fill a pin, not to read it
back.

### 6.2 CDN

Two deployments:

- **Origin auth** (default): responses are `private`. The browser caches them;
  shared caches do not. Nothing to configure.
- **Edge auth**: the edge verifies the same grant and caches packs under the
  URL path. Then `public` is safe, and immutable packs are a single cache entry
  per slice. Pack size (8 MiB) is chosen to match common range-slice sizes.
  `no-transform` keeps the edge from re-encoding ranges.

### 6.3 Versioning and format bumps

Old tilesets are never rewritten. A change is one of three kinds, and none of
them is eager:

| Kind | Example | What happens |
| --- | --- | --- |
| Container | New filter, new optional section | Not a bump: readers skip unknown sections |
| Tiling (`rev` + 1) | Different part rule, new required section | The new tileset is built from the stored one, tile by tile, without the IFC: on first open of that model, in the background, under admission |
| Geometry (`GEOMETRY_REVISION` + 1) | Mesh output changed | A new prepare from the source, on first open of that model, under admission |

In both bump cases the old tileset keeps being served until the new one is
published, so the user opens immediately on old tiles. The viewer ships decoders
for the current and the previous `rev`. Resolve returns the newest tileset the
client says it can read (`Accept` parameter `rev`). Offline pins keep working
because their tileset is still addressed by its old key. Only models that are
actually opened are rebuilt, at the rate admission allows, so a release cannot
cause a re-prepare storm. Old tilesets age out by the retention rule.

## 7. Delivery and acceptance

### 7.1 Phases

Each phase ships on its own and is off unless its flag is set.

| Phase | Ships | Flag | Exit criterion |
| --- | --- | --- | --- |
| 0 | This document, the fixture, the renderer test | none | Merged |
| 1 | Shared compact-encoder crate, tiler library, container encode and decode (Rust and TypeScript), `ifc-lite` debug command that tiles a file to a directory | none (offline tool) | Rust and TypeScript both pass the fixture; a decoded tileset equals the whole-model meshes element for element; tile size distribution and compression ratios measured and the per-section defaults fixed |
| 2 | Tile store (local), routes, static-bearer and grant authorisers, prepare under admission | `IFC_SERVER_TILES` | Route golden tests; tiler memory bound met (7.3); a grant for hash A cannot read hash B |
| 3 | Viewer: one tiled slot through `loadFile`, all leaf tiles fetched nearest first, no proxies, no eviction | viewer perf flag `tiles` | Pixel parity with the whole-model path on the qualification models (the `flag-qualify` tool) |
| 4 | Scheduler: screen-space error, proxies adopted into `HlodTree`, one budget, eviction, the fallback rule, proxy visibility and colour, provisional picking | `tiles.stream` | No holes during navigation; memory stays within budget on the largest model; hide, isolate, pick and select behave as in 3.4 and 3.5 |
| 5 | Federation: N slots, one scheduler and budget; scope iterator for clash, section, 2D, measure | `tiles.federation` | The acceptance table below, for 1, 2, 3 and 5 models |
| 6 | Indexed data model and the skeleton open | `tiles.dataModel` | Properties panel, tree and BCF lookups work on a model whose data model was never fully downloaded |
| 7 | Offline pins, S3 store, edge-auth deployment, a rehearsed `rev` bump | per feature | A pinned model opens with the network off; a `rev` bump on a test server rebuilds only opened models |

Phases 1 and 2 touch perf-sensitive Rust paths and carry a perf verdict each.
Phase 3 onward is renderer work behind flags, qualified flag-on against
flag-off before any default changes.

### 7.2 Acceptance metric

The claim is that open time and peak memory follow the view, not the number or
size of models. It is measured on federations of 1, 2, 3 and 5 models, same
models, same saved viewpoint, same machine, whole-model path against tiled
path.

Definitions:

- **Open time**: from the open request to the first frame in which every slot
  draws something for every node in view (proxy or leaf).
- **Time to exact**: until every leaf wanted by the viewpoint is resident.
- **Peak memory**: peak of JS heap plus GPU buffer bytes during open and a fixed
  camera path.
- **Bytes fetched**: network bytes until time to exact.

The whole-model baseline is being measured separately; its numbers go here.

| Models | Open time, whole model | Open time, tiled | Time to exact, tiled | Peak memory, whole model | Peak memory, tiled | Bytes fetched, whole model | Bytes fetched, tiled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | pending | pending | pending | pending | pending | pending | pending |
| 2 | pending | pending | pending | pending | pending | pending | pending |
| 3 | pending | pending | pending | pending | pending | pending | pending |
| 5 | pending | pending | pending | pending | pending | pending | pending |

Pass conditions, to be confirmed against the baseline when it lands:

1. Tiled open time with 5 models is at most 1.5 times tiled open time with 1
   model.
2. Tiled peak memory with 5 models stays within the configured budget plus 25%,
   and is not higher than with 1 model by more than the per-slot fixed cost
   (manifest, skeleton, root proxies).
3. For 1 small model (one pack), tiled open time is not worse than the
   whole-model path.
4. Pixel parity with the whole-model path at time to exact.

### 7.3 Server acceptance

| Measure | Condition |
| --- | --- |
| Tiler memory above the geometry pass (peak RSS of a tiled prepare minus peak RSS of the same pass with a discarding sink) | Below the configured bound (write buffers plus cell cap plus index) on the 0.2, 0.6 and 1.2 GB reference files, and flat across them |
| Prepare time | Reported against the whole-model Parquet route on the same files; no pass condition yet |
| Tileset size | Reported against the `shared-shapes` geometry blob for the same model |

## Risks

| Risk | Mitigation |
| --- | --- |
| A mesh much larger than a cell (a 300 m slab) sits in one leaf tile and is fetched whenever any part of it is in view | The node box is the content box, so culling is correct. The part order puts such meshes first. Splitting meshes is rejected: the renderer's rule is that a mesh never splits |
| Proxy visibility by cluster id is approximate | Bounded by `errorPx`; mixed nodes in range refine to leaves |
| Many tiny tiles on sparse models | Packs and range merging; a small model is one request |
| The strict tree changes which node a piece's proxy lives in, against today's box-centre rule | Only for tiled slots; qualified by pixel comparison in phase 4 |
| Rotated slot placements lose the 12-byte path | Stated limit of the first release; measured in phase 5 |
| Element ids above 2^24 | Already handled by id pages; groups are split per page |

## Open questions

1. **Name search on a model whose data model is not loaded.** Options: a
   name-only column shard set scanned in the background, or a server query
   route. Not needed before phase 6.
2. **Model-wide shape pack.** Decide from phase 1 measurements on
   instancing-heavy models.
3. **Which geometry classes proxies include.** Proposed: the classes the Model
   view draws; type-library shapes only in leaves. To confirm against the
   Model/Types switch (#957) in phase 4.
4. **Browser decoder for LZ4.** A small JavaScript block decoder in the worker,
   or the existing wasm module. Decide in phase 1 by measured decode rate and
   bundle size.
5. **Grant signature scheme.** HMAC-SHA256 (shared key, simplest) or Ed25519
   (the server holds only a public key). Proposed: Ed25519, so a compromised
   tile server cannot mint grants.

## Assumptions to verify in phase 1

These were not verified while writing this design:

- That the proxy pipeline can read the entity visibility and colour tables with
  the per-vertex id it already carries, at acceptable cost.
- That slot placements in use are translations in the common case.
- That LZ4 with shuffle filters gets within a useful distance of the transport
  compression the whole-model blob gets today.
