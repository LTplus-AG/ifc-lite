// SPDX-License-Identifier: MPL-2.0
//! Presentation source admission: the only presentation step that reads
//! source (styles, mapped-item ancestry, material chains, the element's
//! colour-mapped face set). Each part is admitted and assembled before the
//! next part is inspected, so every decoder read keeps its historical order.
use super::assembly_submeshes::{emit_body, occurrence};
use super::assembly_types::{ready_type_part, TypePart};
use super::presentation::{CollectionTopology, FaceCorrespondence, HashPolicy, Palette, ReadyBody, SourceId};
use super::*;
use crate::types::presentation::{NormalProvenance, UvAuthority};

/// A sub-mesh collection: per-item colour through the canonical
/// `resolve_submesh_color` precedence (#913 §4.2), material-name inference for
/// window/door parts, the #858 per-item palette split, UV/texture, and the
/// #1623 don't-bake occurrences. `class` is stamped on every emitted sub-mesh:
/// 0 for occurrence geometry, [`GEOM_CLASS_LAYER_SLICE`] for the per-layer
/// slices of a material-layer wall. `topology` is what the executing strategy
/// proves about the parts' triangles; only an uncut collection can bind a
/// palette (#7955 J5).
#[allow(clippy::too_many_arguments)] // the executed collection plus its borrowed inputs
pub(super) fn submeshes(
    job: &AssemblyJob<'_>,
    collection: SubMeshCollection,
    fallback: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
    class: u8,
    topology: CollectionTopology,
) -> (Vec<MeshData>, Vec<RawInstanceOccurrence>) {
    // Material colours for this element, used when a sub-mesh has no direct
    // style; ONE cursor alternates them across the collection so frame
    // (opaque) and glazing (transparent) split across a window's parts.
    let materials = ctx.element_material_colors.get(&job.id).map(Vec::as_slice);
    let mut next_material = 0;
    let mut meshes = Vec::with_capacity(collection.len());
    let mut occurrences = Vec::new();
    // What the ids MEAN is a property of the collection (#3199).
    let ids_are_materials = collection.ids_are_materials;
    for sub in collection.sub_meshes {
        let source = SourceId::collection(sub.geometry_id, ids_are_materials);
        let mut mesh = sub.mesh;
        if mesh.is_empty() {
            // An EMPTY sub-mesh with instanceable InstanceMeta is a don't-bake
            // occurrence, coloured exactly as its materialized twin would be.
            // Empty non-instances read no source and do not advance the cursor.
            if let Some(meta) = mesh.instance_meta.as_ref().filter(|meta| meta.instanceable) {
                let (color, _) =
                    color(job, sub.geometry_id, fallback, materials, &mut next_material, ctx, decoder, false);
                occurrences.push(occurrence(job, source, meta, color));
            }
            continue;
        }
        // Consistently outward-wind each sub-body; a flip invalidates baked
        // normals. The verdict is per SUB-BODY, the hasher's segment
        // granularity. This MUST precede direct/mapped source admission.
        let verdict = orient_mesh_outward_verdict(&mut mesh);
        let normals = recompute_reason(&mesh, verdict.flipped);
        if normals != NormalProvenance::Producer {
            calculate_normals(&mut mesh);
        }
        let (color, material_name) =
            color(job, sub.geometry_id, fallback, materials, &mut next_material, ctx, decoder, true);
        // #7955 J5: judged from source here, so the funnel stays source-free.
        let uv_authority =
            (job.provenance() && sub.texture.is_some()).then(|| judge_uv_authority(sub.geometry_id, ctx, decoder));
        // A void cut can rebuild a part yet keep its triangle count, so only
        // a collection proven uncut reads the face set's row count.
        let mapped = job.provenance() && ctx.indexed_colour_full.contains_key(&sub.geometry_id);
        let faces = match (topology, mapped) {
            (CollectionTopology::ItemsUncut, true) => face_correspondence(sub.geometry_id, decoder),
            _ => FaceCorrespondence::Unproven,
        };
        let body = ReadyBody {
            mesh,
            color,
            material_name,
            source,
            class,
            uvs: sub.uvs,
            texture: sub.texture,
            palette: Some(Palette {
                maps: ctx.indexed_colour_full,
                key: sub.geometry_id,
            }),
            palette_source: source,
            hash: HashPolicy::Submesh(verdict),
            normals,
            uv_authority,
            faces,
        };
        meshes.extend(emit_body(body, job, ctx.site_local_rotation, hasher));
    }
    (meshes, occurrences)
}

/// How far a textured part's UVs are the source's (#7955 J5), judged on the
/// face set's source indices by the textured mesher's own predicates, so a
/// triangle the mesher dropped does not shift which row is judged. Read only
/// when provenance is recorded.
fn judge_uv_authority(geometry_id: u32, ctx: &MeshProductionContext<'_>, decoder: &mut EntityDecoder) -> UvAuthority {
    let Some(map) = ctx.texture_index.get(&geometry_id) else { return UvAuthority::UnknownMap };
    let Ok(face_set) = decoder.decode_by_id(geometry_id) else { return UvAuthority::UnknownMap };
    let fabricated = ifc_lite_geometry::TriangulatedFaceSetProcessor::fabricated_uv_corners(&face_set, decoder, map);
    crate::types::presentation::uv_authority(map, fabricated)
}

