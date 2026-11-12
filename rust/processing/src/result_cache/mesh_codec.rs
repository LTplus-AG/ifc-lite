// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The TEXTURES, MESHES and INSTANCES sections.
//!
//! Decoded texture pixels are `Arc`-shared across meshes in memory. The
//! TEXTURES section stores each distinct allocation once, in first-use order,
//! and a mesh names its pixels by table index, so a replay rebuilds the same
//! sharing, not one copy per mesh. Every mesh field is written, including the
//! `#[serde(skip)]` in-memory ones.

use super::wire::{Reader, Writer};
use super::CodecError;
use crate::types::mesh::{InstanceRecord, MeshData, MeshTextureData};
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, TextureBinding, UvAuthority,
};
use ifc_lite_geometry::InstanceMeta;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Smallest encoded mesh / instance record: the per-item bound for counts.
const MIN_MESH_BYTES: usize = 90;
const MIN_INSTANCE_BYTES: usize = 116;

/// Table index of each distinct texture allocation, keyed by its address.
pub(super) type TextureIndex = HashMap<*const Vec<u8>, u32>;

/// The distinct texture allocations of `meshes`, in first-use order, and each
/// allocation's index.
pub(super) fn texture_table(meshes: &[MeshData]) -> (Vec<&Arc<Vec<u8>>>, TextureIndex) {
    let mut table = Vec::new();
    let mut index = HashMap::new();
    for rgba in meshes.iter().filter_map(|m| m.texture.as_ref()?.rgba.as_ref()) {
        index.entry(Arc::as_ptr(rgba)).or_insert_with(|| {
            table.push(rgba);
            (table.len() - 1) as u32
        });
    }
    (table, index)
}

pub(super) fn encode_textures(w: &mut Writer, table: &[&Arc<Vec<u8>>]) {
    w.len(table.len());
    table.iter().for_each(|rgba| w.bytes(rgba));
}

pub(super) fn decode_textures(r: &mut Reader<'_>, count: usize) -> Result<Vec<Arc<Vec<u8>>>, CodecError> {
    if r.count(8)? != count {
        return Err(CodecError::Malformed("textures", "count disagrees with directory"));
    }
    (0..count).map(|_| Ok(Arc::new(r.bytes()?.to_vec()))).collect()
}

pub(super) fn encode_meshes(w: &mut Writer, meshes: &[MeshData], index: &TextureIndex) {
    w.len(meshes.len());
    meshes.iter().for_each(|m| encode_mesh(w, m, index));
}

pub(super) fn decode_meshes(
    r: &mut Reader<'_>,
    count: usize,
    textures: &[Arc<Vec<u8>>],
) -> Result<Vec<MeshData>, CodecError> {
    if r.count(MIN_MESH_BYTES)? != count {
        return Err(CodecError::Malformed("meshes", "count disagrees with directory"));
    }
    (0..count).map(|_| decode_mesh(r, textures)).collect()
}

fn encode_mesh(w: &mut Writer, m: &MeshData, index: &TextureIndex) {
    let MeshData {
        express_id,
        ifc_type,
        global_id,
        name,
        presentation_layer,
        positions,
        normals,
        indices,
        color,
        material_name,
        geometry_item_id,
        material_id,
        properties,
        uvs,
        texture,
        geometry_class,
        origin,
        instance,
        local_bounds,
        local_to_world,
        presentation,
    } = m;
    w.u32(*express_id);
    w.str(ifc_type);
    [global_id, name, presentation_layer].into_iter().for_each(|s| w.opt_str(s));
    w.f32_vec(positions);
    w.f32_vec(normals);
    w.u32_vec(indices);
    w.f32_fixed(color);
    w.opt_str(material_name);
    w.opt_u32(*geometry_item_id);
    w.opt_u32(*material_id);
    w.opt(properties.as_ref(), |w, map| {
        w.len(map.len());
        for (k, v) in map {
            w.str(k);
            w.str(v);
        }
    });
    w.opt(uvs.as_deref(), Writer::f32_vec);
    w.opt(texture.as_ref(), |w, t| {
        let MeshTextureData { texture_id, rgba, width, height, url, repeat_s, repeat_t } = t;
        w.u32(*texture_id);
        w.opt(rgba.as_ref(), |w, rgba| w.u32(index[&Arc::as_ptr(rgba)]));
        w.u32(*width);
        w.u32(*height);
        w.opt_str(url);
        w.bool(*repeat_s);
        w.bool(*repeat_t);
    });
    w.u8(*geometry_class);
    w.f64_fixed(origin);
    w.opt(instance.as_ref(), |w, i| {
        let InstanceMeta { transform, local_transform, canonical_transform, rep_identity, instanceable } = i;
        w.f64_fixed(transform);
        w.opt(local_transform.as_ref(), |w, v| w.f64_fixed(v));
        w.opt(canonical_transform.as_ref(), |w, v| w.f64_fixed(v));
        w.u128(*rep_identity);
        w.bool(*instanceable);
    });
    w.opt(local_bounds.as_ref(), |w, v| w.f32_fixed(v));
    w.opt(local_to_world.as_ref(), |w, v| w.f64_fixed(v));
    w.opt(presentation.as_deref(), encode_presentation);
}

