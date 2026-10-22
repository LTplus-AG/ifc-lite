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
//! former copies) runs in three phases: `plan` picks the strategy once,
//! `execution` runs and classifies each strategy's router work, and the
//! emitters below present the executed parts (colour, palette, UV/texture,
//! metadata, geometry_class).
//!
//! ```text
//! plan: representation gate (IfcAlignment exempt)
//! ├─ TypeProduct job (#957): render each planned RepresentationMap
//! │    (textures #961, geometry_class tag, styled-item colour)
//! └─ Product job:
//!    ├─ has openings → submesh-aware void cut (per-part colours survive)
//!    ├─ else        → submesh path for ALL types (per-item colours,
//!    │                per-item error skipping, #858 palette split per item)
//!    └─ execution fallback chain when the submesh path produced nothing:
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

/// The f32-collapse degenerate backstop, its per-element tally, and the reason
/// that tally now gates the closure verdict. A CHILD module: it exists only to
/// serve this file's produce/emit cycle.
#[path = "element_degenerate.rs"]
mod degenerate;
#[path = "element_scopes.rs"]
mod element_scopes;
mod element_color;
use element_color::{find_indexed_colour_for_element, infer_opening_subpart_material_name};
// Re-exported because they have callers outside this module: the colour
// resolvers from processor/, the style-source walks from style::finish_join.
pub(crate) use element_color::{find_geometry_item_color, resolve_color_for_representation_map};
pub(crate) use element_color::{find_geometry_item_style_source, product_shape_style_source, representation_map_style_source};

mod types;
pub use types::*;
mod plan;
pub use plan::plan_type_geometry;
mod execution;
use execution::TypePart;

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
    // The element's budget, degenerate tally and pending reports are one owned
    // state, installed for this synchronous call and restored on return or
    // unwind: a rayon work-steal can run another element to completion inside
    // this one.
    element_scopes::ElementScopes::new()
        .with_scope(|| produce_in_scope(job, ctx, opts, decoder, router))
}

fn produce_in_scope(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ProducedElementMeshes {
    ifc_lite_geometry::progress::tick();

    let mut hasher = match (&job.kind, opts.geometry_hash) {
        (ElementJobKind::Product, Some(cfg)) => {
            Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc))
        }
        _ => None,
    };

    // #858 splits a colour-mapped face set by triangle index, so its triangles
    // must keep their order through source hygiene (#5313).
    let keep_order = !ctx.indexed_colour_full.is_empty()
        && element_color::element_reaches_indexed_colour(job.entity, ctx.indexed_colour_full, decoder);
    let previous_order = router.set_preserve_triangle_order(keep_order);
    let plan = plan::plan_element(job, ctx, decoder, router);
    let (mut meshes, mut instance_occurrences) =
        execution::execute(plan, job, ctx, decoder, router, &mut hasher);
    router.set_preserve_triangle_order(previous_order);

    // A class with a fixed display colour (openings, #5409) overrides whatever
    // colour the style precedence resolved, on every mesh AND every don't-bake
    // occurrence, so no path (sub-mesh, palette split, fallback) can leak one.
    if let Some(fixed) = crate::style::fixed_display_color_for_type(&job.ifc_type) {
        let fixed = fixed.to_array();
        for mesh in &mut meshes {
            mesh.color = fixed;
            mesh.texture = None;
            mesh.uvs = None;
        }
        for occurrence in &mut instance_occurrences {
            occurrence.color = fixed;
        }
    }

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

/// Emit one assembled fallback body (a single frame part): outward winding,
/// the #858 indexed-colour split when it still applies, else one mesh.
fn emit_fallback_mesh(
    job: &ElementMeshJob<'_>,
    mut mesh: Mesh,
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
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
                    return out;
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
    vec![build_mesh_data(job, mesh, element_color, None, None, false, 0, ctx, None)]
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

/// Present one executed type map's parts (#957/#961), each mesh tagged with
/// its planned geometry_class. The map's style colour is resolved once, after
/// the map's own geometry ran.
fn emit_type_parts(
    job: &ElementMeshJob<'_>,
    rep_map_id: u32,
    geometry_class: u8,
    parts: Vec<TypePart>,
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
) -> Vec<MeshData> {
    let color = resolve_color_for_representation_map(rep_map_id, ctx.geometry_style_index, decoder)
        .unwrap_or(element_color);
    let mut out: Vec<MeshData> = Vec::new();
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
    out
}

#[path = "element_mesh_build.rs"]
mod element_mesh_build;
use element_mesh_build::build_mesh_data;

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;

#[cfg(test)]
mod phase_tests;
