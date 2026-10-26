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
#[non_exhaustive]
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
#[non_exhaustive]
pub struct PropWrite {
    pub pset: String,
    pub prop: String,
    pub measure_type: String,
    pub literal: String,
    pub unit: Option<String>,
    pub kind: PsetKind,
    pub scope: PropScope,
    /// The express id of the exact `IfcPropertySingleValue` / `IfcQuantity*`
    /// record to write, when the caller already holds it. The write then
    /// lands on the set named `pset` that lists that record, however many
    /// sets share that name, and is refused if no set of that name lists it
    /// or the record's own name is not `prop`. With `PropScope::Occurrence`,
    /// a target only the related type's set holds is not edited in place:
    /// the write lands on the object's own record of that property, or on a
    /// new copy that overrides it. `None` finds the first
    /// property of that name in the first set of that name.
    pub target: Option<u32>,
}

/// Rewrite a product's placement to `matrix` (row-major, file units, relative
/// to whatever the existing `IfcLocalPlacement.PlacementRelTo` already
/// names — this carries no opinion about the parent, only the local
/// transform).
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct PlacementPatch {
    pub matrix: [[f64; 4]; 4],
}

/// A triangle mesh. Indices are 0-based into `positions`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TriangleMesh {
    pub positions: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
}

/// A surface colour for body geometry. Components are 0..1.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
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
#[non_exhaustive]
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
#[non_exhaustive]
pub enum Disposition {
    /// Keep the record(s) exactly as the source wrote them.
    Preserve,
    /// Apply the given edits; any field left `None`/empty is untouched.
    Patch(Patch),
    /// Remove the object and repair every relationship that named it.
    ///
    /// A relationship whose required side goes empty is removed; one that
    /// keeps a member is rewritten. Records only deleted objects used
    /// (placements, geometry, property sets) are pruned. Objects and types
    /// the plan does not delete are never pruned: a port nested on a deleted
    /// host stays as a free product, a type whose occurrences are all deleted
    /// stays declared. The exception is an opening or projection, which IFC
    /// ties to exactly one element: it goes once no voids or projects
    /// relationship naming it is left (its host or that relationship
    /// deleted), whatever else still names it, unless an Add names it; a
    /// patch on it is refused. A record that names a deleted one through a
    /// single-valued attribute (a placement relative to a deleted placement,
    /// an object on that placement) goes too, since it cannot be written
    /// without a dangling reference.
    Delete,
    /// Build a new object from its IFC-level description. Boxed because the
    /// description is much larger than the other variants.
    Add(Box<super::add_types::NewObject>),
    /// Add a type with no occurrence. It must have its own GlobalId
    /// (`NewType::global_id`) and a name; the plan key names it in refusals
    /// and, like an Add's, must not resolve to anything in the source, and
    /// when it is a GlobalId must be the type's own. In IFC4 and IFC4X3 it is declared
    /// to the project through `IfcRelDeclares`; IFC2X3 has no such
    /// relationship, so there it is written on its own. A later Add in the
    /// same plan can be typed by it through `TypeLink::Existing`.
    AddType(Box<super::add_types::NewType>),
}

/// The edits [`Disposition::Patch`] carries. Any field left at its default
/// (`None`, empty `Vec`) makes no change for that concern.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Patch {
    pub name: Option<String>,
    pub psets: Vec<PropWrite>,
    pub placement: Option<PlacementPatch>,
    pub geometry: Option<GeometryPatch>,
}

/// Header provenance the caller supplies. There is no clock fallback: `now()`
/// is unavailable on the `wasm32-unknown-unknown` target this crate ships to.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct PlanContext {
    pub author: Option<String>,
    pub organization: Option<String>,
    /// The header's `FILE_NAME` time stamp, written as given, so ISO 8601
    /// (`2026-10-23T10:00:00`). A synthesized owner history's `CreationDate`
    /// is read from it; a bare integer there is taken as Unix seconds.
    pub time_stamp: Option<String>,
    /// The application making this export. With it, additions are attributed
    /// to it, modifications are recorded against it, and the header names it
    /// (see [`ExportingApplication`]). Without it the executor keeps the
    /// source's attribution and reports a finding when that matters.
    pub application: Option<ExportingApplication>,
    /// The header's `FILE_NAME` name. `None` writes `export.ifc`.
    pub file_name: Option<String>,
}

