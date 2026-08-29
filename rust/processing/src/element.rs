// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical per-element mesh production — THE single decision tree that turns
//! one IFC product (or type-product RepresentationMap) into renderable meshes.
//!
//! Both pipelines run this exact code:
//! - the native orchestrator (`processor.rs`) calls [`produce_element_meshes`]
//!   from its rayon loop with a fresh seeded decoder + router per element;
//! - the browser batch path (`wasm-bindings` `processGeometryBatch`) calls it
//!   per job with a warm per-batch decoder + router.
//!
//! History: the two pipelines used to carry diverging inline copies of this
//! tree, and fixes had to land twice (#858, #913, #957, #961, #1071). Any
//! change to mesh-production behaviour belongs HERE, exactly once. The only
//! sanctioned behavioural fork is [`TypeGeometryMode`] — a product
//! requirement, not drift: an export must never duplicate type geometry,
//! while the interactive viewer renders it tagged for its Model/Types switch.
//!
//! The converged decision tree (union of the strongest behaviours of both
//! former copies):
//!
//! ```text
//! representation gate (IfcAlignment exempt)
//! ├─ TypeProduct job (#957): render each planned RepresentationMap
//! │    (textures #961, geometry_class tag, styled-item colour)
//! └─ Product job:
//!    ├─ has openings → submesh-aware void cut (per-part colours survive)
//!    ├─ else        → submesh path for ALL types (per-item colours,
//!    │                per-item error skipping, #858 palette split per item)
//!    └─ fallback chain when the submesh path produced nothing:
//!         void-aware single mesh → plain element → element-level #858 split
//!         → single coloured mesh
//! ```

