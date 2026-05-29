# Rust API Reference

Complete API documentation for the Rust crates.

> **Note**: Full API documentation with source links is available via `cargo doc --open`

## ifc-lite-core

Core parsing functionality.

### Modules

```rust
pub mod parser;      // STEP tokenization
pub mod schema;      // IFC type definitions
pub mod decoder;     // Entity decoding
pub mod streaming;   // Streaming parser
pub mod schema_gen;  // Generated schema
pub mod error;       // Error types
```

### Parser Module

#### Token

```rust
/// STEP token types
#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    /// Entity reference (#123)
    EntityRef(u32),
    /// Keyword (IFCWALL)
    Keyword(&'a [u8]),
    /// String literal ('text')
    String(&'a [u8]),
    /// Integer value
    Integer(i64),
    /// Floating point value
    Float(f64),
    /// Enumeration (.ENUM.)
    Enum(&'a [u8]),
    /// Binary data ("0A1B2C")
    Binary(&'a [u8]),
    /// Undefined value (*)
    Asterisk,
    /// Null/omitted ($)
    Dollar,
    /// Punctuation
    OpenParen,
    CloseParen,
    Comma,
    Semicolon,
    Equals,
}
```

#### EntityScanner

```rust
/// Scans IFC file for entity locations
pub struct EntityScanner {
    // ...
}

impl EntityScanner {
    /// Create new scanner
    pub fn new() -> Self;

    /// Scan buffer for entities
    pub fn scan(&mut self, input: &[u8]) -> Result<EntityIndex>;
}
```

#### parse_entity

```rust
/// Parse a single entity definition
pub fn parse_entity(input: &[u8]) -> Result<(u32, &[u8], Vec<Token>)>;
```

### Schema Module

#### IfcType

```rust
/// IFC entity type enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum IfcType {
    Unknown = 0,
    IfcProject = 1,
    IfcSite = 2,
    IfcBuilding = 3,
    IfcBuildingStorey = 4,
    IfcSpace = 5,
    IfcWall = 6,
    IfcWallStandardCase = 7,
    IfcDoor = 8,
    IfcWindow = 9,
    // ... ~50 common types
}

impl IfcType {
    /// Parse from type name
    pub fn from_name(name: &[u8]) -> Self;

    /// Get type name
    pub fn name(&self) -> &'static str;

    /// Check if type has geometry
    pub fn has_geometry(&self) -> bool;
}
```

#### has_geometry_by_name

```rust
/// Check if entity type typically has geometry
pub fn has_geometry_by_name(type_name: &str) -> bool;
```

### Decoder Module

#### EntityDecoder

```rust
/// Decodes entity attributes from raw bytes
pub struct EntityDecoder<'a> {
    input: &'a [u8],
    index: &'a EntityIndex,
}

impl<'a> EntityDecoder<'a> {
    /// Create decoder with input buffer and index
    pub fn new(input: &'a [u8], index: &'a EntityIndex) -> Self;

    /// Decode entity by express ID
    pub fn decode(&self, express_id: u32) -> Result<DecodedEntity>;

    /// Decode entity attributes only
    pub fn decode_attributes(&self, express_id: u32) -> Result<Vec<AttributeValue>>;
}
```

#### EntityIndex

```rust
/// Index of entity locations in file
pub struct EntityIndex {
    locations: HashMap<u32, EntityLocation>,
    ordered_ids: Vec<u32>,
}

impl EntityIndex {
    /// Get entity count
    pub fn len(&self) -> usize;

    /// Get entity location
    pub fn get(&self, express_id: u32) -> Option<&EntityLocation>;

    /// Iterate over entities
    pub fn iter(&self) -> impl Iterator<Item = (u32, &EntityLocation)>;
}
```

#### EntityLocation

```rust
/// Location of entity in file
#[derive(Debug, Clone)]
pub struct EntityLocation {
    pub express_id: u32,
    pub offset: usize,
    pub length: usize,
    pub ifc_type: IfcType,
}
```

