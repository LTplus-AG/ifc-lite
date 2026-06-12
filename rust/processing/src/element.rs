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
use crate::types::mesh::{MeshData, MeshTextureData};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::{
    calculate_normals, BoolFailure, GeometryHasher, GeometryRouter, Mesh, ResolvedTextureMap,
    SubMeshCollection,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;

use crate::processor::{convert_mesh_to_site_local, get_refs_from_list};

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
    /// Per-ELEMENT fingerprint, accumulated across all of the element's
    /// meshes in the native IFC frame (pre-split, pre-site-rotation).
    /// `None` when hashing is off, nothing was produced, or the job is a
    /// TypeProduct.
    pub geometry_hash: Option<u64>,
    /// CSG diagnostics recorded while producing THIS element, attributed by
    /// product id. The router is fully drained on return, so a warm router
    /// reused across a batch never leaks one element's failures into the
    /// next. Failures from a superseded strategy (a fallback re-attempting
    /// the same cuts) are discarded — only the path that produced the
    /// returned meshes contributes.
    pub csg_failures: FxHashMap<u32, Vec<BoolFailure>>,
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
    let mut hasher = match (&job.kind, opts.geometry_hash) {
        (ElementJobKind::Product, Some(cfg)) => {
            Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc))
        }
        _ => None,
    };

    let meshes = produce_inner(job, ctx, decoder, router, &mut hasher);

    // Drain the router's per-element CSG diagnostics on EVERY return path so
    // a warm (batch-reused) router starts the next element clean.
    let csg_failures = router.take_csg_failures();

    let geometry_hash = hasher.and_then(|h| if h.is_empty() { None } else { Some(h.finish()) });

    ProducedElementMeshes {
        meshes,
        geometry_hash,
        csg_failures,
    }
}

fn produce_inner(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    // Representation gate, with the IfcAlignment exception: alignments carry
    // their geometry on IfcAlignment*Segment children, so a null
    // Representation attribute does not mean "nothing to render".
    let has_representation = job.entity.get(6).is_some_and(|a| !a.is_null());
    if !has_representation && job.ifc_type != IfcType::IfcAlignment {
        return Vec::new();
    }

    let element_color = job
        .element_color
        .unwrap_or_else(|| crate::style::default_color_for_type(job.ifc_type).to_array());

    if let ElementJobKind::TypeProduct { rep_maps } = &job.kind {
        return produce_type_geometry(job, rep_maps, element_color, ctx, decoder, router);
    }

    let has_openings = ctx
        .void_index
        .get(&job.id)
        .is_some_and(|openings| !openings.is_empty());

    if has_openings {
        // Voided elements: submesh-aware cut FIRST, so per-part colours
        // survive the void subtraction (a voided window keeps frame/glass
        // split; a voided multi-layer wall keeps its layer colours).
        if let Ok(sub_meshes) =
            router.process_element_with_submeshes_and_voids(job.entity, decoder, ctx.void_index)
        {
            if !sub_meshes.is_empty() {
                let out = emit_sub_meshes(job, sub_meshes, element_color, ctx, decoder, hasher);
                if !out.is_empty() {
                    return out;
                }
            }
        }
    } else {
        // Submesh path for ALL types: per-geometry-item colours (window glass
        // transparency, multi-material doors) and per-item error skipping —
        // one unsupported representation item no longer blanks the whole
        // element (`process_element` aborts with `?`). #858 palette split
        // happens per item inside `emit_sub_meshes`.
        if let Ok(sub_meshes) = router.process_element_with_submeshes(job.entity, decoder) {
            if !sub_meshes.is_empty() {
                let out = emit_sub_meshes(job, sub_meshes, element_color, ctx, decoder, hasher);
                if !out.is_empty() {
                    return out;
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
        Some(mesh) => mesh.is_empty(),
        None => true,
    };
    if needs_fallback {
        mesh_candidate = router.process_element(job.entity, decoder).ok();
    }

    let Some(mut mesh) = mesh_candidate else {
        return Vec::new();
    };
    if mesh.is_empty() {
        return Vec::new();
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
                    h.add_mesh(&mesh.positions, &mesh.indices);
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
                        0,
                        ctx,
                    ));
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }

    if mesh.normals.len() != mesh.positions.len() {
        calculate_normals(&mut mesh);
    }
    if let Some(h) = hasher.as_mut() {
        h.add_mesh(&mesh.positions, &mesh.indices);
    }
    vec![build_mesh_data(job, mesh, element_color, None, None, 0, ctx)]
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
) -> Vec<MeshData> {
    let mut out: Vec<MeshData> = Vec::with_capacity(sub_meshes.len());
    // Material colours for this element, used when a sub-mesh has no direct
    // style — alternated so frame (opaque) and glazing (transparent) split
    // across the window's parts (#913 §2.3).
    let material_colors = ctx.element_material_colors.get(&job.id);
    let mut mat_color_idx = 0usize;

    for sub in sub_meshes.sub_meshes {
        let mut sub_mesh = sub.mesh;
        if sub_mesh.is_empty() {
            continue;
        }
        if sub_mesh.normals.len() != sub_mesh.positions.len() {
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
            h.add_mesh(&sub_mesh.positions, &sub_mesh.indices);
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
                        0,
                        ctx,
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
            0,
            ctx,
        ));
    }
    out
}

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
            let mut mesh_data =
                build_mesh_data(job, mesh, color, None, None, geometry_class, ctx);
            if let Some(tex) = texture {
                mesh_data = mesh_data.with_texture(
                    uvs,
                    MeshTextureData {
                        rgba: tex.rgba,
                        width: tex.width,
                        height: tex.height,
                        repeat_s: tex.repeat_s,
                        repeat_t: tex.repeat_t,
                    },
                );
            }
            out.push(mesh_data);
        }
    }
    out
}