use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use crate::types::mesh::{MeshData, MeshTextureData, RawInstanceOccurrence};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::{
    calculate_normals, compose_instance_world_row_major, orient_mesh_outward_verdict, BoolFailure,
    GeometryHasher, GeometryRouter, Mesh, ResolvedTextureMap, SubMeshCollection,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;

use crate::processor::convert_mesh_to_site_local;

/// The f32-collapse degenerate backstop, its per-element tally, and the reason
/// that tally now gates the closure verdict. A CHILD module: it exists only to
/// serve this file's produce/emit cycle.
#[path = "element_degenerate.rs"]
mod degenerate;
mod element_color;
use element_color::{find_indexed_colour_for_element, infer_opening_subpart_material_name};
// Re-exported because these two have callers outside this module:
// `find_geometry_item_color` from processor/color_layer.rs, and
// `resolve_color_for_representation_map` from processor/jobs.rs.
pub(crate) use element_color::{find_geometry_item_color, resolve_color_for_representation_map};

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

/// The single home of the #957 orphan/instanced RepresentationMap decision.
///
/// A map referenced by an `IfcMappedItem` always draws through its occurrence
/// — emitting it again would double-render at the MappingOrigin (the
/// AC20/ArchiCAD duplicate-boxes regression), so referenced maps are filtered
/// in every mode. What remains is classified by whether the type has an
/// occurrence (`IfcRelDefinesByType`): orphans are class 1 (part of the
/// model — nothing else renders them), instanced types are class 2 (the
/// type-library shape) and only emitted in [`TypeGeometryMode::EmitTagged`].
pub fn plan_type_geometry(
    rep_map_ids: &[u32],
    referenced_representation_maps: &FxHashSet<u32>,
    type_is_instantiated: bool,
    mode: TypeGeometryMode,
) -> Vec<(u32, u8)> {
    if mode == TypeGeometryMode::SuppressInstanced && type_is_instantiated {
        return Vec::new();
    }
    let class: u8 = if type_is_instantiated { 2 } else { 1 };
    rep_map_ids
        .iter()
        .filter(|rm| !referenced_representation_maps.contains(rm))
        .map(|rm| (*rm, class))
        .collect()
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

/// THE canonical per-element mesh producer.
///
/// Decoder and router are caller-supplied so each pipeline keeps its reuse
/// policy: the native rayon loop builds a fresh seeded decoder + router per
/// element; the browser batch path reuses one warm pair per batch. The
/// decoder MUST have its unit-scale caches seeded
/// (`EntityDecoder::seed_unit_scales`) — otherwise arc tessellation re-pays
/// an O(file) IFCPROJECT scan per fresh decoder.
pub fn produce_element_meshes(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ProducedElementMeshes {
    // Open a per-element CSG escalation scope (#1109). Every boolean this element
    // issues (one per opening, plus clip cuts) accumulates into ONE deterministic
    // budget, so a boolean-heavy element (a slab cut by 24+ openings, a Tekla
    // member with stacked half-space clips) degrades as a UNIT — its remaining
    // cuts bail to the #635 AABB fallback — instead of grinding the geometry
    // stream past the 95% watchdog. The per-boolean cap alone could not see this
    // distributed cost. Unbounded under the server/offline-export profile.
    ifc_lite_geometry::kernel::budget::begin_element();

    // Open this element's degenerate-backstop scope (same begin/drain shape as
    // the kernel budget above); see the `degenerate` child module.
    degenerate::begin_element();

    let mut hasher = match (&job.kind, opts.geometry_hash) {
        (ElementJobKind::Product, Some(cfg)) => {
            Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc))
        }
        _ => None,
    };

    let (meshes, instance_occurrences) = produce_inner(job, ctx, decoder, router, &mut hasher);

    // Drain the router's per-element CSG diagnostics on EVERY return path so
    // a warm (batch-reused) router starts the next element clean.
    let csg_failures = router.take_csg_failures();

    // A hash with NO box is reachable and deliberately KEPT (a NaN axis hashes
    // but never accumulates); `push_geometry_hash` reserves NaN slots so the FFI
    // arrays still cannot misalign. Box-without-hash is impossible. VOLUME may
    // likewise be `None` within an emitted entry (landing as NaN) — the normal
    // answer for most elements. See `world_aabb` / `GeometryHasher::volume`.
    let degenerate_triangles_dropped = degenerate::dropped_this_element();

    // The verdict was taken where the orienter runs; `build_mesh_data` then ran
    // the degenerate backstop over the same triangles, and a dropped triangle
    // opens every neighbour along its three edges. Retract before reading, so
    // what ships describes the mesh actually returned (see
    // `retract_closure_if_mesh_edited`).
    let (geometry_hash, geometry_aabb, geometry_volume, geometry_closure) = match hasher {
        Some(mut h) if !h.is_empty() => {
            h.retract_closure_if_mesh_edited(degenerate_triangles_dropped);
            (Some(h.finish()), h.world_aabb(), h.volume(), Some(h.closure()))
        }
        _ => (None, None, None, None),
    };

    ProducedElementMeshes {
        meshes,
        instance_occurrences,
        geometry_hash,
        geometry_aabb,
        geometry_volume,
        geometry_closure,
        csg_failures,
        degenerate_triangles_dropped,
    }
}

fn produce_inner(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    hasher: &mut Option<GeometryHasher>,
) -> (Vec<MeshData>, Vec<RawInstanceOccurrence>) {
    // Representation gate, with the IfcAlignment exception: alignments carry
    // their geometry on IfcAlignment*Segment children, so a null
    // Representation attribute does not mean "nothing to render".
    let has_representation = job.entity.get(6).is_some_and(|a| !a.is_null());
    if !has_representation && job.ifc_type != IfcType::IfcAlignment {
        return (Vec::new(), Vec::new());
    }

    let element_color = job
        .element_color
        .unwrap_or_else(|| crate::style::default_color_for_type(job.ifc_type).to_array());

    if let ElementJobKind::TypeProduct { rep_maps } = &job.kind {
        // Type-product geometry (orphan/instanced RepresentationMaps) never rides the
        // don't-bake path — it is view-mode-gated by geometry_class, not instanced.
        return (
            produce_type_geometry(job, rep_maps, element_color, ctx, decoder, router),
            Vec::new(),
        );
    }

    let has_openings = ctx
        .void_index
        .get(&job.id)
        .is_some_and(|openings| !openings.is_empty());

    // Material-layer wall: tag its per-layer slices GEOM_CLASS_LAYER_SLICE so the
    // 2D/section cut can split the cut into per-layer fills (one sub-mesh = one
    // layer = one colour). Since #1311 the slices are OPEN bands whose union is
    // the wall's watertight outer skin (no coincident interface caps), and the
    // renderer draws them DOUBLE-SIDED like all other IFC geometry — IFC winding
    // is not reliably outward, so the previous backface-culling of these slices
    // dropped inward-wound faces and made the wall read hollow. The tag no longer
    // drives any culling; it is purely the per-layer-fill marker.
    let layer_class = if router.is_material_layer_sliceable(job.id) {
        GEOM_CLASS_LAYER_SLICE
    } else {
        0
    };

    if has_openings {
        // Voided elements: submesh-aware cut FIRST, so per-part colours
        // survive the void subtraction (a voided window keeps frame/glass
        // split; a voided multi-layer wall keeps its layer colours).
        if let Ok(sub_meshes) =
            router.process_element_with_submeshes_and_voids(job.entity, decoder, ctx.void_index)
        {
            if !sub_meshes.is_empty() {
                let (out, occ) =
                    emit_sub_meshes(job, sub_meshes, element_color, ctx, decoder, hasher, layer_class);
                if !out.is_empty() || !occ.is_empty() {
                    return (out, occ);
                }
            }
        }
    } else {
        // Submesh path for ALL types: per-geometry-item colours (window glass
        // transparency, multi-material doors) and per-item error skipping —
        // one unsupported representation item no longer blanks the whole
        // element (`process_element` aborts with `?`). #858 palette split
        // happens per item inside `emit_sub_meshes`.
        if let Ok(sub_meshes) =
            router.process_element_with_submeshes_textured(job.entity, decoder, ctx.texture_index)
        {
            if !sub_meshes.is_empty() {
                let (out, occ) =
                    emit_sub_meshes(job, sub_meshes, element_color, ctx, decoder, hasher, layer_class);
                // #1623 Phase 2: a pure don't-bake occurrence produces NO flat mesh
                // (only instance placeholders); treat that as success so the fallback
                // chain below does not re-materialize the element flat.
                if !out.is_empty() || !occ.is_empty() {
                    return (out, occ);
                }
            }
        }
    }

    // Fallback chain. A superseding strategy is about to re-process this
    // element's representation and re-attempt the same (deterministic)
    // cuts/booleans; discard the abandoned attempt's diagnostics so
    // re-failures aren't double-counted. (The voids→plain-element
    // mini-fallback below intentionally keeps its records: a failed/emptying
    // cut that leaves the host uncut IS the diagnostic.)
    let _ = router.take_csg_failures();

    let mut mesh_candidate = router
        .process_element_with_voids(job.entity, decoder, ctx.void_index)
        .ok();
    let needs_fallback = match mesh_candidate.as_ref() {
        // An empty void-cut result normally means the cut FAILED and emptied
        // the host, so we re-render it un-cut. But when a containing void
        // genuinely CONSUMED the host (`host_consumed_by_void`), the empty
        // result is correct — keep it, or the un-cut host re-appears as a
        // spurious solid.
        Some(mesh) => mesh.is_empty() && !router.host_consumed_by_void(job.id),
        None => true,
    };
    if needs_fallback {
        mesh_candidate = router.process_element(job.entity, decoder).ok();
    }

    let Some(mut mesh) = mesh_candidate else {
        return (Vec::new(), Vec::new());
    };
    if mesh.is_empty() {
        return (Vec::new(), Vec::new());
    }

    // Make the assembled body consistently outward-wound. A faceted brep (IFC
    // face loops are not reliably outward) or a merged multi-item body (extrusion
    // unioned with a boolean cut) can carry MIXED winding that corrupts signed
    // volume and the smooth normals computed below. No-op for already-consistent
    // bodies (every extrusion), so their index buffer + normals are untouched; a
    // flip invalidates any baked normals, so recompute them.
    //
    // The verdict rides along to the hasher below: this pass is the only place
    // that knows whether the assembled body is a closed orientable solid, and
    // without that a per-element volume cannot be emitted honestly (#1891).
    let verdict = orient_mesh_outward_verdict(&mut mesh);
    if verdict.flipped {
        calculate_normals(&mut mesh);
    }

    // Multi-colour IfcIndexedColourMap → one mesh per palette group (#858),
    // resolved by walking the element's representation for the colour-mapped
    // face set. Only applies while the produced triangle count still matches
    // the face set's CoordIndex (no CSG/void retopology) — the splitter
    // guards this; otherwise the single dominant-coloured mesh below wins.
    if !ctx.indexed_colour_full.is_empty() {
        if let Some(full) =
            find_indexed_colour_for_element(job.entity, ctx.indexed_colour_full, decoder)
        {
            let geometry_id = full.geometry_id;
            if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&mesh, full) {
                if let Some(h) = hasher.as_mut() {
                    // The palette split below only partitions triangles; the
                    // verdict from the un-split body is the one that describes
                    // this hashed buffer.
                    h.add_oriented_mesh(&mesh.positions, &mesh.indices, mesh.origin, verdict);
                }
                let mut out: Vec<MeshData> = Vec::with_capacity(groups.len());
                for (color, mut part) in groups {
                    if part.normals.len() != part.positions.len() {
                        calculate_normals(&mut part);
                    }
                    out.push(build_mesh_data(
                        job,
                        part,
                        color.to_array(),
                        None,
                        Some(geometry_id),
                        false,
                        0,
                        ctx,
                        None,
                    ));
                }
                if !out.is_empty() {
                    return (out, Vec::new());
                }
            }
        }
    }

    if mesh.normals.len() != mesh.positions.len() {
        calculate_normals(&mut mesh);
    }
    if let Some(h) = hasher.as_mut() {
        h.add_oriented_mesh(&mesh.positions, &mesh.indices, mesh.origin, verdict);
    }
    (
        vec![build_mesh_data(job, mesh, element_color, None, None, false, 0, ctx, None)],
        Vec::new(),
    )
}