### Streaming Module

#### ParseEvent

```rust
/// Events emitted during streaming parse
#[derive(Debug)]
pub enum ParseEvent {
    /// Header parsed
    Header(HeaderInfo),
    /// Entity found
    Entity {
        express_id: u32,
        type_name: String,
        offset: usize,
    },
    /// Progress update
    Progress {
        bytes_read: usize,
        total_bytes: usize,
        percent: f32,
    },
    /// Parse complete
    Complete,
    /// Error (non-fatal)
    Error(ParseError),
}
```

#### StreamConfig

```rust
/// Configuration for streaming parser
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// Chunk size in bytes
    pub chunk_size: usize,
    /// Report progress every N entities
    pub progress_interval: usize,
    /// Continue on non-fatal errors
    pub ignore_errors: bool,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            chunk_size: 1024 * 1024, // 1 MB
            progress_interval: 100,
            ignore_errors: true,
        }
    }
}
```

#### parse_stream

```rust
/// Stream parse an IFC file
pub fn parse_stream<'a>(
    input: &'a [u8],
    config: StreamConfig,
) -> impl Iterator<Item = ParseEvent> + 'a;
```

### Schema Gen Module

#### AttributeValue

```rust
/// Decoded attribute value
#[derive(Debug, Clone)]
pub enum AttributeValue {
    Null,
    Integer(i64),
    Float(f64),
    String(String),
    Boolean(bool),
    Enum(String),
    EntityRef(u32),
    List(Vec<AttributeValue>),
    Derived,
}

impl AttributeValue {
    /// Get as integer
    pub fn as_int(&self) -> Option<i64>;

    /// Get as float
    pub fn as_float(&self) -> Option<f64>;

    /// Get as string
    pub fn as_str(&self) -> Option<&str>;

    /// Get as entity reference
    pub fn as_ref(&self) -> Option<u32>;

    /// Get as list
    pub fn as_list(&self) -> Option<&[AttributeValue]>;
}
```

#### DecodedEntity

```rust
/// Fully decoded entity
#[derive(Debug)]
pub struct DecodedEntity {
    pub express_id: u32,
    pub type_name: String,
    pub ifc_type: IfcType,
    pub attributes: Vec<AttributeValue>,
}
```

### Error Module

```rust
/// Parser error type
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Token error at position {position}: {message}")]
    Token { position: usize, message: String },

    #[error("Entity not found: #{0}")]
    EntityNotFound(u32),

    #[error("Invalid attribute at index {index}: {message}")]
    Attribute { index: usize, message: String },

    #[error("Unsupported schema: {0}")]
    UnsupportedSchema(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
```

---

## ifc-lite-geometry

Geometry processing functionality.

### Modules

```rust
pub mod mesh;           // Mesh data structures
pub mod triangulation;  // Polygon triangulation
pub mod profile;        // Profile handling
pub mod extrusion;      // Extrusion processing
pub mod csg;            // Boolean operations
pub mod router;         // Geometry routing
pub mod processors;     // Entity processors
```

### Mesh Module

#### Mesh

```rust
/// Triangle mesh representation
#[derive(Debug, Clone)]
pub struct Mesh {
    pub express_id: u32,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
}

impl Mesh {
    /// Create empty mesh
    pub fn new(express_id: u32) -> Self;

    /// Get vertex count
    pub fn vertex_count(&self) -> usize;

    /// Get triangle count
    pub fn triangle_count(&self) -> usize;

    /// Compute bounding box
    pub fn bounds(&self) -> BoundingBox;

    /// Apply transformation matrix
    pub fn transform(&mut self, matrix: &Matrix4<f64>);
}
```

#### BoundingBox

