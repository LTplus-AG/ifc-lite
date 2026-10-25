// SPDX-License-Identifier: MPL-2.0
//! Decoder-free numerical presentation of one admitted body or occurrence.
use super::presentation::{FaceCorrespondence, HashPolicy, ReadyBody, SourceId};
use super::{build_mesh_data, AssemblyJob, MeshData, MeshTextureData, RawInstanceOccurrence};
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, TextureBinding,
    UvAuthority,
};
use ifc_lite_geometry::{
    calculate_normals, compose_instance_world_row_major, GeometryHasher, InstanceMeta, Mesh,
};

/// The one body funnel: UV/texture, then the #858 palette split, then one
/// plain mesh. Hashing happens where the body's [`HashPolicy`] says.
pub(super) fn emit_body(
    mut body: ReadyBody<'_>,
    job: &AssemblyJob<'_>,
    rotation: Option<&Vec<f64>>,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    if let HashPolicy::Submesh(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
        }
    }
    // Resolved once, before any branch consumes the body; source-free.
    let palette = body.palette.as_ref().and_then(|palette| palette.get());
    let record = job.provenance().then(|| Record::new(&body, palette));
    // Textured face set (#1781/#961): the UVs ride the source weld (1:1 with
    // positions, seams stay split) and the texture is attached. An occurrence
    // drops the texture instead of sampling garbage if any upstream step
    // rebuilt vertices without the UV channel; a type map selects the channel
    // by texture presence alone, as it always has.
    let texture_valid = body.texture.is_some()
        && match body.hash {
            HashPolicy::Submesh(_) => body
                .uvs
                .as_ref()
                .is_some_and(|uvs| uvs.len() / 2 == body.mesh.positions.len() / 3),
            _ => true,
        };
    if texture_valid {
        let mut data = build(
            job,
            body.mesh,
            body.color,
            body.material_name,
            body.source,
            body.class,
            rotation,
            body.uvs,
        );
        data.texture = body.texture.as_ref().map(MeshTextureData::from_attachment);
        data.presentation = record.map(|record| Box::new(record.textured()));
        return vec![data];
    }
    // An invalid or missing texture drops its UV channel before palette or
    // plain assembly, exactly as the historical guard did.
    body.uvs = None;
    // #858: a face set with a per-triangle colour map splits into one mesh per
    // palette group (the splitter guards: triangle count must still match, at
    // least two distinct colours). Palette colours supersede the style colour.
    if let Some(full) = palette {
        if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&body.mesh, full) {
            if let HashPolicy::Fallback(verdict) = body.hash {
                // The split only partitions triangles; the un-split body's
                // verdict is the one that describes this hashed buffer.
                if let Some(h) = hasher.as_mut() {
                    h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
                }
            }
            let record = record.map(|record| record.untextured(body.normals));
            return super::assembly_fallback::emit_palette(groups, job, body.palette_source, body.class, rotation, record);
        }
    }
    let mut normals = body.normals;
    if body.mesh.normals.len() != body.mesh.positions.len() {
        calculate_normals(&mut body.mesh);
        normals = NormalProvenance::RecomputedMissing;
    }
    if let HashPolicy::Fallback(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
        }
    }
    let color = body.color;
    let mut data = build(
        job,
        body.mesh,
        color,
        body.material_name,
        body.source,
        body.class,
        rotation,
        body.uvs,
    );
    data.presentation = record.map(|record| Box::new(record.untextured(normals).unsplit(color)));
    vec![data]
}

/// The provenance under construction for one body (#7955 J5), taken before
/// the funnel consumes it. Everything here was resolved by source admission.
#[derive(Clone, Copy)]
pub(super) struct Record<'a> {
    normals: NormalProvenance,
    palette: Option<&'a crate::style::FullIndexedColourMap>,
    texture: Option<TextureBinding>,
    /// Why the palette cannot bind this body, or `None` when it can.
    palette_gap: Option<PaletteAbsence>,
}

impl<'a> Record<'a> {
    fn new(body: &ReadyBody<'a>, palette: Option<&'a crate::style::FullIndexedColourMap>) -> Self {
        let triangles = body.mesh.indices.len() / 3;
        let face_set_id = match body.source {
            SourceId::Geometry(id) => Some(id),
            SourceId::None | SourceId::Material(_) => None,
        };
        let texture = body.texture.as_ref().map(|texture| TextureBinding {
            texture_id: texture.texture_id,
            face_set_id,
            uv_authority: body.uv_authority.unwrap_or(UvAuthority::UnknownMap),
        });
        Self {
            normals: body.normals,
            palette,
            texture,
            palette_gap: palette.and_then(|full| palette_gap(full, triangles, body.faces)),
        }
    }