/// Emit a sub-mesh collection: per-item colour resolution through the
/// canonical `resolve_submesh_color` precedence (#913 §4.2), material-name
/// inference for window/door parts, and the #858 per-item palette split.
fn emit_sub_meshes(
    job: &ElementMeshJob<'_>,
    sub_meshes: SubMeshCollection,
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
    // geometry_class stamped on every emitted sub-mesh. 0 for normal occurrence
    // geometry; GEOM_CLASS_LAYER_SLICE (3) when these are the per-layer slices of
    // a material-layer wall — a section-only detail the 3D renderer skips (the
    // wall renders as one solid) but the 2D/section cut consumes.
    slice_class: u8,
) -> (Vec<MeshData>, Vec<RawInstanceOccurrence>) {
    // Read ONCE, before the loop consumes the collection: what the ids MEAN is
    // a property of the collection, not of any individual sub-mesh (#3199).
    let ids_are_materials = sub_meshes.ids_are_materials;
    let mut out: Vec<MeshData> = Vec::with_capacity(sub_meshes.len());
    let mut occurrences: Vec<RawInstanceOccurrence> = Vec::new();
    // Material colours for this element, used when a sub-mesh has no direct
    // style — alternated so frame (opaque) and glazing (transparent) split
    // across the window's parts (#913 §2.3).
    let material_colors = ctx.element_material_colors.get(&job.id);
    let mut mat_color_idx = 0usize;

    for sub in sub_meshes.sub_meshes {
        let mut sub_mesh = sub.mesh;
        if sub_mesh.is_empty() {
            // #1623 Phase 2 don't-bake: an EMPTY sub-mesh carrying instanceable
            // InstanceMeta is a non-template occurrence of a shared template. Convert
            // it to a RawInstanceOccurrence (resolving its colour EXACTLY as a
            // materialized sub-mesh would, keyed on the same nested-solid geometry_id)
            // instead of dropping it. `transform` was folded into `im.transform` by
            // `apply_submesh_placement`; we compose the full pre-RTC world transform
            // here and let the streaming finalize derive the template-relative mat4.
            if let Some(im) = sub_mesh.instance_meta.as_ref().filter(|im| im.instanceable) {
                let style = ctx.geometry_style_index.get(&sub.geometry_id);
                let direct_color = style.map(|s| s.color).or_else(|| {
                    find_geometry_item_color(sub.geometry_id, ctx.geometry_style_index, decoder)
                });
                let color = crate::style::resolve_submesh_color(
                    direct_color,
                    material_colors.map(|v| v.as_slice()),
                    &mut mat_color_idx,
                    element_color,
                );
                occurrences.push(RawInstanceOccurrence {
                    express_id: job.id,
                    ifc_type: job.ifc_type.name().to_string(),
                    global_id: job.metadata.and_then(|m| m.global_id.clone()),
                    name: job.metadata.and_then(|m| m.name.clone()),
                    presentation_layer: job.metadata.and_then(|m| m.presentation_layer.clone()),
                    color,
                    rep_identity: im.rep_identity,
                    world_transform: compose_instance_world_row_major(im),
                    // #2985: the id `build_mesh_data` would have stamped had this
                    // sub-mesh materialized. ONE home for the #3199 discriminator and the
                    // 0-filter — two spellings drift invisibly ("no item id" reads as "no item").
                    geometry_item_id: MeshData::style_geometry_item_id(Some(sub.geometry_id), ids_are_materials),
                });
            }
            continue;
        }
        // Consistently outward-wind each sub-body (see the single-mesh path); a
        // flip invalidates baked normals, so recompute on flip or when absent.
        // The verdict is per SUB-BODY, which is also the hasher's segment
        // granularity, so closedness is attributed to exactly what it describes.
        let verdict = orient_mesh_outward_verdict(&mut sub_mesh);
        if verdict.flipped || sub_mesh.normals.len() != sub_mesh.positions.len() {
            calculate_normals(&mut sub_mesh);
        }

        let style = ctx.geometry_style_index.get(&sub.geometry_id);
        // Direct style wins; else chase IfcMappedItem so mapped sub-geometry
        // inherits its underlying style (#913 §2.7).
        let direct_color = style.map(|s| s.color).or_else(|| {
            find_geometry_item_color(sub.geometry_id, ctx.geometry_style_index, decoder)
        });
        let color = crate::style::resolve_submesh_color(
            direct_color,
            material_colors.map(|v| v.as_slice()),
            &mut mat_color_idx,
            element_color,
        );
        let material_name = style
            .and_then(|s| s.material_name.as_ref())
            .map(ToString::to_string)
            .or_else(|| infer_opening_subpart_material_name(&job.ifc_type, color, sub.geometry_id));

        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(&sub_mesh.positions, &sub_mesh.indices, sub_mesh.origin, verdict);
        }

        // Textured face set (#1781): thread the per-vertex UVs through the
        // weld (kept 1:1 with positions, seams stay split) and attach the
        // texture, mirroring the type-geometry path (#961). The length guard
        // drops the texture instead of sampling garbage if any upstream step
        // rebuilt vertices without maintaining the UV channel.
        if let (Some(uvs), Some(texture)) = (sub.uvs, sub.texture.as_ref()) {
            if uvs.len() / 2 == sub_mesh.positions.len() / 3 {
                let mut mesh_data = build_mesh_data(
                    job,
                    sub_mesh,
                    color,
                    material_name,
                    Some(sub.geometry_id),
                    ids_are_materials,
                    slice_class,
                    ctx,
                    Some(uvs),
                );
                mesh_data.texture = Some(MeshTextureData::from_attachment(texture));
                out.push(mesh_data);
                continue;
            }
        }

        // #858: a face set with a per-triangle colour map splits into one
        // mesh per palette group (guards inside the splitter: triangle count
        // must still match, ≥2 distinct colours). Palette colours supersede
        // the resolved style colour for the split parts.
        if let Some(full) = ctx.indexed_colour_full.get(&sub.geometry_id) {
            if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&sub_mesh, full) {
                for (rgba, mut part) in groups {
                    if part.normals.len() != part.positions.len() {
                        calculate_normals(&mut part);
                    }
                    out.push(build_mesh_data(
                        job,
                        part,
                        rgba.to_array(),
                        None,
                        Some(sub.geometry_id),
                        ids_are_materials,
                        slice_class,
                        ctx,
                        None,
                    ));
                }
                continue;
            }
        }

        out.push(build_mesh_data(
            job,
            sub_mesh,
            color,
            material_name,
            Some(sub.geometry_id),
            ids_are_materials,
            slice_class,
            ctx,
            None,
        ));
    }
    (out, occurrences)
}

