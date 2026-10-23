// SPDX-License-Identifier: MPL-2.0
//! Public vocabulary of the export-plan executor: what a caller asks for
//! ([`ExportPlan`]) and what it gets told afterwards ([`WriteReport`]).
//!
//! Callers speak IFC here, not STEP: an object is named by express id or
//! GlobalId, a property carries its measure type and unit rather than a
//! byte offset, and a placement is a 4x4 matrix rather than an
//! `IfcAxis2Placement3D` attribute list. [`super::execute`] is what lowers
//! this into the STEP-level primitives (`AttrMutation`, `CopyOnWriteMutation`)
//! the rest of this crate already carries.

/// One object in the source file, named the way a caller has it: by express
/// id when it already ran a query that produced one, by GlobalId when it
/// does not track express ids across a load.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ObjectRef {
    Id(u32),
    Guid(String),
}

impl std::fmt::Display for ObjectRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectRef::Id(id) => write!(f, "#{id}"),
            ObjectRef::Guid(g) => write!(f, "{g}"),
        }
    }
}

/// Whether a property write targets the occurrence's own set or the type's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropScope {
    /// Read/write the occurrence's effective value. When the value currently
    /// comes from the related type, this NEVER edits the type: it appends an
    /// occurrence-only property set that overrides it for this object alone.
    Occurrence,
    /// Read/write the type's own set, affecting every occurrence of it that
    /// does not carry its own override.
    Type,
}

/// A property or quantity, distinguished because they synthesize different
/// entities (`IfcPropertySingleValue` under `IfcPropertySet` vs. an
/// `IfcQuantityLength`-family entity under `IfcElementQuantity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PsetKind {
    Property,
    Quantity,
}

/// One typed property/quantity write: attach or overwrite `prop` in `pset`.
///
/// `measure_type` and `literal` are already STEP-serialized separately so the
/// executor can keep the source's measure wrapper when overwriting an
/// existing value it does not know the caller meant to change, e.g.
/// `measure_type: "IFCTHERMALTRANSMITTANCEMEASURE"`, `literal: "0.24"`. `unit`
/// is the STEP text of an explicit unit reference (`"#55"`) or literal
/// (`"$"` for none); `None` keeps whatever the existing record already
/// carries, or writes `$` for a brand new one.
#[derive(Debug, Clone)]
pub struct PropWrite {
    pub pset: String,
    pub prop: String,
    pub measure_type: String,
    pub literal: String,
    pub unit: Option<String>,
    pub kind: PsetKind,
    pub scope: PropScope,
}

/// Rewrite a product's placement to `matrix` (row-major, file units, relative
/// to whatever the existing `IfcLocalPlacement.PlacementRelTo` already
/// names — this carries no opinion about the parent, only the local
/// transform).
#[derive(Debug, Clone, Copy)]
pub struct PlacementPatch {
    pub matrix: [[f64; 4]; 4],
}

/// A triangle mesh. Indices are 0-based into `positions`.
#[derive(Debug, Clone)]
pub struct TriangleMesh {
    pub positions: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
}

/// A surface colour for body geometry. Components are 0..1.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceColour {
    pub rgb: [f64; 3],
    pub transparency: f64,
}

/// Replace a product's body geometry with `mesh`.
///
/// `mesh` is in the product's own local placement frame (the frame its
/// `ObjectPlacement` defines), in the file's length units. Nothing is
/// transformed or scaled on the way in.
///
/// The product gets a new `IfcProductDefinitionShape` holding one `Body`
/// `IfcShapeRepresentation` in the file's existing Body context (or its
/// `Model` context; one is created when the file has none). The mesh is
/// written in what the source schema can express, never converted: an
/// `IfcTriangulatedFaceSet` in IFC4 and IFC4X3, an `IfcFacetedBrep` in
/// IFC2X3 (an `IfcShellBasedSurfaceModel` when the mesh is not closed, since
/// a brep asserts a solid). `colour`, when given, is attached through an
/// `IfcStyledItem`.
///
/// Every representation the old shape carried is gone from the product,
/// not just its body: an `Axis`, `Box` or `FootPrint` representation
/// described the old geometry. Each non-Body one is listed in
/// [`WriteReport::dropped_representations`]. Old records nothing else uses
/// are pruned from the output; a record another product still uses (a shared
/// item, a type's `IfcRepresentationMap`, a profile) is kept.
///
/// A product whose geometry comes from its type through an `IfcMappedItem`
/// gets geometry of its own; the type and its other occurrences keep the
/// map. An opening voiding the product (`IfcRelVoidsElement`) is left as it
/// is: the caller's mesh is taken as the body before voids, like any other
/// body representation.
#[derive(Debug, Clone)]
pub struct GeometryPatch {
    pub mesh: TriangleMesh,
    pub colour: Option<SurfaceColour>,
}

