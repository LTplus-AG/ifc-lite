// SPDX-License-Identifier: MPL-2.0
//! Per-item presentation, palette/UV handling and instance-only assembly.
use super::*;

/// Emit a sub-mesh collection: per-item colour resolution through the
/// canonical `resolve_submesh_color` precedence (#913 §4.2), material-name
/// inference for window/door parts, and the #858 per-item palette split.
pub(super) fn emit_sub_meshes(
    job: &AssemblyJob<'_>,
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
    let mut colors = SubmeshColors::for_element(ctx, job.id, element_color);

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
                let direct_color = style.map(|style| style.color).or_else(|| {
                    find_geometry_item_color(sub.geometry_id, ctx.geometry_style_index, decoder)
                });
                let color = colors.resolve(direct_color);
                occurrences.push(occurrence(
                    job,
                    sub.geometry_id,
                    ids_are_materials,
                    im,
                    color,
                ));
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
        let color = colors.resolve(direct_color);
        let material_name = style
            .and_then(|s| s.material_name.as_ref())
            .map(ToString::to_string)
            .or_else(|| infer_opening_subpart_material_name(job.ifc_type, color, sub.geometry_id));

        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(
                &sub_mesh.positions,
                &sub_mesh.indices,
                sub_mesh.origin,
                verdict,
            );
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

fn occurrence(
    job: &AssemblyJob<'_>,
    geometry_id: u32,
    ids_are_materials: bool,
    im: &ifc_lite_geometry::InstanceMeta,
    color: [f32; 4],
) -> RawInstanceOccurrence {
    RawInstanceOccurrence {
        express_id: job.id,
        ifc_type: job.ifc_type.name().to_string(),
        global_id: job.metadata.and_then(|metadata| metadata.global_id.clone()),
        name: job.metadata.and_then(|metadata| metadata.name.clone()),
        presentation_layer: job
            .metadata
            .and_then(|metadata| metadata.presentation_layer.clone()),
        color,
        rep_identity: im.rep_identity,
        world_transform: compose_instance_world_row_major(im),
        // The same item/material discriminator used by materialized assembly.
        geometry_item_id: MeshData::style_geometry_item_id(Some(geometry_id), ids_are_materials),
    }
}

/// One material-alternation cursor for both materialized and instance-only
/// pieces, in their original collection order.
struct SubmeshColors<'a> {
    materials: Option<&'a [[f32; 4]]>,
    fallback: [f32; 4],
    next_material: usize,
}
impl<'a> SubmeshColors<'a> {
    fn for_element(ctx: &'a MeshProductionContext<'_>, id: u32, fallback: [f32; 4]) -> Self {
        Self {
            materials: ctx
                .element_material_colors
                .get(&id)
                .map(|colors| colors.as_slice()),
            fallback,
            next_material: 0,
        }
    }

    fn resolve(&mut self, direct: Option<[f32; 4]>) -> [f32; 4] {
        crate::style::resolve_submesh_color(
            direct,
            self.materials,
            &mut self.next_material,
            self.fallback,
        )
    }
}
