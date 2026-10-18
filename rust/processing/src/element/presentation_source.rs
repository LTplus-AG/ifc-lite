// SPDX-License-Identifier: MPL-2.0
//! Reached presentation source admission, inside validated product acceptance.
//! Each part is admitted and assembled before the next part is inspected.
use super::presentation::{
    assemble, HashPolicy, Palette, ReadyBody, ReadyPart, ReadyPresentation, SourceId,
};
use super::*;
use std::sync::Arc;

#[allow(clippy::too_many_arguments)] // existing accepted work boundary
pub(super) fn submeshes(
    job: &AssemblyJob<'_>,
    collection: SubMeshCollection,
    fallback: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
    class: u8,
    shared: Option<&Arc<OwnedMeshProductionContext>>,
) -> (Vec<MeshData>, Vec<RawInstanceOccurrence>) {
    let materials = ctx.element_material_colors.get(&job.id).map(Vec::as_slice);
    let mut next_material = 0;
    let mut meshes = Vec::with_capacity(collection.len());
    let mut occurrences = Vec::new();
    let ids_are_materials = collection.ids_are_materials;
    for sub in collection.sub_meshes {
        let source = SourceId::collection(sub.geometry_id, ids_are_materials);
        let mut mesh = sub.mesh;
        if mesh.is_empty() {
            // Empty noninstances do not query source or advance the cursor.
            if let Some(meta) = mesh.instance_meta.filter(|meta| meta.instanceable) {
                let (color, _) = color(
                    job,
                    sub.geometry_id,
                    fallback,
                    materials,
                    &mut next_material,
                    ctx,
                    decoder,
                    false,
                );
                let (_, occurrence) = assemble(
                    ReadyPresentation::new(
                        ReadyPart::Instance {
                            meta,
                            color,
                            source,
                        },
                        job,
                        ctx.site_local_rotation,
                        shared,
                    ),
                    hasher,
                );
                occurrences.extend(occurrence);
            }
            continue;
        }
        // This preparation MUST precede direct/mapped source admission.
        let verdict = orient_mesh_outward_verdict(&mut mesh);
        if verdict.flipped || mesh.normals.len() != mesh.positions.len() {
            calculate_normals(&mut mesh);
        }
        let (color, material_name) = color(
            job,
            sub.geometry_id,
            fallback,
            materials,
            &mut next_material,
            ctx,
            decoder,
            true,
        );
        // Immutable numerical palette resource only: no lookup until the
        // evaluator has hashed and rejected the UV/texture path.
        let palette = Some(Palette::admitted(
            sub.geometry_id,
            ctx.indexed_colour_full,
            shared,
        ));
        let ready = ReadyPart::Body(ReadyBody {
            mesh,
            color,
            material_name,
            source,
            class,
            uvs: sub.uvs,
            texture: sub.texture,
            palette,
            palette_source: source,
            hash: HashPolicy::Submesh(verdict),
        });
        let (parts, _) = assemble(
            ReadyPresentation::new(ready, job, ctx.site_local_rotation, shared),
            hasher,
        );
        meshes.extend(parts);
    }
    (meshes, occurrences)
}

#[allow(clippy::too_many_arguments)] // canonical precedence and one collection cursor
fn color(
    job: &AssemblyJob<'_>,
    id: u32,
    fallback: [f32; 4],
    materials: Option<&[[f32; 4]]>,
    next: &mut usize,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    material_name: bool,
) -> ([f32; 4], Option<String>) {
    let style = ctx.geometry_style_index.get(&id);
    let direct = style
        .map(|style| style.color)
        .or_else(|| find_geometry_item_color(id, ctx.geometry_style_index, decoder));
    let color = crate::style::resolve_submesh_color(direct, materials, next, fallback);
    let name = if material_name {
        style
            .and_then(|style| style.material_name.as_ref())
            .map(ToString::to_string)
            .or_else(|| infer_opening_subpart_material_name(&job.ifc_type, color, id))
    } else {
        None
    };
    (color, name)
}

#[allow(clippy::too_many_arguments)] // separate source entity from assembly identity
pub(super) fn fallback(
    job: &AssemblyJob<'_>,
    entity: &DecodedEntity,
    mut mesh: Mesh,
    color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
    shared: Option<&Arc<OwnedMeshProductionContext>>,
) -> Vec<MeshData> {
    let verdict = orient_mesh_outward_verdict(&mut mesh);
    if verdict.flipped {
        calculate_normals(&mut mesh);
    }
    // Only the historically reached representation walk reads source, after
    // winding/flip repair. A changed triangle count still rejects in numerics.
    let selected = if ctx.indexed_colour_full.is_empty() {
        None
    } else {
        find_indexed_colour_for_element(entity, ctx.indexed_colour_full, decoder)
    };
    let palette_source = selected.map_or(SourceId::None, |(_, full)| {
        SourceId::Geometry(full.geometry_id)
    });
    let palette = selected.map(|(key, _)| Palette::admitted(key, ctx.indexed_colour_full, shared));
    let ready = ReadyPart::Body(ReadyBody {
        mesh,
        color,
        material_name: None,
        source: SourceId::None,
        class: 0,
        uvs: None,
        texture: None,
        palette,
        palette_source,
        hash: HashPolicy::Fallback(verdict),
    });
    assemble(
        ReadyPresentation::new(ready, job, ctx.site_local_rotation, shared),
        hasher,
    )
    .0
}

pub(super) fn type_parts(
    job: &AssemblyJob<'_>,
    map_and_class: (u32, u8),
    parts: Vec<super::assembly_types::TypePart>,
    fallback: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    shared: Option<&Arc<OwnedMeshProductionContext>>,
) -> Vec<MeshData> {
    let (map, class) = map_and_class;
    // Exactly once, even if every executed part is empty.
    let color = resolve_color_for_representation_map(map, ctx.geometry_style_index, decoder)
        .unwrap_or(fallback);
    let mut out = Vec::new();
    for (mesh, uvs, texture) in parts {
        if mesh.is_empty() {
            continue;
        }
        let ready = super::assembly_types::ready_type_part(mesh, uvs, texture, color, class);
        out.extend(
            assemble(
                ReadyPresentation::new(ready, job, ctx.site_local_rotation, shared),
                &mut None,
            )
            .0,
        );
    }
    out
}