/// What one object should become in the output.
///
/// `Patch` is much larger than the other variants. A plan holds one of these
/// per object it names, so the space is not worth an indirection in the
/// public shape.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Disposition {
    /// Keep the record(s) exactly as the source wrote them.
    Preserve,
    /// Apply the given edits; any field left `None`/empty is untouched.
    Patch(Patch),
    /// Remove the object and repair every relationship that named it.
    Delete,
    /// Not built here. Counted into
    /// [`WriteReport::added_unsupported`] so a caller can see the plan asked
    /// for something this package does not do yet, rather than reading a
    /// silently incomplete export.
    Add,
}

/// The edits [`Disposition::Patch`] carries. Any field left at its default
/// (`None`, empty `Vec`) makes no change for that concern.
#[derive(Debug, Clone, Default)]
pub struct Patch {
    pub name: Option<String>,
    pub psets: Vec<PropWrite>,
    pub placement: Option<PlacementPatch>,
    pub geometry: Option<GeometryPatch>,
}

/// Header provenance the caller supplies. There is no clock fallback: `now()`
/// is unavailable on the `wasm32-unknown-unknown` target this crate ships to.
#[derive(Debug, Clone, Default)]
pub struct PlanContext {
    pub author: Option<String>,
    pub organization: Option<String>,
    /// The header's `FILE_NAME` time stamp, written as given, so ISO 8601
    /// (`2026-10-23T10:00:00`). A synthesized owner history's `CreationDate`
    /// is read from it; a bare integer there is taken as Unix seconds.
    pub time_stamp: Option<String>,
}

/// The whole request: what happens to which objects, and the header
/// provenance to stamp the output with.
///
/// The output schema is always the source's own `FILE_SCHEMA` — this
/// executor resolves attributes correctly in whichever of IFC2X3/IFC4/IFC4X3
/// the source declares, but it does not itself convert BETWEEN them; that is
/// `crate::schema_convert`'s job, and a caller wanting both composes the two
/// rather than this module reimplementing conversion.
#[derive(Debug, Clone, Default)]
pub struct ExportPlan {
    pub dispositions: Vec<(ObjectRef, Disposition)>,
    pub context: PlanContext,
}

/// A disposition the executor could not carry out, and why. Every refusal
/// here is an edit the plan asked for that is NOT in the output.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub object: ObjectRef,
    pub reason: String,
}

/// One thing the post-write validator found wrong with the file it just
/// produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationFinding {
    pub express_id: Option<u32>,
    pub message: String,
}

/// A representation a [`GeometryPatch`] took off a product that was not its
/// body: an `Axis`, `Box`, `FootPrint` or other representation of the old
/// shape, which no longer describes the product once its body is replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedRepresentation {
    pub object: ObjectRef,
    /// Express id of the `IfcShapeRepresentation` in the source.
    pub representation: u32,
    /// Its `RepresentationIdentifier`, when it has one.
    pub identifier: Option<String>,
}

/// What [`super::execute`] did, and what it could not.
#[derive(Debug, Clone, Default)]
pub struct WriteReport {
    pub total: usize,
    pub written: usize,
    pub deleted: usize,
    pub patched: usize,
    pub added_unsupported: usize,
    pub refusals: Vec<Refusal>,
    pub findings: Vec<ValidationFinding>,
    /// Representations geometry patches removed from their products.
    pub dropped_representations: Vec<DroppedRepresentation>,
}

/// Failure modes of [`super::execute`] itself, as opposed to a single
/// disposition being refused (which is reported, not erred).
#[derive(Debug)]
pub enum PlanError {
    Io(std::io::Error),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Io(e) => write!(f, "export-plan write failed: {e}"),
        }
    }
}

impl std::error::Error for PlanError {}

impl From<std::io::Error> for PlanError {
    fn from(e: std::io::Error) -> Self {
        PlanError::Io(e)
    }
}
