// SPDX-License-Identifier: MPL-2.0
//! Shared inputs and outputs for canonical per-element production. Both
//! pipelines build these borrowed views; nothing here owns model state.
use super::*;

/// Element-level metadata stamped on every produced [`MeshData`]. The native
/// pipeline resolves these during its metadata phase; the browser passes
/// `None` (its viewer gets metadata from the parser worker instead).
#[derive(Debug, Clone, Default)]
pub struct ElementMeshMetadata {
    pub global_id: Option<String>,
    pub name: Option<String>,
    pub presentation_layer: Option<String>,
    pub space_zone_properties: Option<BTreeMap<String, String>>,
}

/// What the job renders.
#[derive(Debug, Clone)]
pub enum ElementJobKind {
    /// Ordinary product occurrence — walk its IfcProductDefinitionShape.
    Product,
    /// #957 type geometry: render these RepresentationMaps directly (baking
    /// their MappingOrigin), each pre-tagged with its geometry_class
    /// (1 = orphan, 2 = instanced). Produce the list with
    /// [`plan_type_geometry`] — callers must not hand-roll the filter.
    TypeProduct { rep_maps: Vec<(u32, u8)> },
}

/// One unit of mesh production.
pub struct ElementMeshJob<'a> {
    pub id: u32,
    pub ifc_type: IfcType,
    /// The decoded product (or type-product) entity. Callers decode it —
    /// they own skip-set checks and decode-failure policy.
    pub entity: &'a DecodedEntity,
    pub kind: ElementJobKind,
    /// Caller-resolved element fallback colour (direct style > material
    /// chain > type default). `None` ⇒ `default_color_for_type`.
    pub element_color: Option<[f32; 4]>,
    pub metadata: Option<&'a ElementMeshMetadata>,
}

/// Read-only shared state for one production run. Every field is a borrow of
/// `Sync` data, so `&MeshProductionContext` can be captured by a rayon
/// closure (native) or used serially (wasm).
pub struct MeshProductionContext<'a> {
    /// Host element id → opening ids (post void-propagation / opening filter).
    pub void_index: &'a FxHashMap<u32, Vec<u32>>,
    /// Geometry item id → resolved style (styled-item index).
    pub geometry_style_index: &'a FxHashMap<u32, GeometryStyleInfo>,
    /// Geometry item id → full per-triangle palette (#858).
    pub indexed_colour_full: &'a FxHashMap<u32, FullIndexedColourMap>,
    /// Element id → material colour list (#407/#913 transparent/opaque
    /// alternation). Empty map when the caller has no material chain data.
    pub element_material_colors: &'a FxHashMap<u32, Vec<[f32; 4]>>,
    /// Surface textures + UV maps keyed by face-set id (#961).
    pub texture_index: &'a FxHashMap<u32, ResolvedTextureMap>,
    /// Site-local rotation (native `site_local` coordinate space only).
    /// `None` for the browser — its Z-up→Y-up swap happens at the FFI
    /// boundary, after this function.
    pub site_local_rotation: Option<&'a Vec<f64>>,
}

/// RTC-invariant per-element fingerprint configuration (#971/#924).
#[derive(Debug, Clone, Copy)]
pub struct GeometryHashConfig {
    /// Quantization grid in metres.
    pub tolerance: f64,
    /// World-reconstruction offset added back to local positions (the batch
    /// RTC when a shift was applied, else zeros) so the file's RTC choice
    /// never registers as a geometry change.
    pub world_rtc: [f64; 3],
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MeshProductionOptions {
    /// `Some` ⇒ compute one fingerprint per element (browser diff feature).
    /// Type-product jobs are never hashed (diffing type-library shapes is a
    /// separate feature decision).
    pub geometry_hash: Option<GeometryHashConfig>,
}

/// The #957 suppress-vs-tag decision — an explicit product-requirement fork,
/// not drift. See [`plan_type_geometry`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeGeometryMode {
    /// Native/export: instanced types are suppressed entirely (an export must
    /// never duplicate geometry); orphan maps emit with geometry_class 1.
    SuppressInstanced,
    /// Viewer: instanced types emit too, tagged geometry_class 2, so the
    /// Model/Types view switch can filter at render time.
    EmitTagged,
}

/// Everything one element produced.
pub struct ProducedElementMeshes {
    pub meshes: Vec<MeshData>,
    /// #1623 Phase 2 don't-bake output: this element's occurrences of a repeated
    /// `IfcRepresentationMap` that skipped the per-occurrence materialize. Empty
    /// unless the router was armed with an instancing plan
    /// (`GeometryRouter::enable_output_instancing`); the streaming finalize resolves
    /// each into a [`crate::InstanceRecord`] against the shared template MeshData.
    pub instance_occurrences: Vec<RawInstanceOccurrence>,
    /// Per-ELEMENT fingerprint, accumulated across all of the element's
    /// meshes in the native IFC frame (pre-split, pre-site-rotation).
    /// `None` when hashing is off, nothing was produced, or the job is a
    /// TypeProduct.
    pub geometry_hash: Option<u64>,
    /// The same pass's world-space AABB, `[minx, miny, minz, maxx, maxy, maxz]`
    /// in unquantized `f64` world coordinates (the file's RTC folded back in),
    /// over every triangle corner the hasher saw. `Some` exactly when
    /// [`Self::geometry_hash`] is `Some`, so the two stay index-parallel at the
    /// FFI boundary.
    ///
    /// Why the diff engine needs it: the hash conflates moved / reshaped /
    /// re-tessellated into one "different" bit. The box separates them — same
    /// extent at a new centre is a MOVE, a different extent is a reshape, an
    /// identical box with a different hash is retriangulation.
    pub geometry_aabb: Option<[f64; 6]>,
    /// The element's enclosed volume in m³ from the SAME pass — `Some` ONLY
    /// when the produced geometry was provably a single closed orientable
    /// solid, `None` otherwise (#1891). `None` is the common case for
    /// material-layered walls, open `SurfaceModel` geometry, and any element
    /// assembled from more than one representation item.
    ///
    /// Read `ifc_lite_geometry::GeometryHasher::volume` before widening any
    /// clause of that gate: the alternative is not a slightly-off volume, it is
    /// a confidently wrong one with nothing about it that looks wrong.
    pub geometry_volume: Option<f64>,
    /// The folded per-segment topology verdict behind [`Self::geometry_volume`]
    /// — which clause held and which refused. `Some` exactly when
    /// [`Self::geometry_hash`] is. A model checker wants it: "open shell" and
    /// "multi-item assembly" are different findings with different fixes.
    pub geometry_closure: Option<ifc_lite_geometry::GeometryClosure>,
    /// CSG diagnostics recorded while producing THIS element, attributed by
    /// product id. The router is fully drained on return, so a warm router
    /// reused across a batch never leaks one element's failures into the
    /// next. Failures from a superseded strategy (a fallback re-attempting
    /// the same cuts) are discarded — only the path that produced the
    /// returned meshes contributes.
    pub csg_failures: FxHashMap<u32, Vec<BoolFailure>>,
    /// Triangles dropped by the f32-collapse degenerate-triangle backstop
    /// (see the `degenerate` child module) across ALL of this element's meshes.
    /// Zero when the backstop is disabled or nothing was degenerate.
    /// Request-local (scoped per `produce_element_meshes` call) so concurrent
    /// passes never cross-contaminate. Non-zero also RETRACTS
    /// [`Self::geometry_closure`] and [`Self::geometry_volume`] — the drop
    /// happens after the verdict was taken and can open a certified shell.
    pub degenerate_triangles_dropped: u64,
}