fn decode_mesh(r: &mut Reader<'_>, textures: &[Arc<Vec<u8>>]) -> Result<MeshData, CodecError> {
    Ok(MeshData {
        express_id: r.u32()?,
        ifc_type: r.str()?,
        global_id: r.opt_str()?,
        name: r.opt_str()?,
        presentation_layer: r.opt_str()?,
        positions: r.f32_vec()?,
        normals: r.f32_vec()?,
        indices: r.u32_vec()?,
        color: r.f32_fixed()?,
        material_name: r.opt_str()?,
        geometry_item_id: r.opt_u32()?,
        material_id: r.opt_u32()?,
        properties: r.opt(decode_properties)?,
        uvs: r.opt(Reader::f32_vec)?,
        texture: r.opt(|r| decode_texture(r, textures))?,
        geometry_class: r.u8()?,
        origin: r.f64_fixed()?,
        instance: r.opt(|r| {
            Ok(InstanceMeta {
                transform: r.f64_fixed()?,
                local_transform: r.opt(Reader::f64_fixed)?,
                canonical_transform: r.opt(Reader::f64_fixed)?,
                rep_identity: r.u128()?,
                instanceable: r.bool()?,
            })
        })?,
        local_bounds: r.opt(Reader::f32_fixed)?,
        local_to_world: r.opt(Reader::f64_fixed)?,
        presentation: r.opt(decode_presentation)?.map(Box::new),
    })
}

fn decode_properties(r: &mut Reader<'_>) -> Result<BTreeMap<String, String>, CodecError> {
    let n = r.count(16)?;
    let mut map = BTreeMap::new();
    for _ in 0..n {
        if map.insert(r.str()?, r.str()?).is_some() {
            return Err(CodecError::Malformed("meshes", "duplicate property key"));
        }
    }
    Ok(map)
}

fn decode_texture(r: &mut Reader<'_>, textures: &[Arc<Vec<u8>>]) -> Result<MeshTextureData, CodecError> {
    let texture_id = r.u32()?;
    let rgba = r.opt(|r| {
        let at = r.u32()? as usize;
        textures.get(at).cloned().ok_or(CodecError::Malformed("meshes", "texture index out of range"))
    })?;
    Ok(MeshTextureData {
        texture_id,
        rgba,
        width: r.u32()?,
        height: r.u32()?,
        url: r.opt_str()?,
        repeat_s: r.bool()?,
        repeat_t: r.bool()?,
    })
}