/// The person on whose behalf the exporting application makes its changes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ExportingPerson {
    /// `IfcPerson.Identification` (`Id` in IFC2X3), e.g. a user name.
    pub identification: String,
    /// `IfcPerson.FamilyName`: the name shown for the person.
    pub name: String,
}

/// Who an export attributes its changes to, per the buildingSMART
/// `IfcChangeActionEnum` guidance: an object the exporting application adds
/// is `ADDED` with that application as its `OwningApplication`; an object it
/// modifies keeps its original owner and creation date, and gets
/// `MODIFIED`, a `LastModifiedDate`, and the exporting user and application
/// as `LastModifyingUser` and `LastModifyingApplication`.
///
/// There is no clock fallback: `changed_at` is the time of the change, as the
/// caller states it, so the same inputs always produce the same bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ExportingApplication {
    /// `IfcApplication.ApplicationDeveloper`'s `IfcOrganization.Name`.
    pub developer: String,
    /// `IfcApplication.ApplicationFullName`.
    pub full_name: String,
    /// `IfcApplication.ApplicationIdentifier`.
    pub identifier: String,
    /// `IfcApplication.Version`.
    pub version: String,
    /// The user making the change. `None` names the application itself as
    /// the person, because `IfcPersonAndOrganization` needs one.
    pub person: Option<ExportingPerson>,
    /// When the change was made: ISO 8601 (`2026-10-23T10:00:00`, UTC unless
    /// it carries an offset) or Unix seconds. Written to every new owner
    /// history and, in UTC, to the header's `time_stamp`.
    pub changed_at: String,
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
#[non_exhaustive]
pub struct ExportPlan {
    pub dispositions: Vec<(ObjectRef, Disposition)>,
    pub context: PlanContext,
}

/// A disposition the executor could not carry out, and why. Every refusal
/// here is an edit the plan asked for that is NOT in the output.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Refusal {
    pub object: ObjectRef,
    pub reason: String,
}

/// One thing the post-write validator found wrong with the file it just
/// produced.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ValidationFinding {
    pub express_id: Option<u32>,
    pub message: String,
}

/// A representation a [`GeometryPatch`] took off a product that was not its
/// body: an `Axis`, `Box`, `FootPrint` or other representation of the old
/// shape, which no longer describes the product once its body is replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct DroppedRepresentation {
    pub object: ObjectRef,
    /// Express id of the `IfcShapeRepresentation` in the source.
    pub representation: u32,
    /// Its `RepresentationIdentifier`, when it has one.
    pub identifier: Option<String>,
}

/// What [`super::execute`] did, and what it could not.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct WriteReport {
    pub total: usize,
    pub written: usize,
    pub deleted: usize,
    /// Patch dispositions that wrote something (not distinct objects: two
    /// patches of one object count twice; a patch refused whole, or asking
    /// for nothing, counts not at all).
    pub patched: usize,
    /// Add dispositions that were built. A refused Add is in `refusals`.
    pub added: usize,
    pub refusals: Vec<Refusal>,
    pub findings: Vec<ValidationFinding>,
    /// Representations geometry patches removed from their products.
    pub dropped_representations: Vec<DroppedRepresentation>,
    /// Every record removed from the output (`deleted` of them), sorted by
    /// express id, each with why it went (see [`super::RemovalReason`] for
    /// which reason a record that went for several reports). The same plan
    /// reports the same reasons on every run.
    pub removed: Vec<super::removal::Removal>,
}

/// Failure modes of [`super::execute`] itself, as opposed to a single
/// disposition being refused (which is reported, not erred).
#[derive(Debug)]
#[non_exhaustive]
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