/// geometry_class for the per-layer slices of a material-layer wall. The wall's
/// slices have verified outward winding, so the 3D renderer draws THIS class
/// BACKFACE-CULLED — the build-up shows on the faces/edges but the interior
/// coincident caps never rasterise, so the thin stacked solids don't z-fight
/// into a hollow shell. The 2D/section cut consumes the same class (never
/// culled) for its per-layer fills.
pub const GEOM_CLASS_LAYER_SLICE: u8 = 3;

/// Render a type-product's planned RepresentationMaps (#957), texture-aware
/// (#961), each mesh tagged with its planned geometry_class.
fn produce_type_geometry(
    job: &ElementMeshJob<'_>,
    rep_maps: &[(u32, u8)],
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Vec<MeshData> {
    let mut out: Vec<MeshData> = Vec::new();
    for &(rep_map_id, geometry_class) in rep_maps {
        let Ok(rep_map) = decoder.decode_by_id(rep_map_id) else {
            continue;
        };
        // One part per output mesh: each textured face set carries its own
        // UVs + decoded image; untextured items merge into one part (#961).
        let Ok(parts) =
            router.process_representation_map_with_texture(&rep_map, decoder, ctx.texture_index)
        else {
            continue;
        };
        if parts.is_empty() {
            continue;
        }

        let color =
            resolve_color_for_representation_map(rep_map_id, ctx.geometry_style_index, decoder)
                .unwrap_or(element_color);

        for (mut mesh, uvs, texture) in parts {
            if mesh.is_empty() {
                continue;
            }
            if mesh.normals.len() != mesh.positions.len() {
                calculate_normals(&mut mesh);
            }
            // Thread the per-vertex UVs through `build_mesh_data` so the source
            // weld remaps them WITH the deduped positions (and keeps texture
            // seams split). Only textured parts carry UVs; untextured parts pass
            // `None` and get the full position+normal weld.
            let part_uvs = if texture.is_some() { Some(uvs) } else { None };
            let mut mesh_data =
                build_mesh_data(job, mesh, color, None, None, false, geometry_class, ctx, part_uvs);
            if let Some(tex) = texture {
                // UVs were already welded onto `mesh_data`; attach only the
                // texture (decoded image or #1781 external reference) here.
                mesh_data.texture = Some(MeshTextureData::from_attachment(&tex));
            }
            out.push(mesh_data);
        }
    }
    out
}

/// Construct the final [`MeshData`]: metadata stamp, style metadata,
/// geometry-class tag, and the optional site-local rotation. ALWAYS the last
/// step — geometry hashing happens before this (native IFC frame), which is why
/// the degenerate drop below has to report what it removed: it edits a mesh the
/// hasher has already ruled on.
#[allow(clippy::too_many_arguments)] // distinct per-mesh funnel inputs
fn build_mesh_data(
    job: &ElementMeshJob<'_>,
    mut mesh: Mesh,
    color: [f32; 4],
    material_name: Option<String>,
    // The sub-mesh's source id, plus WHAT IT IS. Routed to `geometry_item_id`
    // or `material_id` by `with_style_metadata`, never both (#3199).
    source_id: Option<u32>,
    id_is_material: bool,
    geometry_class: u8,
    ctx: &MeshProductionContext<'_>,
    // Per-vertex texture coordinates (2 per vertex, 1:1 with `mesh.positions`),
    // present only for textured type geometry (#961). Threaded through the weld
    // so the UVs are remapped WITH the deduped positions and stay aligned; a UV
    // difference also keeps a texture seam's coincident corners split.
    uvs: Option<Vec<f32>>,
) -> MeshData {
    // Backstop for f32 vertex-storage collapse, at the single funnel for every
    // element MeshData, tallying what it removed — `produce_element_meshes`
    // drains that tally both into the result and into the closure retraction.
    degenerate::clean(&mut mesh);
    // Source vertex weld (see `mesh_weld::weld_indexed`): the faceted-brep
    // mesher emits per-`IfcFace` geometry duplicating every shared corner once
    // per incident face (~3-6x). Collapse coincident vertices (identical f32
    // position + quantized normal + quantized UV) at this single per-element
    // funnel — the normal/UV keys keep creases and texture seams split (flat
    // shading, no torn textures), and UVs are remapped WITH the positions.
    // `None` = nothing merged (already-welded swept solids): keep originals, no
    // realloc; triangles, winding, and AABB unchanged either way.
    let welded_uvs = match ifc_lite_geometry::mesh_weld::weld_indexed(
        &mesh.positions,
        &mesh.normals,
        uvs.as_deref(),
        &mesh.indices,
    ) {
        Some((wp, wn, wuv, wi)) => {
            mesh.positions = wp;
            mesh.normals = wn;
            mesh.indices = wi;
            wuv
        }
        None => uvs,
    };
    let mesh_origin = mesh.origin;
    // Instancing: capture before the fields are moved into MeshData. A site-local
    // rotation (below) re-transforms positions/origin and would invalidate the
    // captured transform, so drop instancing when one is active (rare; conservative).
    let instance = if ctx.site_local_rotation.is_none() {
        mesh.instance_meta.take()
    } else {
        None
    };
    // Local bounds/placement transform (issue #1474): same caveat as instancing
    // above — a site-local rotation re-transforms positions and would invalidate
    // the captured placement, so drop both when one is active.
    let (local_bounds, local_to_world) = if ctx.site_local_rotation.is_none() {
        (mesh.local_bounds, mesh.local_to_world)
    } else {
        (None, None)
    };
    let mut mesh_data = MeshData::new(
        job.id,
        job.ifc_type.name().to_string(),
        mesh.positions,
        mesh.normals,
        mesh.indices,
        color,
    )
    .with_origin(mesh_origin)
    .with_instance(instance)
    .with_local_bounds(local_bounds)
    .with_local_to_world(local_to_world);
    if let Some(meta) = job.metadata {
        mesh_data = mesh_data
            .with_element_metadata(
                meta.global_id.clone(),
                meta.name.clone(),
                meta.presentation_layer.clone(),
            )
            .with_properties(meta.space_zone_properties.clone());
    }
    if material_name.is_some() || source_id.is_some() {
        mesh_data =
            mesh_data.with_style_metadata(material_name, source_id, id_is_material);
    }
    if geometry_class != 0 {
        mesh_data = mesh_data.with_geometry_class(geometry_class);
    }
    // Attach the welded UVs (kept 1:1 with the welded positions by the weld).
    // The texture IMAGE is attached by the caller; here we only carry the
    // per-vertex coordinates through the funnel so they can't desync.
    mesh_data.uvs = welded_uvs;
    convert_mesh_to_site_local(&mut mesh_data, ctx.site_local_rotation);
    mesh_data
}

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;