/// Construct the final [`MeshData`]: metadata stamp, style metadata,
/// geometry-class tag, and the optional site-local rotation. ALWAYS the last
/// step — geometry hashing happens before this (native IFC frame).
fn build_mesh_data(
    job: &ElementMeshJob<'_>,
    mesh: Mesh,
    color: [f32; 4],
    material_name: Option<String>,
    geometry_item_id: Option<u32>,
    geometry_class: u8,
    ctx: &MeshProductionContext<'_>,
) -> MeshData {
    let mut mesh_data = MeshData::new(
        job.id,
        job.ifc_type.name().to_string(),
        mesh.positions,
        mesh.normals,
        mesh.indices,
        color,
    );
    if let Some(meta) = job.metadata {
        mesh_data = mesh_data
            .with_element_metadata(
                meta.global_id.clone(),
                meta.name.clone(),
                meta.presentation_layer.clone(),
            )
            .with_properties(meta.space_zone_properties.clone());
    }
    if material_name.is_some() || geometry_item_id.is_some() {
        mesh_data = mesh_data.with_style_metadata(material_name, geometry_item_id);
    }
    if geometry_class != 0 {
        mesh_data = mesh_data.with_geometry_class(geometry_class);
    }
    convert_mesh_to_site_local(&mut mesh_data, ctx.site_local_rotation);
    mesh_data
}

/// Resolve a geometry item's authored colour: direct style on the item, else
/// chase `IfcMappedItem → IfcRepresentationMap → MappedRepresentation.Items`
/// recursively (#913 §2.7 — mapped sub-geometry inherits its underlying
/// item's style).
pub(crate) fn find_geometry_item_color(
    geometry_id: u32,
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // Direct style on this exact geometry item wins.
    if let Some(style) = geometry_styles.get(&geometry_id) {
        return Some(style.color);
    }

    // Otherwise, if it's a mapped item, chase the mapping to the underlying
    // geometry and resolve there (recursing handles nested mapped items).
    let geom = decoder.decode_by_id(geometry_id).ok()?;
    if geom.ifc_type != IfcType::IfcMappedItem {
        return None;
    }
    // IfcMappedItem.MappingSource (attr 0) → IfcRepresentationMap.
    let mapping_source_id = geom.get_ref(0)?;
    // IfcRepresentationMap.MappedRepresentation (attr 1) → IfcShapeRepresentation.
    let representation_map = decoder.decode_by_id(mapping_source_id).ok()?;
    let mapped_representation_id = representation_map.get_ref(1)?;
    let mapped_representation = decoder.decode_by_id(mapped_representation_id).ok()?;
    // IfcShapeRepresentation.Items (attr 3).
    let items = get_refs_from_list(&mapped_representation, 3)?;
    for underlying in items {
        if let Some(color) = find_geometry_item_color(underlying, geometry_styles, decoder) {
            return Some(color);
        }
    }
    None
}

/// Resolve the authored colour for a type's `IfcRepresentationMap` (#957) by
/// looking up its mapped geometry items in the styled-item index — the same
/// index that colours ordinary products. `None` ⇒ caller falls back to the
/// type's default colour.
pub(crate) fn resolve_color_for_representation_map(
    rep_map_id: u32,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let rep_map = decoder.decode_by_id(rep_map_id).ok()?;
    // IfcRepresentationMap.MappedRepresentation = attr 1.
    let mapped_rep_id = rep_map.get_ref(1)?;
    let mapped_rep = decoder.decode_by_id(mapped_rep_id).ok()?;
    // IfcShapeRepresentation.Items = attr 3.
    let item_ids = get_refs_from_list(&mapped_rep, 3)?;
    for item_id in item_ids {
        if let Some(style) = geometry_style_index.get(&item_id) {
            return Some(style.color);
        }
        if let Some(color) = find_geometry_item_color(item_id, geometry_style_index, decoder) {
            return Some(color);
        }
    }
    None
}

