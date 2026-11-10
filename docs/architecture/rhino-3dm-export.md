# IFC → Rhino .3dm export (spec)

Status: phase 1 (Rust scene) implemented in `rust/export/src/rhino/`; adapters
pending. This page is the contract for writing
Rhino `.3dm` files from an IFC model with McNeel's `rhino3dm` library: what is
written, how each IFC concept maps, where the code lives, and how it is tested.

Evidence tags: **[ran]** measured or round-tripped with rhino3dm 8.35.0,
**[src]** read in the rhino3dm / openNURBS source or this repo,
**[unproven]** not yet confirmed (most items that need a real Rhino to check).

## Why

Rhino has no native IFC import or export (McNeel wish RH-52747, no planned work).
Existing routes are paid plugins, slow on 100 MB+ files, drop property sets, or
put everything on one layer. A `.3dm` written by ifc-lite opens in any Rhino
(7, 8, 9; Windows and Mac) with no plugin, with the spatial tree as layers, IFC
data as Attribute User Text, and repeated geometry as blocks.

## Goals

1. Any `.ifc` / `.ifczip` the geometry pipeline reads becomes a `.3dm` that Rhino
   opens without warnings.
2. Layers mirror the IFC spatial structure; every object carries its GlobalId
   (when the element has one), class and property sets as user text.
3. Coordinates stay precise for georeferenced models; units match what the
   Rhino user expects.
4. Same output from CLI, MCP, viewer and (later) Python.

