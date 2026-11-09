// SPDX-License-Identifier: MPL-2.0
//! The geometry pass shared by the scene exporters (USD, Rhino 3dm).
//!
//! Both author repeated single-solid mapped geometry once (a USD prototype, a
//! Rhino block) and place each occurrence by transform, so both need the same
//! answer to two questions: which meshes are emittable, and may the instanced
//! result be authored without dropping or misplacing geometry. One home, so
//! the two formats cannot drift on what reaches the file.
//!
//! Instancing is #1623 don't-bake: each non-template occurrence of a repeated
//! `IfcRepresentationMap` arrives as an `InstanceRecord` placing the template
//! `MeshData` (kept in `meshes` under `template_express_id`). Georeferenced
//! ("site-local") models disable don't-bake upstream, so they come out fully
//! baked automatically.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ifc_lite_core::{EntityIndex, IfcType};
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};

/// A void-cutting volume: `IfcOpeningElement` (and subtypes) or
/// `IfcVoidingFeature`. A cutter, not building geometry. The Rhino scene's
/// test; USD's `guide` purpose keeps its exact-class match, so USD output
/// does not move with this one.
pub(crate) fn is_void_volume(ifc_type: &str) -> bool {
    let t = IfcType::from_str(ifc_type);
    t.is_subtype_of(IfcType::IfcOpeningElement) || t.is_subtype_of(IfcType::IfcVoidingFeature)
}

/// An `IfcSpace`: a room volume, drawn only as a reference.
pub(crate) fn is_space(ifc_type: &str) -> bool {
    IfcType::from_str(ifc_type).is_subtype_of(IfcType::IfcSpace)
}

/// The geometry a scene exporter authors: the pipeline result, which of its
/// meshes pass [`mesh_emittable`], and whether its `instances` may be authored.
pub(crate) struct SceneInput {
    pub(crate) result: ProcessingResult,
    /// Indices into `result.meshes` of the emittable meshes, in pipeline order.
    emittable: Vec<usize>,
    /// The instanced result passed [`all_instances_safe`]; when false,
    /// `result.instances` must be ignored (it is empty or the result is baked).
    pub(crate) use_instancing: bool,
}

impl SceneInput {
    fn new(result: ProcessingResult, use_instancing: bool) -> Self {
        let emittable = emittable_indices(&result);
        Self { result, emittable, use_instancing }
    }

    /// The emittable meshes, in pipeline order.
    pub(crate) fn emittable(&self) -> impl Iterator<Item = &MeshData> + '_ {
        self.emittable.iter().map(|&i| &self.result.meshes[i])
    }

    /// The instance records to author: all of them when instancing is safe, else none.
    pub(crate) fn instances(&self) -> &[ifc_lite_processing::InstanceRecord] {
        if self.use_instancing { &self.result.instances } else { &[] }
    }
}

fn emittable_indices(r: &ProcessingResult) -> Vec<usize> {
    r.meshes.iter().enumerate().filter(|(_, m)| mesh_emittable(m)).map(|(i, _)| i).collect()
}

/// Emittable-mesh gate: the glTF `mesh_visible` geometry sanity (no instanced
/// type-library duplicates, matched non-empty triangulated buffers) PLUS the
/// guards that keep a scene file parseable: all-finite coordinates, a finite
/// per-mesh origin, and every index within the vertex range.
pub(crate) fn mesh_emittable(m: &MeshData) -> bool {
    // The shared from-bytes gate: no instanced type-library duplicates, whole
    // triangles (so faceVertexCounts of all-3s sums to the index count, else
    // usdchecker rejects the mesh), and finite coordinates and origin (the
    // origin becomes a double3 translate; fmt would map a non-finite one to 0
    // and silently mislocate the mesh).
    if !crate::mesh_input::is_exportable(m) || m.normals.len() != m.positions.len() {
        return false;
    }
    let vcount = (m.positions.len() / 3) as u32;
    m.indices.iter().all(|&i| i < vcount)
}

/// The full-pass request every scene export runs, sharing `index` when the
/// caller already built one for the same bytes.
fn request(layer_slicing: bool, index: Option<&Arc<EntityIndex>>) -> ProcessingRequest {
    let req = ProcessingRequest::full_pass().layer_slicing(layer_slicing);
    match index {
        Some(index) => req.index(Arc::clone(index)),
        None => req,
    }
}