fn encode_presentation(w: &mut Writer, p: &MeshPresentationProvenance) {
    let MeshPresentationProvenance { normals, palette, texture } = p;
    w.u8(match normals {
        NormalProvenance::Producer => 0,
        NormalProvenance::RecomputedAfterWindingRepair => 1,
        NormalProvenance::RecomputedMissing => 2,
    });
    w.opt(palette.as_ref(), |w, p| match *p {
        PaletteBinding::Bound { map_id, face_set_id, palette_index } => {
            w.u8(0);
            [map_id, face_set_id, palette_index].into_iter().for_each(|v| w.u32(v));
        }
        PaletteBinding::Absent { map_id, reason } => {
            w.u8(1);
            w.u32(map_id);
            w.u8(match reason {
                PaletteAbsence::Malformed => 0,
                PaletteAbsence::Retopologized => 1,
                PaletteAbsence::Unproven => 2,
                PaletteAbsence::StyleOverride => 3,
                PaletteAbsence::SupersededByTexture => 4,
                PaletteAbsence::FixedDisplayColour => 5,
            });
        }
    });
    w.opt(texture.as_ref(), |w, t| {
        let TextureBinding { texture_id, face_set_id, uv_authority } = t;
        w.u32(*texture_id);
        w.opt_u32(*face_set_id);
        w.u8(match uv_authority {
            UvAuthority::Authored => 0,
            UvAuthority::CoordinatePaired => 1,
            UvAuthority::Fabricated => 2,
            UvAuthority::UnknownMap => 3,
            UvAuthority::Dropped => 4,
        });
    });
}

fn decode_presentation(r: &mut Reader<'_>) -> Result<MeshPresentationProvenance, CodecError> {
    let bad = |what| CodecError::Malformed("meshes", what);
    let normals = match r.u8()? {
        0 => NormalProvenance::Producer,
        1 => NormalProvenance::RecomputedAfterWindingRepair,
        2 => NormalProvenance::RecomputedMissing,
        _ => return Err(bad("unknown normal provenance")),
    };
    let palette = r.opt(|r| match r.u8()? {
        0 => Ok(PaletteBinding::Bound { map_id: r.u32()?, face_set_id: r.u32()?, palette_index: r.u32()? }),
        1 => {
            let map_id = r.u32()?;
            let reason = match r.u8()? {
                0 => PaletteAbsence::Malformed,
                1 => PaletteAbsence::Retopologized,
                2 => PaletteAbsence::Unproven,
                3 => PaletteAbsence::StyleOverride,
                4 => PaletteAbsence::SupersededByTexture,
                5 => PaletteAbsence::FixedDisplayColour,
                _ => return Err(bad("unknown palette absence")),
            };
            Ok(PaletteBinding::Absent { map_id, reason })
        }
        _ => Err(bad("unknown palette binding")),
    })?;
    let texture = r.opt(|r| {
        let texture_id = r.u32()?;
        let face_set_id = r.opt_u32()?;
        let uv_authority = match r.u8()? {
            0 => UvAuthority::Authored,
            1 => UvAuthority::CoordinatePaired,
            2 => UvAuthority::Fabricated,
            3 => UvAuthority::UnknownMap,
            4 => UvAuthority::Dropped,
            _ => return Err(bad("unknown uv authority")),
        };
        Ok(TextureBinding { texture_id, face_set_id, uv_authority })
    })?;
    Ok(MeshPresentationProvenance { normals, palette, texture })
}

pub(super) fn encode_instances(w: &mut Writer, instances: &[InstanceRecord]) {
    w.len(instances.len());
    for record in instances {
        let InstanceRecord {
            express_id,
            ifc_type,
            global_id,
            name,
            presentation_layer,
            color,
            template_express_id,
            rep_identity,
            transform,
            geometry_item_id,
        } = record;
        w.u32(*express_id);
        w.str(ifc_type);
        [global_id, name, presentation_layer].into_iter().for_each(|s| w.opt_str(s));
        w.f32_fixed(color);
        w.u32(*template_express_id);
        w.u128(*rep_identity);
        w.f32_fixed(transform);
        w.opt_u32(*geometry_item_id);
    }
}

pub(super) fn decode_instances(r: &mut Reader<'_>, count: usize) -> Result<Vec<InstanceRecord>, CodecError> {
    if r.count(MIN_INSTANCE_BYTES)? != count {
        return Err(CodecError::Malformed("instances", "count disagrees with directory"));
    }
    (0..count)
        .map(|_| {
            Ok(InstanceRecord {
                express_id: r.u32()?,
                ifc_type: r.str()?,
                global_id: r.opt_str()?,
                name: r.opt_str()?,
                presentation_layer: r.opt_str()?,
                color: r.f32_fixed()?,
                template_express_id: r.u32()?,
                rep_identity: r.u128()?,
                transform: r.f32_fixed()?,
                geometry_item_id: r.opt_u32()?,
            })
        })
        .collect()
}