/// The correspondence a per-item body of a collection proven
/// [`CollectionTopology::ItemsUncut`] has with its own face set (#7955 J5),
/// from the face set's type and `CoordIndex` row count. Read only when
/// provenance is recorded and a palette maps the item.
fn face_correspondence(geometry_id: u32, decoder: &mut EntityDecoder) -> FaceCorrespondence {
    let Ok(face_set) = decoder.decode_by_id(geometry_id) else { return FaceCorrespondence::Unproven };
    match face_set.ifc_type {
        IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork => face_set
            .attr(ifc_lite_core::slot::IfcTriangulatedFaceSet::COORD_INDEX)
            .and_then(|rows| rows.as_list())
            .map_or(FaceCorrespondence::Unproven, |rows| FaceCorrespondence::Triangulated(rows.len())),
        IfcType::IfcPolygonalFaceSet => FaceCorrespondence::Polygonal,
        _ => FaceCorrespondence::Unproven,
    }
}

/// Why the submesh funnel must recompute normals, if it must: a winding flip
/// invalidates the producer's normals, and a missing channel has none.
fn recompute_reason(mesh: &Mesh, flipped: bool) -> NormalProvenance {
    if flipped {
        NormalProvenance::RecomputedAfterWindingRepair
    } else if mesh.normals.len() != mesh.positions.len() {
        NormalProvenance::RecomputedMissing
    } else {
        NormalProvenance::Producer
    }
}

/// Direct style wins; else chase IfcMappedItem so mapped sub-geometry
/// inherits its underlying style (#913 §2.7); else the material cursor; else
/// the element colour.
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
            .or_else(|| infer_opening_subpart_material_name(job.ifc_type, color, id))
    } else {
        None
    };
    (color, name)
}

/// One assembled fallback body (a single frame part). Outward winding: a
/// faceted brep or a merged multi-item body can carry MIXED winding that
/// corrupts signed volume and smooth normals; a no-op for consistent bodies.
/// The verdict rides to the hasher: only this pass knows whether the body is a
/// closed orientable solid, which an honest per-element volume needs (#1891).
pub(super) fn fallback(
    job: &AssemblyJob<'_>,
    entity: &DecodedEntity,
    mut mesh: Mesh,
    color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    let verdict = orient_mesh_outward_verdict(&mut mesh);
    // Only a flip recomputes here; a missing channel is repaired, and
    // recorded, further down the funnel.
    let normals = if verdict.flipped {
        calculate_normals(&mut mesh);
        NormalProvenance::RecomputedAfterWindingRepair
    } else {
        NormalProvenance::Producer
    };
    // Multi-colour IfcIndexedColourMap → one mesh per palette group (#858),
    // found by walking the element's representation for the colour-mapped
    // face set, after winding repair. A changed triangle count (CSG/void
    // retopology) still rejects the split in assembly.
    let selected = if ctx.indexed_colour_full.is_empty() {
        None
    } else {
        find_indexed_colour_for_element(entity, ctx.indexed_colour_full, decoder)
    };
    let body = ReadyBody {
        mesh,
        color,
        material_name: None,
        source: SourceId::None,
        class: 0,
        uvs: None,
        texture: None,
        palette_source: selected.map_or(SourceId::None, |(_, full)| SourceId::Geometry(full.geometry_id)),
        palette: selected.map(|(key, _)| Palette {
            maps: ctx.indexed_colour_full,
            key,
        }),
        hash: HashPolicy::Fallback(verdict),
        normals,
        uv_authority: None,
        // A void cut can keep the triangle count, and a merged body holds
        // other items: neither is provably the face set row for row.
        faces: FaceCorrespondence::Unproven,
    };
    emit_body(body, job, ctx.site_local_rotation, hasher)
}

/// One executed type map's parts (#957/#961), each tagged with its planned
/// geometry_class. The map's style colour is resolved once, after the map's
/// own geometry ran. Type maps are never hashed.
pub(super) fn type_parts(
    job: &AssemblyJob<'_>,
    (map, class): (u32, u8),
    parts: Vec<TypePart>,
    fallback: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
) -> Vec<MeshData> {
    let color = resolve_color_for_representation_map(map, ctx.geometry_style_index, decoder).unwrap_or(fallback);
    let mut out = Vec::new();
    for (mesh, uvs, texture) in parts {
        if mesh.is_empty() {
            continue;
        }
        let body = ready_type_part(mesh, uvs, texture, color, class);
        out.extend(emit_body(body, job, ctx.site_local_rotation, &mut None));
    }
    out
}