/// Run the geometry pipeline with #1623 don't-bake instancing enabled and collect the
/// result (unbounded batches, default `retain_emitted_meshes` so templates survive).
#[cfg(test)]
pub(crate) fn run_instanced(content: &[u8], layer_slicing: bool) -> ProcessingResult {
    run_instanced_with(content, layer_slicing, None)
}

fn run_instanced_with(content: &[u8], layer_slicing: bool, index: Option<&Arc<EntityIndex>>) -> ProcessingResult {
    process(content, &request(layer_slicing, index).instancing(true), &mut ())
}

/// Choose the geometry result.
///
/// When instancing is requested we run the don't-bake pass; if it produced instances AND
/// every instance is safe to author (see [`all_instances_safe`]), we use it. Otherwise —
/// instances present but any unsafe — we re-run the plain (all-baked) pass so nothing is
/// dropped or misplaced. The extra pass is uncommon (a template failing the mesh gate,
/// an f32-overflowed transform, or one of the ambiguous multi-record / multi-submesh /
/// mixed-geometry shapes the single-prototype-per-id emitters can't represent); the common
/// case is a single pass. `index`, when given, must be built from `content`.
pub(crate) fn gather(
    content: &[u8],
    instancing: bool,
    layer_slicing: bool,
    index: Option<&Arc<EntityIndex>>,
) -> SceneInput {
    let baked = || SceneInput::new(process(content, &request(layer_slicing, index), &mut ()), false);
    if !instancing {
        return baked();
    }
    let r = run_instanced_with(content, layer_slicing, index);
    if r.instances.is_empty() {
        return SceneInput::new(r, false); // no repetition — the result is already complete
    }
    let input = SceneInput::new(r, true);
    if all_instances_safe(&input) {
        input
    } else {
        baked() // fallback: re-bake every occurrence
    }
}

/// Gate that decides whether the id-keyed, one-prototype-per-template emitters can author
/// this instanced result **without dropping or misplacing any geometry**. Every condition
/// below is a shape the single-occurrence-per-id / `meshes_by_id[tid].first()` emitters
/// cannot represent faithfully; any hit sends [`gather`] to the always-correct baked path.
/// The emitters themselves assume these hold.
fn all_instances_safe(input: &SceneInput) -> bool {
    // Emittable submeshes grouped by express id — the exact gate the exporters author with.
    let mut submesh_count: HashMap<u32, usize> = HashMap::new();
    for m in input.emittable() {
        *submesh_count.entry(m.express_id).or_default() += 1;
    }
    instances_authorable(
        input.result.instances.iter().map(|rec| (rec.express_id, rec.template_express_id, rec.transform)),
        &submesh_count,
    )
}

/// Pure core of [`all_instances_safe`], factored out so the fallback conditions are unit
/// testable without synthesizing a whole `ProcessingResult`. Given each occurrence's
/// `(express_id, template_express_id, transform)` and the emittable-submesh count per
/// express id, decide whether the id-keyed / one-prototype-per-template emitters can author
/// them all with no dropped or misplaced geometry.
pub(crate) fn instances_authorable(
    instances: impl IntoIterator<Item = (u32, u32, [f32; 16])>,
    submesh_count: &HashMap<u32, usize>,
) -> bool {
    // `instances_by_id` is keyed by `express_id`, so a repeated id would be overwritten.
    let mut seen_occurrence: HashSet<u32> = HashSet::new();
    instances.into_iter().all(|(express_id, template_id, transform)| {
        // A finite, affine transform (the authored matrix would otherwise misplace it).
        transform_is_affine_finite(&transform)
            // Exactly one record per element id.
            && seen_occurrence.insert(express_id)
            // The occurrence must NOT also own a full mesh: the emitters take the instance
            // branch OR the mesh branch, never both, so a mixed element loses its meshes.
            && !submesh_count.contains_key(&express_id)
            // The prototype is `meshes_by_id[tid].first()`, so the template must resolve to
            // exactly ONE emittable submesh — else `.first()` is an ambiguous prototype for
            // a template element that backs several maps.
            && submesh_count.get(&template_id).copied() == Some(1)
    })
}

/// True when `a` is finite and affine (bottom row ≈ (0,0,0,1)). A projective row would make
/// the authored matrix misplace geometry (the reconstruction divides by w).
pub(crate) fn transform_is_affine_finite(a: &[f32; 16]) -> bool {
    a.iter().all(|v| v.is_finite())
        && a[12].abs() < 1e-6
        && a[13].abs() < 1e-6
        && a[14].abs() < 1e-6
        && (a[15] - 1.0).abs() < 1e-6
}
