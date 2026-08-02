# Rust API Reference

API documentation for the Rust crates.

> **Note**: For the crates published to crates.io, full generated rustdoc with source links lives on docs.rs (linked per crate below). Locally, `cargo doc --open` builds the same documentation for the whole workspace.

## Workspace

All crates live in one Cargo workspace (versioned together, MPL-2.0 licensed):

| Crate | Path | Rustdoc | Description |
|-------|------|---------|-------------|
| `ifc-lite-core` | `rust/core` | [docs.rs](https://docs.rs/ifc-lite-core) | High-performance IFC/STEP parser for building data |
| `ifc-lite-geometry` | `rust/geometry` | [docs.rs](https://docs.rs/ifc-lite-geometry) | Geometry processing and mesh generation for IFC models |
| `ifc-lite-processing` | `rust/processing` | [docs.rs](https://docs.rs/ifc-lite-processing) | Shared IFC processing pipeline and types used by server and FFI |
| `ifc-lite-export` | `rust/export` | local `cargo doc` | Domain-format exporters (HBJSON, OBJ, glTF/GLB, CSV, JSON, JSON-LD, STEP/IFC, IFC5/IFCX, Merged, Parquet/.bos) |
| `ifc-lite-clash` | `rust/clash` | [docs.rs](https://docs.rs/ifc-lite-clash) | High-performance geometry kernel for IFC clash detection |
| `ifc-lite-ffi` | `rust/ffi` | [docs.rs](https://docs.rs/ifc-lite-ffi) | C FFI bindings: native cdylib for in-process IFC parsing |
| `ifc-lite-wasm` | `rust/wasm-bindings` | [docs.rs](https://docs.rs/ifc-lite-wasm) | WebAssembly bindings for IFC-Lite |

The Python bindings (`rust/python`, PyPI package `ifclite-geom`) are excluded from the workspace and documented on the [Python API page](python.md).

## ifc-lite-core

Core parsing functionality.

### Modules

```rust
pub mod parser;          // STEP tokenization and entity scanning
pub mod decoder;         // Lazy entity decoding + entity index
pub mod generated;       // Generated IFC type enumeration (IfcType)
pub mod schema_gen;      // Decoded attribute values and entities
pub mod streaming;       // Streaming parse events
pub mod fast_parse;      // Fast single-purpose extraction helpers
pub mod georef;          // Georeferencing extraction
pub mod legacy_entities; // IFC2X3 legacy entity handling
pub mod model_bounds;    // Model/placement bounds scanning
pub mod project_units;   // Project unit resolution
pub mod step_encoding;   // STEP string encode/decode
pub mod units;           // Unit conversion helpers
pub mod error;           // Error types
```

### Parser Module

#### Token

```rust
/// STEP token types
#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    /// Entity reference: #123
    EntityRef(u32),
    /// String literal: 'text'
    String(&'a [u8]),
    /// Integer: 42
    Integer(i64),
    /// Float: 3.14
    Float(f64),
    /// Enum: .TRUE., .FALSE., .UNKNOWN.
    Enum(&'a [u8]),
    /// List: (1, 2, 3)
    List(Vec<Token<'a>>),
    /// Typed value: IFCPARAMETERVALUE(0.), IFCBOOLEAN(.T.)
    TypedValue(&'a [u8], Vec<Token<'a>>),
    /// Null value: $
    Null,
    /// Asterisk (derived value): *
    Derived,
}
```

#### EntityScanner

```rust
/// Scans IFC file for entity locations
pub struct EntityScanner<'a> {
    // ...
}

impl<'a> EntityScanner<'a> {
    /// Create a scanner over the file bytes
    pub fn new<T>(content: &'a T) -> Self;

    /// Create a scanner starting at a byte position.
    ///
    /// Preconditions: `position` is a GLOBAL byte offset into `content` (the
    /// returned entity spans are absolute, not shard-relative), and it must sit
    /// at a known entity boundary — typically the byte right after a `;\n`
    /// terminator, not inside the HEADER section or partway through an entity.
    /// `new_at` does NOT auto-skip the STEP header; that is the caller's
    /// responsibility (used by the sharded-scan pre-pass). Starting mid-header
    /// or mid-entity yields incorrect spans. The offset is clamped to the buffer
    /// length.
    pub fn new_at<T>(content: &'a T, position: usize) -> Self;

    /// Advance to the next entity: (express_id, type_name, start, end)
    pub fn next_entity(&mut self) -> Option<(u32, &'a str, usize, usize)>;
}
```

#### parse_entity / entity_count

```rust
/// Parse a single entity definition into (express_id, type, attribute tokens)
pub fn parse_entity<'a, T>(input: &'a T) -> Result<(u32, IfcType, Vec<Token<'a>>)>;

/// Cheap O(scan), O(1)-memory entity tally (no index allocation)
pub fn entity_count<T>(content: &T) -> usize;
```

### Generated Schema Module

#### IfcType

```rust
/// IFC entity types: all 876 entity types from the IFC4X3 schema,
/// plus Unknown(u32) storing a CRC32 hash of unrecognized names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IfcType {
    IfcBoxedHalfSpace,
    IfcBridge,
    IfcBuilding,
    IfcBuildingStorey,
    // ... 876 variants ...
    /// Unknown/unrecognized IFC type (stores CRC32 hash)
    Unknown(u32),
}

impl IfcType {
    /// Parse from an (upper-case) type name
    pub fn from_str(s: &str) -> Self;

    /// Parse from the stable numeric type id
    pub fn from_id(id: u32) -> Self;

    /// Stable numeric type id
    pub fn id(&self) -> u32;

    /// Type name (SCREAMING case as written in STEP)
    pub fn as_str(&self) -> &'static str;

    /// Type name (CamelCase)
    pub fn name(&self) -> &'static str;

    /// Direct supertype in the schema hierarchy
    pub fn parent(&self) -> Option<Self>;

    /// Walk the hierarchy: is self a subtype of parent?
    pub fn is_subtype_of(&self, parent: Self) -> bool;

    /// Whether the entity is abstract in the schema
    pub fn is_abstract(&self) -> bool;
}
```

#### has_geometry_by_name

```rust
/// Check if entity type typically has geometry (cached, name-based)
pub fn has_geometry_by_name(type_name: &str) -> bool;
```

### Decoder Module

#### EntityIndex / build_entity_index

```rust
/// Index of entity byte ranges in the file: express_id -> (start, end)
pub type EntityIndex = FxHashMap<u32, (usize, usize)>;

/// Build the index in one scan over the file bytes
pub fn build_entity_index<T>(content: &T) -> EntityIndex;
```

#### ColumnarEntityIndex (wasm workers)

Wasm geometry workers keep the shared entity index as sorted `u32` columns
(`ids` / `starts` / `lengths`) and look up by `binary_search` instead of
materializing a per-worker `FxHashMap` (#1682). Native / server paths still
use `EntityIndex`.

```rust
pub struct ColumnarEntityIndex { /* ids, starts, lengths */ }

impl ColumnarEntityIndex {
    pub fn from_columns(ids: &[u32], starts: &[u32], lengths: &[u32]) -> Self;
    pub fn from_scan<T>(content: &T) -> Self;
    pub fn from_hashmap(map: &EntityIndex) -> Self;
    pub fn from_hashmap_consuming(map: EntityIndex) -> Self;
    pub fn lookup(&self, id: u32) -> Option<(usize, usize)>;
}
```

#### EntityDecoder

```rust
/// Entity decoder for lazy parsing from raw IFC bytes,
/// with per-decoder caches (decoded entities, points, placements, units).
pub struct EntityDecoder<'a> {
    // ...
}

impl<'a> EntityDecoder<'a> {
    /// Create decoder over the file bytes (index built lazily)
    pub fn new<T>(content: &'a T) -> Self;

    /// Create decoder with a pre-built index
    pub fn with_index<T>(content: &'a T, index: EntityIndex) -> Self;
    pub fn with_arc_index<T>(content: &'a T, index: Arc<EntityIndex>) -> Self;
    /// Wasm path: attach a shared columnar index (binary-search lookup)
    pub fn with_arc_columnar_index<T>(content: &'a T, index: Arc<ColumnarEntityIndex>) -> Self;

    /// Decode an entity by express id (cached)
    pub fn decode_by_id(&mut self, entity_id: u32) -> Result<DecodedEntity>;

    /// Decode an entity by byte range
    pub fn decode_at(&mut self, start: usize, end: usize) -> Result<DecodedEntity>;

    /// Length-unit scale of the file (metres per file unit), cached
    pub fn length_unit_scale(&mut self) -> f64;
}
```

The decoder also exposes fast single-purpose accessors used by the geometry pipeline (`get_cartesian_point_fast`, `get_polyloop_coords_cached`, `get_entity_ref_list_fast`, ...); see `rust/core/src/decoder.rs`.

### Streaming Module

#### ParseEvent

```rust
/// Events emitted during streaming parse
#[derive(Debug)]
pub enum ParseEvent {
    /// Parsing started
    Started { file_size: usize, timestamp: f64 },
    /// Entity discovered during scanning
    EntityScanned { id: u32, ifc_type: IfcType, position: usize },
    /// Geometry processing completed for an entity
    GeometryReady { id: u32, vertex_count: usize, triangle_count: usize },
    /// Progress update
    Progress {
        phase: String,
        percent: f32,
        entities_processed: usize,
        total_entities: usize,
    },
    /// Parsing completed
    Completed { duration_ms: f64, entity_count: usize, triangle_count: usize },
    /// Error (non-fatal)
    Error { message: String, position: Option<usize> },
}
```

#### StreamConfig

```rust
/// Streaming parser configuration
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// Yield progress events every N entities
    pub progress_interval: usize,
    /// Skip these entity types during scanning
    pub skip_types: Vec<IfcType>,
    /// Only process these entity types (if specified)
    pub only_types: Option<Vec<IfcType>>,
}
// Default: progress_interval = 100; skip_types = owner history,
// person, organization, application; only_types = None.
```

#### parse_stream

```rust
/// Stream IFC file parsing with events (async Stream)
pub fn parse_stream<T>(
    content: &T,
    config: StreamConfig,
) -> Pin<Box<dyn Stream<Item = ParseEvent> + '_>>;
```

### Schema Gen Module

#### AttributeValue

```rust
/// Decoded attribute value
#[derive(Debug, Clone)]
pub enum AttributeValue {
    EntityRef(u32),
    String(String),
    Integer(i64),
    Float(f64),
    Enum(String),
    List(Vec<AttributeValue>),
    Null,
    Derived,
}

impl AttributeValue {
    pub fn from_token(token: &Token) -> Self;
    pub fn as_entity_ref(&self) -> Option<u32>;
    pub fn as_string(&self) -> Option<&str>;
    pub fn as_enum(&self) -> Option<&str>;
    pub fn as_float(&self) -> Option<f64>;
    pub fn as_int(&self) -> Option<i64>;
    pub fn as_list(&self) -> Option<&[AttributeValue]>;
}
```

#### DecodedEntity

```rust
/// Fully decoded entity
#[derive(Debug)]
pub struct DecodedEntity {
    pub id: u32,
    pub ifc_type: IfcType,
    pub attributes: std::sync::Arc<Vec<AttributeValue>>,
}
```

### Error Module

```rust
/// Parser error type
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Parse error at position {position}: {message}")]
    ParseError { position: usize, message: String },

    #[error("Invalid entity reference: #{0}")]
    InvalidEntityRef(u32),

    #[error("Invalid IFC type: {0}")]
    InvalidIfcType(String),

    #[error("Unexpected token at position {position}: expected {expected}, got {got}")]
    UnexpectedToken { position: usize, expected: String, got: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("UTF-8 error: {0}")]
    Utf8(#[from] std::str::Utf8Error),
}

pub type Result<T> = std::result::Result<T, Error>;
```

---

## ifc-lite-geometry

Geometry processing and mesh generation. CSG (void cutting, boolean clipping) runs on the in-tree pure-Rust exact mesh-arrangement kernel (`src/kernel/`) on every target, native and wasm32 alike.

### Features

```toml
default = []          # no optional features
debug_geometry = []   # extra geometry debugging output
csg_capture = []      # measurement-only CSG corpus capture for benches
observability = []    # route diagnostics through `tracing` instead of eprintln
```

### Key Types (crate-root re-exports)

Most modules are crate-private; consumers use the re-exports from `ifc_lite_geometry::*`.

#### Mesh

```rust
/// Triangle mesh representation
#[derive(Debug, Clone)]
pub struct Mesh {
    /// Vertex positions (x, y, z)
    pub positions: Vec<f32>,
    /// Vertex normals (nx, ny, nz)
    pub normals: Vec<f32>,
    /// Triangle indices (i0, i1, i2)
    pub indices: Vec<u32>,
    /// Whether the RTC offset has already been subtracted from positions
    pub rtc_applied: bool,
    /// Per-mesh local origin (f64) in the RTC/world frame; when non-zero,
    /// positions are stored relative to it for f32 precision
    pub origin: [f64; 3],
    /// Instancing side-channel; None on the flat path
    pub instance_meta: Option<InstanceMeta>,
    // ...
}

impl Mesh {
    pub fn vertex_count(&self) -> usize;
    pub fn triangle_count(&self) -> usize;
    /// Axis-aligned bounds of positions
    pub fn bounds(&self) -> (Point3<f32>, Point3<f32>);
}
```

Related mesh types: `SubMesh`, `SubMeshCollection`, `InstanceMeta`.

#### Profiles and extrusion

```rust
pub use profile::{Profile2D, Profile2DWithVoids, ProfileType, VoidInfo};
pub use profile_extractor::{extract_profiles, ExtractedProfile};
pub use extrusion::{extrude_profile, extrude_profile_lofted, extrude_profile_with_voids};
```

#### GeometryRouter and processors

```rust
/// Trait for geometry processors
pub trait GeometryProcessor {
    /// Process entity into mesh. `quality` selects tessellation detail.
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh>;

    /// Get supported IFC types
    fn supported_types(&self) -> Vec<IfcType>;
}

/// Routes an entity to the processor registered for its IfcType
pub struct GeometryRouter {
    // ...
}
```

Built-in processors (all re-exported at the crate root): `ExtrudedAreaSolidProcessor`, `ExtrudedAreaSolidTaperedProcessor`, `FacetedBrepProcessor`, `AdvancedBrepProcessor`, `BooleanClippingProcessor`, `FaceBasedSurfaceModelProcessor`, `PolygonalFaceSetProcessor`, `RevolvedAreaSolidProcessor`, `SurfaceOfLinearExtrusionProcessor`, `SweptDiskSolidProcessor`, `TriangulatedFaceSetProcessor`.

Other notable re-exports: `orient_mesh_outward`, `calculate_normals`, `ClippingProcessor`, `Plane`, `Triangle` (CSG), `hash_mesh_world` / `GeometryHasher` (geometry-diff hashing), instancing encode/decode helpers, and the nalgebra types `Point2`, `Point3`, `Vector2`, `Vector3`.

---

## ifc-lite-processing

Shared processing pipeline used by the native server, the FFI DLL, the Python bindings, and the WASM bindings. Parallelised with rayon on native targets.

Key re-exports:

```rust
// One-call pipeline: IFC bytes -> per-element meshes
pub use processor::{
    process_geometry, process_geometry_filtered, process_geometry_with_index,
    process_geometry_streaming, /* ...streaming variants with options... */
    OpeningFilterMode, ProcessingResult, StreamingOptions,
};

// Analysis-ready export document (welded, Z-up, world metres)
pub use geometry_export::{build_geometry_data_export, ExportedElement, GeometryDataExport};

pub use georeferencing::{extract_georeferencing, Georeferencing};
pub use ifc_lite_geometry::TessellationQuality;
pub use style::{default_color_for_type, Rgba};
pub use types::mesh::{InstanceRecord, MeshData, RawInstanceOccurrence};
pub use types::response::{CoordinateInfo, ModelMetadata, ParseResponse, ProcessingStats};
pub use parallel_scan::build_entity_index_parallel;
```

---

## ifc-lite-export

Domain-format exporters. Every exporter takes IFC bytes (or already-produced meshes) and returns the serialized output.

```rust
pub use csv::{export_csv, CsvMode, CsvOptions};
pub use gltf::{export_glb, export_glb_from_meshes, export_glb_with_stats,
               export_gltf_streaming, try_export_glb, GltfOptions, GltfStats /* ... */};
pub use hbjson::Model;
pub use ifc5::{export_ifc5, Ifc5Options};
pub use json::{export_json, JsonOptions};
pub use jsonld::{export_jsonld, JsonLdOptions};
pub use kmz::{export_kmz, ifc_angle_to_kml_heading, KmzOptions};
pub use merged::{export_merged, export_merged_with_stats, MergedOptions, MergedStats};
pub use obj::{export_obj, export_obj_with_stats, ObjOptions, ObjStats};
pub use step::{export_step, export_step_json, export_step_with_stats,
               AttrMutation, PropMutation, StepOptions, StepStats};
pub use model::{build_export_model, stream_export_model, ExportModel /* ... */};

// Behind the `parquet-bos` feature (native only; kept out of the wasm bundle):
pub use parquet_bos::{export_bos, ParquetBosOptions};
```

### Features

```toml
default = []
parquet-bos = []      # Parquet/.bos export (arrow + parquet + zip; not wasm32-safe)
observability = []    # surface faceted-brep phase timing for profiling examples
```

---

## ifc-lite-clash

Native clash-detection kernel: a faithful port of the TypeScript reference engine in `packages/clash` (same AABB math, SAT triangle-triangle intersection, minimum-distance routines, per-element triangle BVHs, and narrow-phase classification). All computation in `f64` over `f32` input buffers.

```rust
pub use aabb::Aabb;
pub use narrow::ClashStatus;
pub use session::{ClashRecord, ClashSession, RuleResult};
```

```rust
use ifc_lite_clash::ClashSession;

let mut session = ClashSession::new();
// positions: concatenated per-element vertex coords (x, y, z, ...)
// pos_ranges: [float_offset, float_len] per element
// indices: concatenated per-element LOCAL triangle indices
// idx_ranges: [idx_offset, idx_len] per element
// aabbs: [minx, miny, minz, maxx, maxy, maxz] per element
session.ingest(&[], &[], &[], &[], &[]);
let result = session.run_rule(&[], &[], 0, 0.0, 0.0, false);
```

---

## ifc-lite-ffi

C FFI bindings: a native cdylib for in-process IFC parsing (used by desktop-style hosts). By default it routes allocations through mimalloc (`default = ["mimalloc"]`; opt out with `--no-default-features`).

```rust
/// Parse an IFC file at `path` and write a serialized result buffer
pub unsafe extern "C" fn ifc_lite_parse(
    path_ptr: *const u8, path_len: usize,
    out_ptr: *mut *mut u8, out_len: *mut usize,
) -> i32;

/// Same, with an explicit opening-filter mode
/// (`opening_filter_mode`: 0 = Default, 1 = IgnoreAll, 2 = IgnoreOpaque)
pub unsafe extern "C" fn ifc_lite_parse_ex(
    path_ptr: *const u8, path_len: usize,
    opening_filter_mode: i32,
    out_ptr: *mut *mut u8, out_len: *mut usize,
) -> i32;

/// Free a buffer returned by the parse calls
pub unsafe extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize);
```

**FFI contract.** These entry points are `unsafe` and cross a C boundary, so the
caller owns the following guarantees:

- **Inputs.** `path_ptr` / `path_len` describe a UTF-8 file path (need not be
  NUL-terminated). `out_ptr` and `out_len` must be non-null and valid for
  writes. A null pointer or non-UTF-8 path returns `1` and writes nothing.
- **Success (`0`).** `*out_ptr` receives a heap buffer of `*out_len` serialized
  JSON bytes. The buffer is owned by the caller from that point on.
- **Failure.** Non-zero return codes leave the out-parameters untouched (no
  buffer is allocated, so there is nothing to free): `1` null pointer or invalid
  path, `2` file could not be read, `3` geometry processing panicked, `4` JSON
  serialization failed.
- **Freeing.** Pass the exact `ptr` and `len` you received from a successful
  parse to `ifc_lite_free` **exactly once**. Do not free on a non-zero return,
  do not free twice, and do not mix in a pointer/length from any other source.
  `ifc_lite_free` is a no-op when `ptr` is null or `len` is `0`.

---

## ifc-lite-wasm

WebAssembly bindings.

### IfcAPI

The WASM surface is split across `rust/wasm-bindings/src/api/*.rs`; every method
is exported to JS under a camelCase `js_name` that mirrors `pkg/ifc-lite.d.ts`.
The methods below are representative, not exhaustive; see the
[WASM API page](wasm.md) for the full JS-side surface.

```rust
/// Main IFC-Lite API
#[wasm_bindgen]
pub struct IfcAPI {
    // ...
}

#[wasm_bindgen]
impl IfcAPI {
    /// Create and initialize the IFC API
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self;

    /// Fast SIMD entity scan; returns entity references for the data model
    #[wasm_bindgen(js_name = scanEntitiesFast)]
    pub fn scan_entities_fast(&self, content: &str) -> JsValue;

    /// Streaming geometry pre-pass; emits progress via `on_event`
    #[wasm_bindgen(js_name = buildPrePassStreaming)]
    pub fn build_pre_pass_streaming(
        &self,
        data: &[u8],
        on_event: &js_sys::Function,
        chunk_size: u32,
        disabled_type_names: Option<Vec<String>>,
        skip_type_geometry: bool,
    ) -> Result<JsValue, JsValue>;

    /// Mesh one batch of geometry jobs into a MeshCollection
    #[wasm_bindgen(js_name = processGeometryBatch)]
    pub fn process_geometry_batch(
        &self,
        data: &[u8],
        jobs_flat: &[u32],
        unit_scale: f64,
        // ... RTC offset, void keys, styles, material colours
    ) -> MeshCollection;

    /// Extract 2D profiles (outer boundary + holes) for parametric geometry
    #[wasm_bindgen(js_name = extractProfiles)]
    pub fn extract_profiles(&self, content: String, model_index: u32) -> ProfileCollection;

    /// Export glTF binary (GLB) from the model
    #[wasm_bindgen(js_name = exportGlb)]
    pub fn export_glb(
        &self,
        content: &[u8],
        include_metadata: bool,
        hidden: &[u32],
        isolated: &[u32],
        hidden_types_csv: String,
        lit: Option<bool>,
    ) -> Result<Vec<u8>, JsValue>;

    /// Export CSV (entities / properties / quantities / spatial)
    #[wasm_bindgen(js_name = exportCsv)]
    pub fn export_csv(
        &self,
        content: &[u8],
        mode: String,
        delimiter: String,
        include_properties: bool,
    ) -> Vec<u8>;
}
```

### Features

```toml
default = ["console_error_panic_hook"]
threads = []          # threaded bundle via wasm-bindgen-rayon (built separately)
console-tracing = []  # forward structured diagnostics to the DevTools console
debug_geometry = []   # forwards to ifc-lite-geometry/debug_geometry
```

---

## Building Documentation

Generate full Rustdoc documentation:

```bash
cargo doc --no-deps --document-private-items --open
```

This will generate detailed documentation including:

- All public and private items
- Source code links
- Examples from doc comments
- Cross-references between items