Non-goals for v1: reading `.3dm` back into IFC, NURBS/Brep or Extrusion solids,
curves (axes, grids, annotations), textures, federated multi-model files.
They are listed under [Later phases](#later-phases).

## Architecture

Two modules, one seam between them.

```
IFC bytes ──► ifc_lite_export::rhino  (Rust)        ──► RhinoScene (manifest JSON + binary blob)
              all IFC interpretation                         │
                                                             ▼
              @ifc-lite/rhino3dm  (TS adapter, rhino3dm.js)  ──► .3dm bytes
              ifclite_geom + rhino3dm PyPI (Python adapter, phase 4)
```

- **`ifc_lite_export::rhino`** is the deep module. It runs the geometry pass,
  resolves the spatial tree, units, frame, colours, instancing and properties,
  and emits a `RhinoScene`: plain data that already says which layer, material,
  group, block and user strings every object gets. No rhino3dm dependency, so it
  builds for wasm32 and native like every other exporter, and it is fully
  testable in `cargo test`.
- **Adapters** are shallow. They translate `RhinoScene` records one to one into
  rhino3dm calls and serialize. They know nothing about IFC. An adapter that
  needs an `if ifc_type == ...` is a bug in the scene.
- **The seam is the `RhinoScene` wire format** below. It is the leverage point:
  the same scene can later feed a RhinoCommon adapter inside a Rhino plugin
  (the FFI path from the Rhino.Inside analysis) without re-deriving anything.

Rejected alternatives:

| Option | Why not |
|---|---|
| Link openNURBS C++ into the Rust crate | openNURBS needs libc, `<thread>`, `<locale>`, `uuid.h` [src]; it does not build for `wasm32-unknown-unknown`, so the viewer and CLI wasm path would lose the format. Native-only C++ in `rust/export` breaks the "builds everywhere" rule `native/smlib-adapter` exists to avoid. |
| Pure-Rust 3dm writer | No public format spec (Library of Congress: "lacks an outline or documentation"); the only Rust writer, `cadmpeg-codec-rhino` 0.6.10, writes one layer, no user strings, no materials [src]. Writing our own means owning an undocumented, versioned binary format. Revisit only if rhino3dm becomes the bottleneck. |
| Add rhino3dm to `@ifc-lite/export` | Pulls a 2.67 MB wasm into a package many consumers use for CSV/JSON. A separate package keeps it opt-in and lazy. |

## The RhinoScene wire format (v1)

`build_rhino_scene(content: &[u8], opts: &RhinoSceneOptions) -> Result<RhinoScene, ExportError>`
returns the scene; `RhinoScene::encode(self) -> (String, Vec<u8>)` returns the
manifest JSON and one little-endian binary blob. `encode` consumes the scene and
drops each mesh once its bytes are in the blob. That does not lower the peak:
the blob grows while later meshes are still alive, and wasm linear memory never
shrinks, so geometry can be held about twice at once. The manifest is
the scene's own `Serialize` output flattened under `format` and `version`, so a
new scene field cannot be left off the wire.

Blob layout: sections back to back, each starting on an 8-byte boundary, so the
JS adapter takes `Float64Array` / `Float32Array` / `Uint32Array` views without
copying. A buffer reference is `{ "offset": <bytes>, "count": <elements> }`.

```jsonc
{
  "format": "ifc-lite.rhino-scene",
  "version": 1,
  "settings": {
    "unitSystem": "Millimeters",        // rhino3dm UnitSystem name
    "metersPerUnit": 0.001,
    "absoluteTolerance": 1.0,           // 1 mm expressed in unitSystem
    "angleToleranceDegrees": 1.0,
    "earthAnchor": null | {
      "latitude": 47.3769, "longitude": 8.5417, "elevation": 408.0,
      "modelBasePoint": [x, y, z], "modelNorth": [x, y, z], "modelEast": [x, y, z],
      "name": "IfcSite RefLatitude/RefLongitude"
    }
  },
  "warnings": ["length unit scale 0.5 is not a Rhino unit; wrote Meters"],
  "documentStrings": [["IFC::Schema", "IFC4"], ...],
  "layers":    [{ "name": "Level 1", "parent": 0 | null, "color": [r, g, b, a], "visible": true, "locked": false }],
  "materials": [{ "name": "Concrete", "diffuse": [r, g, b], "transparency": 0.0 }],
  "groups":    [{ "name": "2O2Fr$t4X7Zf8NOew3FLOH" }],
  "meshes":    [{ "positions": {...f64 xyz}, "normals": {...f32 xyz} | null, "indices": {...u32, triangles} }],
  "blocks":    [{ "name": "IfcFlowFitting 4711", "description": "...", "meshes": [3], "layer": 7 }],
  "objects": [
    { "kind": "mesh", "mesh": 0, "layer": 4, "name": "Basic Wall:200mm",
      "objectId": "a1b2c3d4-...",          // see Object identity; JS adapter ignores it
      "color": [r, g, b, a], "material": 2, "groups": [0],
      "userStrings": [["IFC::GlobalId", "2O2Fr$t4X7Zf8NOew3FLOH"], ...] },
    { "kind": "instance", "block": 0, "xform": [16 f64, row-major], "layer": 9, ... }
  ]
}
```

Rules the scene guarantees, so adapters never check them:

- Every index (`parent`, `layer`, `material`, `group`, `mesh`, `block`) is in range.
- Layers are ordered parent before child; sibling names are unique.
- Every coordinate and matrix entry is finite; every triangle index is in range.
- Colours are sRGB 0 to 255 integers; `a` is 255 for opaque. They are quantised
  by `ifc_lite_processing::Rgba::to_rgba8`, the one 8-bit quantiser.
- `unitSystem` is one of `Millimeters`, `Centimeters`, `Meters`, `Feet`, `Inches`
  (rhino3dm `UnitSystem` member names).
- Block geometry objects take `ColorFromParent` / `MaterialFromParent`; the
  block's `layer` is the layer its geometry objects go on.
- `warnings` holds one human-readable line per distinct condition (unit
  fallback, user-text key collision, repeated GlobalId, no earth anchor), never
  one per object.
- `positions` are already in output units and output coordinates.
- Arrays are emitted in a deterministic order (see [Determinism](#determinism)).

`version` is bumped on any incompatible change; an adapter refuses a version it
does not know rather than guessing.

## Options

`RhinoSceneOptions` (Rust) and the matching CLI flags / dialog fields:

| Option | Values | Default | CLI |
|---|---|---|---|
| `units` | `source`, `meters`, `millimeters`, `centimeters`, `feet`, `inches` | `source` | `--units` |
| `coordinates` | `local`, `world` | `local` | `--coordinates` |
| `layer_scheme` | `spatial-class`, `class`, `presentation` | `spatial-class` | `--layers` |
| `instancing` | bool | `true` | `--no-instancing` |
| `properties` | `all`, `attributes`, `none` | `all` | `--properties` |
| `include_spaces` | bool (spaces go on a hidden layer) | `true` | `--no-spaces` |
| `normals` | bool | `true` | `--no-normals` |
| `layer_slicing` | bool (material-layer wall slicing) | `false` | `--layer-slicing` |
| `hidden`, `isolated`, `hidden_types` | as `GltfOptions` | empty | viewer only |
| adapter: `version` | `7`, `8` | `8` | `--3dm-version` |

`version` is an adapter option because only the writer knows it. rhino3dm
writes archive 70 or 80; asking for 9 silently writes 80 [ran], so the adapter
accepts only 7 and 8.

## Mapping

### Geometry pass

`scene_input::gather` (instanced pass when every instance is safe, else the
fully baked pass) returns a `SceneInput`: the result, which meshes pass the
emittable gate (`mesh_emittable`: exportable class, matched normals, in-range
indices, finite values), and whether its instances may be authored. USD and 3dm
share it, so they cannot drift; USD's output stays byte-identical (its existing
tests pin it). The scene builds one entity index and hands it to both the
geometry pass and the attribute pass.

Excluded as in glTF/USD: instanced type-library meshes (`geometry_class == 2`),
void volumes (`IfcOpeningElement` and its subtypes, `IfcVoidingFeature`: cutters,
never output jobs [src]), and the viewer's `hidden` / `isolated` / `hidden_types`,
decided by the filter glTF and OBJ use (`visibility::ElementFilter`). The
void-volume and space tests are `scene_input::{is_void_volume, is_space}`, which
include subtypes. USD's `guide` purpose keeps its own exact-class match
(`IfcOpeningElement`, `IfcVoidingFeature`, `IfcSpace`), so this feature does not
change USD output. No emittable mesh and no instance is
`ExportError::NoRenderGeometry`, never an empty `.3dm` reported as success.

### Units

The pipeline emits metres. `units: source` reads the project length unit
(`ModelMetadata.length_unit_scale`): 0.001 → Millimeters, 0.01 → Centimeters,
1 → Meters, 0.3048 → Feet, 0.0254 → Inches; any other or missing scale falls back
to Meters and adds a warning. Positions are multiplied by `1 / metersPerUnit`.
`absoluteTolerance` is 1 mm in the chosen unit (1.0 in mm, 0.001 in m).

Property and quantity values are written as authored, in the file's own units
(that is what `EntityRow` holds [src]). `IFC::LengthUnit` in the document strings
records which unit that is: the Rhino unit name when the project unit is one,
else `<metres per unit> m` (e.g. `0.1 m`).

### Coordinates

Each `MeshData` stores f32 `positions` relative to an f64 `origin` [src]. The
written vertex is `origin + position` computed in f64, scaled to output units,
and written with rhino3dm `addPoint3d`, which stores double-precision vertices.
`vertices().add` stores floats and truncated 2600000.123 to 2600000.0 [ran];
it is also about 4× slower to serialize (below). Adapters must use `addPoint3d`.

- `local` (default): vertices stay in the pipeline's mesh frame. For a model near
  the origin this is IFC world. For a model the pipeline rebased (`MeshFrame::needs_shift`,
  large coordinates or site-local), it is the shifted frame, and the shift is
  recorded as `IFC::WorldFromModel` (16 space-separated numbers, row-major,
  metres, mapping the frame to IFC world before unit scaling) in the document
  strings. Rhino's display works in single precision, so working near the origin
  is what Rhino users need.
- `world`: every vertex is mapped through `MeshFrame::world_matrix()` first, so
  the file holds IFC world coordinates (survey grid). Exact in the file; the user
  accepts Rhino display jitter far from the origin.

Earth anchor point: set only when `IfcSite.RefLatitude` / `RefLongitude` exist,
read by `ifc_lite_core::site_ref_location` (the read the legacy georef fallback
uses), from the first such site by express id. `latitude` / `longitude` come
from the site, `elevation` is `RefElevation` in metres, `modelBasePoint` is the
same site's placement origin expressed in written coordinates and units: the
pipeline's `site_transform` when it is the pipeline's site (the first `IfcSite`
in the file), else its own placement through the same resolver
(`GeometryRouter::resolve_scaled_placement`). When that placement does not
resolve (for the pipeline's site: no `site_transform`), `earthAnchor` is null
and one warning says so; the base point is never guessed as the origin. A
refused length unit likewise writes no anchor, with its own warning, rather
than label `RefElevation` in file units as metres. `modelNorth`
is the model context's `TrueNorth`, else the map conversion's grid north
(`(XAxisOrdinate, XAxisAbscissa)` normalised), else +Y; `modelEast` is north
turned -90° about Z; both are mapped into the written frame. The only earlier
`TrueNorth` read was the map-conversion STEP rewrite
(`export/src/step_map_context_metadata.rs`), which has its own refusal policy,
so phase 1 added a general reader, `ifc_lite_core::model_true_north`, beside the
site read in `core/src/georef_site.rs`. `IfcMapConversion` cannot become latitude/longitude without a projection
library, so its fields go to document strings only (`IFC::MapConversion::Eastings`,
`::Northings`, `::OrthogonalHeight`, `::XAxisAbscissa`, `::XAxisOrdinate`,
`::Scale`, `IFC::CRS`). The settings getter returns a copy; the adapter assigns
the anchor back after filling it [src].

`RefElevation` is height above sea level, so the adapters set the anchor's
elevation zero to `MeanSeaLevel`. openNURBS 8.35 does not persist it: on write
the unset coordinate system overrides the legacy field on read
([opennurbs_3dm_settings.cpp](https://github.com/mcneel/opennurbs/blob/8.x/opennurbs_3dm_settings.cpp#L4088-L4091)),
so the file reads back with Rhino's default zero [ran]. The adapters keep
setting it, and their round-trip tests for it are marked expected-failure, so
they start passing (and must be un-marked) when upstream fixes the write.

### Layers

`spatial-class` (default):

```
<Project name>
└── <Site>
    └── <Building>
        ├── <Storey>                 (ordered by elevation, then express id)
        │   ├── IfcWall              (class sublayer, colour = default_color_for_type)
        │   ├── IfcSlab
        │   └── IfcSpace             (visible = false)
        └── IfcBuildingElementProxy  (elements contained directly in the building)
└── Unassigned
    └── IfcFurniture                 (no spatial container found)
IFC block geometry                   (see Blocks; visible, locked)
```

- The spatial edges are `relationships()` and the walk is the export formats'
  shared one (`spatial_walk::walk`, first parent wins); aggregated parts (stair
  flights, assembly parts) land under their ancestor's container.
- Layer nodes are the file schema's `IfcSpatialStructureElement` subtypes other
  than `IfcSpace` (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, the IFC4X3
  facility and facility-part classes), by the schema's own subtype table.
  `IfcSpace` and zones are containers, not layers: any `IfcSpatialElement`
  (`IfcSpatialStructureElement` in IFC2X3) can be an `IFC::Container`, so an
  element contained in a space goes on its storey's class layer, and its
  `IFC::Container` is the space. A spatial
  element with geometry (a site with terrain) goes on a class sublayer of its
  own layer. Spatial children come before class sublayers.
- Storey elevation, for ordering: `Elevation`, else the z of the storey's own
  relative placement, in metres; the read the spatial hierarchy uses
  (`data_model::extract_elevation_if_storey`).
- `class`: one layer per IFC class under the project root (`Project` when the
  file has no `IfcProject`).
- `presentation`: one layer per `IfcPresentationLayerAssignment` name
  (`MeshData.presentation_layer`), `No presentation layer` for the rest, all
  under the project root, alphabetical. Spaces go on a hidden `IfcSpace`
  sublayer of their presentation layer, so spaces are hidden in every scheme.

Layer names:

- Name, then LongName, then `<IfcType> #<express id>` when both are empty.
- Trim whitespace and U+200B (openNURBS trims both [ran]); replace `::` with
  `:` (rhino3dm accepted `A::B` as a root name whose `fullPath` collides with
  child `B` of `A` [ran]); drop control characters.
- A name starting with `(`, `)`, `[`, `]`, `{` or `}` gets a leading `_`:
  openNURBS 8.35 stores such a layer as `Layer <n>` instead [ran]. No printable
  ASCII first character was refused (`layers.add` never returned -1 for one).
- Duplicate sibling names, compared ignoring case, get ` #<express id>`
  appended (a layer with no express id, or a name still taken, gets ` (2)`,
  ` (3)`); the first keeps its spelling. openNURBS compares names ignoring case:
  it renamed a sibling `LEVEL 1` of `Level 1` to `LEVEL 1 03` and refused a
  sibling `ü` of `Ü` outright [ran], which is neither deterministic nor
  lossless. The scene folds upper then lower case, at least as much as
  openNURBS does.
- The spatial tree is walked iteratively with a visited set, so a file's
  nesting depth cannot overflow the stack; a 50,000-level storey chain builds
  [ran].

Layer colour: class sublayers use `default_color_for_type`, the one colour table
[src]; spatial layers use neutral grey. Objects carry their own colour, so the
layer colour only shows for `ByLayer` overrides a user applies later.

### Objects

- One Rhino mesh object per element per distinct colour: an element's emittable
  submeshes are merged when they share `color_key` and `material_name`. This keeps
  object counts close to element counts.
- An element that still yields more than one object gets a Rhino group named by
  its GlobalId (`#<express id>` when it has none). All its objects join it and all
  carry the full user text, so selecting any part shows the element's data.
- Group names are unique: openNURBS 8.35 refuses a repeated group name (the
  table does not grow, so the JS writer throws) and trims surrounding whitespace
  first [ran]. It accepts case variants [ran], but names are compared ignoring
  case like the other tables, which costs at most an unneeded suffix. A taken
  name gets ` #<express id>`, then ` (2)`, ` (3)`. Two grouped elements sharing
  a GlobalId (common in bad files) are the usual cause; one warning per export
  names the first.
- Object name: IFC `Name`, else the IFC class.
- Colour: `colorSource = ColorFromObject`, `objectColor` = element RGBA.
- Material: `materialSource = MaterialFromObject`, `materialIndex` into the
  material table.
- Normals: the pipeline's normals are written when `normals` is on. Without
  them Rhino computes its own on load [unproven]; turning them off saves about a
  quarter of the file.

### Materials

One material per distinct (`color_key`, `material_name`): `name` is the IFC
material/style name when present, else `IFC #RRGGBB`; a name already taken,
compared ignoring case as openNURBS does (the layer rule), gets the first free
` (2)`, ` (3)`, so a style literally named `X (2)` is never reused. A name starting with a bracket gets a
leading `_`, as layer names do: rhino3dm's `Material.name` setter blanks it
otherwise [ran]. `diffuseColor` = RGB, `transparency` =
`1 - alpha`. Plain `Material`, not PBR, in v1 (`toPhysicallyBased` works [ran],
but nothing in IFC colours needs it).

### Blocks (instancing)

When `gather` returns an instanced result, repeated mapped geometry becomes
Rhino blocks.

- One block definition per `template_express_id` that a written element
  instantiates. Its geometry is the template mesh translated by
  `-template.origin` (the pipeline's own positions) in output units, so
  definition coordinates are small and the base point is `(0, 0, 0)`.
- Each occurrence `k` is an instance object with
  `xform = S · W · rel_k · translate(template.origin) · S⁻¹`, where `rel_k` is
  `InstanceRecord.transform` (row-major, template-relative [src]), `S` the unit
  scale and `W` the frame restore under `world` (identity under `local`). The
  `S⁻¹` is there because block geometry is already in output units; with a
  uniform `S` it leaves the linear part alone and scales the translation.
- Occurrence colour: block geometry uses `ColorFromParent` /
  `MaterialFromParent`; the instance object carries the occurrence colour,
  material, layer and user text. An occurrence keeps the template's style name
  for its material only while its colour key equals the template's.
- **Invariant, pinned by a test:** every geometry-bearing element appears exactly
  once in the file, either as mesh objects or as one instance. The template
  element (the occurrence whose mesh the pipeline kept) becomes an instance of
  its own block with an identity `rel_k`, not a mesh plus a definition. This
  differs from USD, which writes the template element as a mesh beside an
  unrendered `class` prototype: in Rhino a definition is not drawn, so a mesh
  template would be a second copy of the geometry the user edits separately.
  Both rely on the same `scene_input` gate (exactly one emittable submesh per
  template, no occurrence that also owns a mesh). Hiding the template element
  drops its instance and keeps the block for the other occurrences.
- Block geometry lives on the top-level `IFC block geometry` layer, visible and
  locked. In Rhino a part inside a block obeys its own layer's visibility, so
  putting parts on a class layer would let hiding one storey's class layer blank
  out instances on other storeys [unproven, verify in Rhino].
- Block names: `<IfcType> <template express id>`, unique by construction.
  rhino3dm cannot rename a definition after creation [src].
- The adapter passes an attributes array of the same length as the geometry array
  to `instanceDefinitions().add`; rhino3dm indexes it before checking the
  count [src].
- Georeferenced site-local models disable instancing upstream [src]; they come out
  fully baked, which is correct, just larger.

### User text

Written to the object attributes (`ObjectAttributes.setUserString`), which is
what Rhino's Attribute User Text panel shows [unproven, verify in Rhino]. Keys are
`<group>::<name>` (`Pset_WallCommon::FireRating`), matching Rhino's layer path
separator. A reader splits at the first `::`. A pset or property name that itself
contains `::` has it replaced with `:`, the same rule as layer names, so the split
is never ambiguous.

| Key | Value | `properties` level |
|---|---|---|
| `IFC::GlobalId` | 22-char GlobalId | when the element has one |
| `IFC::Class` | e.g. `IfcWall` | always |
| `IFC::ExpressId` | STEP id | always |
| `IFC::Name`, `IFC::Description`, `IFC::ObjectType`, `IFC::Tag`, `IFC::PredefinedType` | attribute values | `attributes`, `all` |
| `IFC::Container`, `IFC::ContainerGlobalId` | spatial container | `attributes`, `all` |
| `IFC::Type`, `IFC::TypeGlobalId` | type object | `attributes`, `all` |
| `IFC::Material` | `material_name` | `attributes`, `all` |
| `IFC::PresentationLayer` | layer assignment | `attributes`, `all` |
| `<Pset>::<Property>` | property value | `all` |
| `<Qto>::<Quantity>` | quantity value | `all` |

- Properties come from the export data model with type sets inherited
  (`stream_export_model_with_inherited`); an occurrence value wins over its type's.
- Values: as the export data model renders them (numbers through its shared
  formatter; quantities through `fmt_num`); booleans `TRUE` / `FALSE`, logicals
  add `UNKNOWN`; null or empty values are omitted, never written as `""`. Lists
  and enumerations keep the data model's `, ` join: `EntityRow` carries the
  joined string, not the members, so re-joining with `; ` would mean splitting
  values that themselves contain `, `.
- Order: the `IFC::` keys, then the element's own property and quantity
  entries, then inherited ones, so an own entry claims a key first.
- An element's text is built once and copied onto each of its objects. Only
  `IFC::Material` differs between them (each part's material); its key stays
  taken on a part without a material, so the other keys never shift between
  parts of one element.
- Key collision (two sources producing the same key ignoring case, e.g. two
  property sets both named `Pset_X`, or `Pset_x`; openNURBS stores `IFC::Name`
  and `ifc::name` as one key, the later value winning [ran]) keeps the first and
  appends ` #2`, ` #3` to later ones,
  with one warning per export naming the first collision, not one per object.
- A key part loses control characters and leading `.`; an empty set or
  property name becomes `Pset` / `Property` / `Qto` / `Quantity`.
  A leading bracket stays: openNURBS stores `(k` and `[k` as written [ran].
- No length limit applies: a 5,000-character key and a 200,000-character value
  round-tripped [ran]. Keys starting with `.` are hidden in Rhino's panel; the
  scene never emits one.

### Document strings

`IFC::Schema`, `IFC::Project`, `IFC::ProjectGlobalId`, `IFC::SourceFileName` (from
the STEP `FILE_NAME` header), `IFC::SourceApplication` (header originating
system), `IFC::LengthUnit`, `IFC::Coordinates` (`local` / `world`),
`IFC::WorldFromModel` (only for a `local` export of a shifted model), the map-conversion keys above, and
`IFC::Exporter` = `ifc-lite <version>`.

### Object identity

rhino3dm.js cannot set an object id: `ObjectAttributes.id` is read-only and
throws on assignment [ran]. Python rhino3dm can set it; openNURBS keeps a set id
if it is unused and silently replaces a duplicate [ran]. So:

- v1 identity is `IFC::GlobalId` in user text, when the element has one (an
  empty value is omitted, like every other key). Otherwise `IFC::ExpressId` and
  `objectId` identify the object.
- The scene still carries `objectId` per object: the GlobalId expanded to its
  128-bit UUID (`ifc_lite_core::guid::decode_bits`), or for the 2nd..nth object
  of a grouped element (and for an element without a valid GlobalId) an RFC 9562
  version-8 UUID of `ifc_lite_core::guid::hash128("<GlobalId or #id>#<index>")`.
  Version 8, not 5: UUIDv5 means SHA-1, which the crate does not depend on, and
  a name-based id from another hash is what version 8 is for. Adapters that can set ids (Python, RhinoCommon) use it;
  the JS adapter ignores it.
- `objectId`s are unique across the scene, so an adapter that sets them never
  has a duplicate silently replaced. Elements go in express id order; an id
  already taken (a later element sharing a GlobalId) falls back to the version-8
  UUID of `hash128("#<express id>#<index>")`, under the same one warning as the
  group rename.
- File an upstream rhino3dm issue to make `id` writable in the JS binding. When
  that lands, the JS adapter sets it too and Rhino object ids become stable
  across exports.

## Adapters

### `@ifc-lite/rhino3dm` (TypeScript, phase 2)

New package, dependency `rhino3dm@8.35.0` (MIT [src]), loaded lazily with
`await rhino3dm({ locateFile })` so the 2.67 MB wasm (1.04 MB gzipped) [ran]
only downloads on a 3dm export.

```ts
export interface EncodedRhinoScene { manifest: string; blob: Uint8Array }
export const RHINO_3DM_VERSIONS = [8, 7] as const;
export type Rhino3dmVersion = (typeof RHINO_3DM_VERSIONS)[number];
export interface Write3dmOptions {
  version?: Rhino3dmVersion; // default 8
  onProgress?: (done: number, total: number) => void;
  locateFile?: (path: string, prefix: string) => string; // first initialization only
}
export interface Write3dmResult { bytes: Uint8Array; warnings: string[]; objectCount: number }
export function writeRhino3dm(scene: EncodedRhinoScene, opts?: Write3dmOptions): Promise<Write3dmResult>;
```

The encoded scene comes from the Rust producer: `build_rhino_scene(content, &opts)`
then `RhinoScene::encode()`, which returns the `(manifest, blob)` pair.

Contract:

- Refuses an unknown `format` / `version`.
- Builds layers, materials, groups, block definitions, then objects, in manifest
  order; reports progress per object.
- Uses `addPoint3d` for every vertex, `addTriFace` for faces, `normals().add` for
  normals.
- `.delete()`s every embind object it creates (rhino3dm returns raw pointers, so
  nothing is garbage collected [src]) and the `File3dm` after
  `toByteArrayOptions`.
- Imports the ESM build (`rhino3dm.module.js`); the package has no `exports`
  map, so the import path is pinned and covered by a test [src].

### Wasm binding

`exportRhinoScene(content: Uint8Array, optionsJson: string): RhinoSceneJs` lives in
its own crate, `rust/rhino-wasm`, built to the separate `@ifc-lite/wasm/rhino`
payload (`packages/wasm/pkg-rhino`) like `@ifc-lite/wasm/diff`. The default
engine never carries the scene builder, so the .3dm exporter does not grow the
download every viewer load pays for. `@ifc-lite/geometry`'s
`exportRhinoScene(content, options): Promise<{ manifest: string; blob: Uint8Array }>`
imports and initializes that payload on first use (reading the bytes from the
installed package under Node) and keeps the `NO_RENDER_GEOMETRY` refusal.

### Python (phase 4)

`ifclite_geom.rhino_scene(ifc_bytes, **options) -> dict` returning `manifest`
(str) and `blob` (bytes), plus a documented ~100-line writer using PyPI
`rhino3dm` (wheels cp39 to cp314, Windows, macOS universal2, Linux x86_64 and
aarch64 [src]). Python writes straight to a path (`File3dm.Write(path, version)`)
and sets object ids. This is also the route for models too big for wasm.

## Surfaces

| Surface | Change |
|---|---|
| Rust | `ifc_lite_export::rhino::{build_rhino_scene, RhinoSceneOptions, RhinoScene}`; shared `scene_input` lifted from `usd/` |
| Wasm | `exportRhinoScene` in the separate `@ifc-lite/wasm/rhino` payload (`rust/rhino-wasm`) |
| CLI | `ifc-lite export model.ifc --format 3dm --out model.3dm [flags above]` in `export-rust-formats.ts`, count check via read-back object count |
| MCP | `export_3dm` tool, same options |
| Viewer | Export menu and command palette `export:3dm`; dialog with units, layer scheme, instancing, properties, visible-only; source resolution reuses `step-export-source.ts` (`isStepSourceModel`, `resolveStepExportBytes`) so pending edits are exported; the write runs in a Web Worker |
| Docs | this page, a guide section, CLI help |

## Performance and limits

Measured with rhino3dm.js 8.35.0 in Node 22, Apple silicon, grid meshes with
shared vertices [ran]:

| Vertices | Objects | Vertex mode | Output | `toByteArray` |
|---|---|---|---|---|
| 1.21 M | 400 | float (`add`) | 34.7 MB | 20.1 s |
| 1.21 M | 400 | double (`addPoint3d`) | 36.3 MB | 5.0 s |
| 1.21 M | 400 | double + normals | 49.7 MB | 4.2 s |
| 1.20 M | 3,000 | double | 37.6 MB | 2.7 s |
| 4.84 M | 1,600 | double | 145.3 MB | 14.8 s |

- Double vertices serialize at about 10 MB/s and scale linearly; float vertices
  are about 4× slower. Building the meshes through embind is cheap (under 0.7 s
  for 4.8 M vertices).
- Each row is a single run. Archive 7 took 3.7 s against 5.0 s for archive 8,
  and the normals row beating the plain row is noise; repeat before quoting
  anything finer than the float/double gap.
- The wasm32 build caps the heap at 2 GB, and `toByteArray` grows its buffer by
  doubling inside that heap before copying to JS [src]. The practical ceiling is
  therefore well under 1 GB of output [unproven]. Phase 2 measures it and sets
  `maxOutputBytes` from the measurement. The scene build projects the output size
  first (24 B/vertex + 12 B/normal + 12 B/triangle + overhead) and refuses above
  the ceiling with a message that names the CLI's Python route. Not in phase 1:
  the ceiling is unmeasured, so the projection and refusal land with phase 2.
- rhino3dm 9 (unpublished) moves to wasm64 by default, which needs Chrome 133+,
  Firefox 134+ or Node 24+, and Safari only in Technology Preview [src]. Pin 8.x
  until Safari ships wasm64.
- `rust/export` is not on the perf-sensitive list; the wasm binding adds one
  function to `packages/wasm`. The PR carries a bundle check that rhino3dm is
  not in the viewer's initial chunk.

## Determinism

The scene is deterministic: same input and options give byte-identical manifest
and blob. Ordering: layers in tree order (storeys by elevation, then express
id; class sublayers alphabetical), materials by colour key then name, objects
and blocks by express id.

The `.3dm` bytes are not deterministic: openNURBS generates random GUIDs for
layers, materials and objects (from `/dev/urandom` in wasm [ran]) and stores
timestamps. Golden tests therefore pin the scene, and pin the `.3dm` through a
read-back digest, never its bytes.

## Testing

Rust (`rust/export/tests/rhino_scene.rs`, existing fixtures):

- Scene golden: manifest JSON + blob hash pinned, repinned with `IFC_LITE_REPIN_GOLDEN=1`.
- Every index in range, layers parent-first, sibling names unique, all values finite.
- Units: mm, m and ft fixtures produce the right `unitSystem`, scale and tolerance.
- Frame: a georeferenced fixture (large coordinates) gives small `local`
  coordinates plus `IFC::WorldFromModel`; `world` reproduces the IFC world
  coordinates to 1e-6 m.
- Instancing: the exactly-once invariant (geometry-bearing ids in the scene equal
  those in the baked pass); instance world vertices match baked vertices to
  1e-6 m plus 4 f32 ulps of the coordinate. Both sides come from f32 pipeline
  data (the occurrence transform, the baked positions), so 1e-6 m flat is not
  reachable on real models: the worst measured gap is 1.43e-6 m (duplex).
- Layer names: `::`, empty names, duplicate siblings.
- User text: psets, inherited type psets with occurrence override, quantity keys,
  collisions, omitted nulls.
- `NoRenderGeometry` for a model with no products.
- USD output byte-identical after the `scene_input` lift.

TS (`packages/rhino3dm`):

- Round trip: write each fixture with rhino3dm.js, read it back with
  `File3dm.fromByteArray`, compare against the scene: object count per layer,
  layer full paths, user strings, materials, block and instance counts, bounding
  box. The read-back digest is pinned.
- Double precision: a vertex at 2,600,000.123 m survives the round trip.
- No leak: three consecutive exports leave the wasm heap size flat.
- CLI and MCP tests mirror the USD ones, including the empty-model refusal.

Acceptance (the evidence the PR shows, per AGENTS.md): exports of three real
models (one Revit, one ARCHICAD, one MEP-heavy) opened in Rhino 8 on Windows and
on Mac, with screenshots of the layer panel, the Attribute User Text panel on a
selected wall, a block instance, and the document user text; plus export timings.
Every [unproven] item above gets checked in that session.

## Delivery

One issue, stacked PRs, each under about 1,500 lines:

1. **Rust scene**: `scene_input` lift (USD unchanged), `rhino` module, tests.
2. **Adapter + CLI + MCP**: wasm binding, `@ifc-lite/rhino3dm`, round-trip tests,
   measured size ceiling, Rhino acceptance screenshots.
3. **Viewer**: dialog, palette command, worker, bundle check.
4. **Python**: `rhino_scene` binding and the documented writer.

## Later phases

- Curves: element axes, `IfcGrid` lines, swept-disk directrices
  (`include_directrices` already exists), as `PolylineCurve` on their own layers.
- Exact solids: `extrusion_definitions` (exact profiles and placements) as
  Rhino `Extrusion` objects, so walls and columns arrive editable.
- Textures from `MeshData.uvs` / `texture`.
- Federation: one root layer per model.
- A RhinoCommon adapter in a Rhino plugin, fed by the same scene through the FFI.
- Import direction (`.3dm` → IFC) using the GlobalId user text to match objects.

## Decisions

Settled by the maintainer on 2026-11-08:

| Decision | Choice |
|---|---|
| Default units | `source`: the IFC project length unit, metres as fallback |
| User-text key separator | `::` (`Pset_WallCommon::FireRating`) |
| Instancing default | on; `--no-instancing` turns it off |
| Package | new `@ifc-lite/rhino3dm` |
| Spaces | emitted on a hidden `IfcSpace` sublayer |
| Default layer scheme | `spatial-class` |
| Default coordinates | `local`: the pipeline's shifted frame, shift recorded in document strings and the earth anchor |