/// Find the first representation item of `entity` that carries a full
/// `IfcIndexedColourMap` (#858). Drives the element-level palette split on
/// the single-mesh fallback path.
pub(crate) fn find_indexed_colour_for_element<'a>(
    entity: &DecodedEntity,
    indexed_colour_full: &'a FxHashMap<u32, FullIndexedColourMap>,
    decoder: &mut EntityDecoder,
) -> Option<&'a FullIndexedColourMap> {
    let pds_id = entity.get_ref(6)?;
    let pds = decoder.decode_by_id(pds_id).ok()?;
    let repr_ids = get_refs_from_list(&pds, 2)?;
    for repr_id in repr_ids {
        if let Ok(repr) = decoder.decode_by_id(repr_id) {
            if let Some(items) = get_refs_from_list(&repr, 3) {
                for item_id in items {
                    if let Some(full) = indexed_colour_full.get(&item_id) {
                        return Some(full);
                    }
                }
            }
        }
    }
    None
}

fn is_opening_with_subparts(ifc_type: &IfcType) -> bool {
    matches!(ifc_type, IfcType::IfcWindow | IfcType::IfcDoor)
}

/// Synthesize a material name for window/door sub-parts that carry no
/// authored style: transparency is a practical proxy for glazing in many BIM
/// exports.
pub(crate) fn infer_opening_subpart_material_name(
    ifc_type: &IfcType,
    color: [f32; 4],
    geometry_id: u32,
) -> Option<String> {
    if !is_opening_with_subparts(ifc_type) {
        return None;
    }

    let prefix = match ifc_type {
        IfcType::IfcDoor => "Door",
        _ => "Window",
    };

    if color[3] <= 0.65 {
        return Some(format!("{}_Glass", prefix));
    }

    Some(format!("{}_Frame_{}", prefix, geometry_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(ids: &[u32]) -> FxHashSet<u32> {
        ids.iter().copied().collect()
    }

    #[test]
    fn plan_type_geometry_orphan_type_emits_unreferenced_maps_as_class_1() {
        for mode in [TypeGeometryMode::SuppressInstanced, TypeGeometryMode::EmitTagged] {
            let planned = plan_type_geometry(&[10, 11, 12], &refs(&[11]), false, mode);
            assert_eq!(
                planned,
                vec![(10, 1), (12, 1)],
                "orphan type: unreferenced maps render as class 1 in {mode:?}",
            );
        }
    }

    #[test]
    fn plan_type_geometry_instantiated_type_suppressed_for_export_tagged_for_viewer() {
        let suppress = plan_type_geometry(
            &[10, 11],
            &refs(&[]),
            true,
            TypeGeometryMode::SuppressInstanced,
        );
        assert!(
            suppress.is_empty(),
            "an export must never duplicate an instanced type's geometry"
        );

        let tagged =
            plan_type_geometry(&[10, 11], &refs(&[]), true, TypeGeometryMode::EmitTagged);
        assert_eq!(
            tagged,
            vec![(10, 2), (11, 2)],
            "the viewer renders instanced type maps tagged class 2 for the Types view"
        );
    }

    #[test]
    fn plan_type_geometry_referenced_maps_never_emit() {
        let planned = plan_type_geometry(
            &[10],
            &refs(&[10]),
            false,
            TypeGeometryMode::EmitTagged,
        );
        assert!(
            planned.is_empty(),
            "a map an IfcMappedItem instantiates draws through its occurrence"
        );
    }

    #[test]
    fn find_geometry_item_color_follows_mapped_item() {
        // #100 IfcMappedItem → #101 IfcRepresentationMap → #103
        // IfcShapeRepresentation whose Items = (#110). The style lives on the
        // underlying item #110, not on the mapped item, so a flat lookup of
        // #100 misses it — the resolver must chase the mapping (#913 §2.7).
        const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#100=IFCMAPPEDITEM(#101,#105);
#101=IFCREPRESENTATIONMAP(#102,#103);
#102=IFCAXIS2PLACEMENT3D(#104,$,$);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#110));
#104=IFCCARTESIANPOINT((0.,0.,0.));
#105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#104,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let blue = [0.1, 0.2, 0.9, 1.0];
        let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
        styles.insert(110, GeometryStyleInfo::from_color(blue));

        let mut decoder = EntityDecoder::new(IFC);

        // Mapped item, no direct style → inherits the underlying item's colour.
        assert_eq!(find_geometry_item_color(100, &styles, &mut decoder), Some(blue));
        // A direct style still wins.
        assert_eq!(find_geometry_item_color(110, &styles, &mut decoder), Some(blue));
        // A non-mapped, unstyled item (the representation map itself) → None.
        assert_eq!(find_geometry_item_color(101, &styles, &mut decoder), None);
    }

    #[test]
    fn infer_opening_material_names_glass_vs_frame() {
        let glass =
            infer_opening_subpart_material_name(&IfcType::IfcWindow, [0.7, 0.9, 0.5, 0.3], 42);
        assert_eq!(glass.as_deref(), Some("Window_Glass"));

        let frame =
            infer_opening_subpart_material_name(&IfcType::IfcDoor, [0.5, 0.5, 0.5, 1.0], 7);
        assert_eq!(frame.as_deref(), Some("Door_Frame_7"));

        let none = infer_opening_subpart_material_name(&IfcType::IfcWall, [1.0; 4], 1);
        assert!(none.is_none(), "only windows/doors get inferred part names");
    }
}