    /// The texture won: the palette, if any, was superseded.
    fn textured(self) -> MeshPresentationProvenance {
        MeshPresentationProvenance {
            normals: self.normals,
            palette: self.palette.map(|full| PaletteBinding::Absent {
                map_id: full.map_id,
                reason: PaletteAbsence::SupersededByTexture,
            }),
            texture: self.texture,
        }
    }

    /// The mesh ships untextured: a texture the source bound was dropped with
    /// its UV channel. The palette is resolved by the caller.
    fn untextured(mut self, normals: NormalProvenance) -> Self {
        self.normals = normals;
        if let Some(texture) = self.texture.as_mut() {
            texture.uv_authority = UvAuthority::Dropped;
        }
        self
    }

    pub(super) fn with_normals(mut self, normals: NormalProvenance) -> Self {
        self.normals = normals;
        self
    }

    /// One palette group: bound only when the map is verbatim and the body
    /// is proven to be its face set triangle for triangle.
    pub(super) fn split_part(self, palette_index: usize) -> MeshPresentationProvenance {
        let palette = self.palette.map(|full| match self.palette_gap {
            None => PaletteBinding::Bound {
                map_id: full.map_id,
                face_set_id: full.geometry_id,
                palette_index: palette_index as u32,
            },
            Some(reason) => PaletteBinding::Absent { map_id: full.map_id, reason },
        });
        MeshPresentationProvenance { normals: self.normals, palette, texture: self.texture }
    }

    /// The body reached a map but was not split: bound only when it is proven
    /// to be the face set and every triangle uses one verbatim entry whose
    /// colour is the one displayed.
    fn unsplit(self, color: [f32; 4]) -> MeshPresentationProvenance {
        let palette = self.palette.map(|full| {
            let reason = if let Some(reason) = self.palette_gap {
                reason
            } else {
                let index = full.triangle_palette.first().copied().unwrap_or(0);
                if full.colours.get(index).is_some_and(|c| c.to_array() == color) {
                    return PaletteBinding::Bound {
                        map_id: full.map_id,
                        face_set_id: full.geometry_id,
                        palette_index: index as u32,
                    };
                }
                PaletteAbsence::StyleOverride
            };
            PaletteBinding::Absent { map_id: full.map_id, reason }
        });
        MeshPresentationProvenance { normals: self.normals, palette, texture: self.texture }
    }
}

/// Why `full` cannot bind a body of `triangles` triangles, or `None` when the
/// body is proven to be its face set row for row.
fn palette_gap(full: &crate::style::FullIndexedColourMap, triangles: usize, faces: FaceCorrespondence) -> Option<PaletteAbsence> {
    if !full.authentic {
        return Some(PaletteAbsence::Malformed);
    }
    match faces {
        FaceCorrespondence::Triangulated(rows) if rows == triangles && triangles == full.triangle_palette.len() => None,
        FaceCorrespondence::Unproven if triangles == full.triangle_palette.len() => Some(PaletteAbsence::Unproven),
        _ => Some(PaletteAbsence::Retopologized),
    }
}

#[allow(clippy::too_many_arguments)] // the resolved last-funnel fields
pub(super) fn build(
    job: &AssemblyJob<'_>,
    mesh: Mesh,
    color: [f32; 4],
    material: Option<String>,
    source: SourceId,
    class: u8,
    rotation: Option<&Vec<f64>>,
    uvs: Option<Vec<f32>>,
) -> MeshData {
    let (id, material_id) = source.fields();
    build_mesh_data(job, mesh, color, material, id, material_id, class, rotation, uvs)
}

/// #1623 Phase 2 don't-bake: a non-template occurrence of a shared template.
/// `transform` was folded into `meta.transform` by `apply_submesh_placement`;
/// the full pre-RTC world transform is composed here and the streaming
/// finalize derives the template-relative mat4.
pub(super) fn occurrence(
    job: &AssemblyJob<'_>,
    source: SourceId,
    meta: &InstanceMeta,
    color: [f32; 4],
) -> RawInstanceOccurrence {
    let (id, material_id) = source.fields();
    let metadata = job.metadata();
    RawInstanceOccurrence {
        express_id: job.id,
        ifc_type: job.ifc_type.name().to_string(),
        global_id: metadata.and_then(|m| m.global_id.clone()),
        name: metadata.and_then(|m| m.name.clone()),
        presentation_layer: metadata.and_then(|m| m.presentation_layer.clone()),
        color,
        rep_identity: meta.rep_identity,
        world_transform: compose_instance_world_row_major(meta),
        // #2985: the id `build_mesh_data` would have stamped had this sub-mesh
        // materialized. ONE home for the #3199 discriminator and the 0-filter.
        geometry_item_id: MeshData::style_geometry_item_id(id, material_id),
    }
}