```rust
/// Axis-aligned bounding box
#[derive(Debug, Clone, Copy)]
pub struct BoundingBox {
    pub min: Point3<f64>,
    pub max: Point3<f64>,
}

impl BoundingBox {
    /// Create from points
    pub fn from_points(points: &[Point3<f64>]) -> Self;

    /// Get center point
    pub fn center(&self) -> Point3<f64>;

    /// Get size
    pub fn size(&self) -> Vector3<f64>;

    /// Merge with another box
    pub fn merge(&mut self, other: &BoundingBox);
}
```

### Triangulation Module

```rust
/// Triangulate a 2D polygon with holes
pub fn triangulate_polygon(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Result<Vec<u32>>;

/// Triangulate a simple polygon (no holes)
pub fn triangulate_simple(
    points: &[Point2<f64>],
) -> Result<Vec<u32>>;
```

### Profile Module

```rust
/// Extract profile points from IFC profile definition
pub fn extract_profile(
    decoder: &EntityDecoder,
    profile_id: u32,
) -> Result<ProfileData>;

/// Profile data with outer boundary and holes
#[derive(Debug)]
pub struct ProfileData {
    pub outer: Vec<Point2<f64>>,
    pub holes: Vec<Vec<Point2<f64>>>,
}
```

### Extrusion Module

```rust
/// Process extruded area solid
pub fn process_extrusion(
    profile: &ProfileData,
    direction: Vector3<f64>,
    depth: f64,
) -> Result<Mesh>;

/// Extrusion parameters
#[derive(Debug)]
pub struct ExtrusionParams {
    pub direction: Vector3<f64>,
    pub depth: f64,
    pub position: Matrix4<f64>,
}
```

### Router Module

```rust
/// Route geometry processing based on type
pub struct GeometryRouter {
    processors: HashMap<IfcType, Box<dyn GeometryProcessor>>,
}

impl GeometryRouter {
    /// Create router with default processors
    pub fn new() -> Self;

    /// Register custom processor
    pub fn register(&mut self, processor: Box<dyn GeometryProcessor>);

    /// Process entity geometry
    pub fn process(
        &self,
        decoder: &EntityDecoder,
        entity: &DecodedEntity,
    ) -> Result<Option<Mesh>>;
}
```

### Processor Trait

```rust
/// Trait for geometry processors
pub trait GeometryProcessor: Send + Sync {
    /// Check if processor can handle entity
    fn can_process(&self, entity: &DecodedEntity) -> bool;

    /// Process entity into mesh
    fn process(
        &self,
        decoder: &EntityDecoder,
        entity: &DecodedEntity,
    ) -> Result<Mesh>;
}
```

---

## ifc-lite-wasm

WebAssembly bindings.

### IfcAPI

```rust
/// Main WASM API class
#[wasm_bindgen]
pub struct IfcAPI {
    // ...
}

#[wasm_bindgen]
impl IfcAPI {
    /// Create new instance
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self;

    /// Parse IFC file
    #[wasm_bindgen]
    pub fn parse(&mut self, data: &[u8]) -> Result<JsValue, JsValue>;

    /// Parse with streaming
    #[wasm_bindgen]
    pub async fn parse_streaming(
        &mut self,
        data: &[u8],
        callback: &js_sys::Function,
    ) -> Result<JsValue, JsValue>;

    /// Get entity by ID
    #[wasm_bindgen]
    pub fn get_entity(&self, express_id: u32) -> Result<JsValue, JsValue>;

    /// Get geometry for entity
    #[wasm_bindgen]
    pub fn get_geometry(&self, express_id: u32) -> Result<JsValue, JsValue>;

    /// Get all meshes
    #[wasm_bindgen]
    pub fn get_all_meshes(&self) -> Result<JsValue, JsValue>;
}
```

---

## Building Documentation

Generate full Rustdoc documentation:

```bash
cd rust
cargo doc --no-deps --document-private-items --open
```

This will generate detailed documentation including:

- All public and private items
- Source code links
- Examples from doc comments
- Cross-references between items
