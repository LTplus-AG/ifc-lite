// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::collate::{collate_refs, Collated, InstanceMeshRef};
use crate::mesh::Mesh;

// ----------------------------------------------------------------------------
// Instanced wire format
// ----------------------------------------------------------------------------
//
// Little-endian, mirroring the packed-shard conventions (header + tables +
// pooled data) but carrying UNIQUE template geometry once + a per-occurrence
// instance table, so the renderer uploads each template once and
// `drawIndexed(.., instanceCount)`. This Rust encoder/decoder is the spec the TS
// decoder mirrors. Flat (non-instanced) meshes are emitted as singleton
// templates (one identity instance) so every input mesh is represented uniformly.
//
// Layout:
//   Header (8 u32): magic, version, templateCount, instanceCount,
//                   positionsLen, normalsLen, indicesLen, reserved
//   Template table (templateCount × 48 bytes): posOff,posLen,nrmOff,nrmLen,
//                   idxOff,idxLen (6× u32) then originX,originY,originZ (3× f64)
//   Instance table (instanceCount × 88 bytes): templateIndex(u32), entityId(u32),
//                   color(4× f32), transform(16× f32, row-major rel_k)
//   Data: positions (f32 × positionsLen), normals (f32 × normalsLen),
//         indices (u32 × indicesLen). Offsets/lengths are ELEMENT counts; indices
//         stay local to each template's vertex range (0-based).

/// `"IFNS"` little-endian — the instanced-shard magic the TS decoder validates.
pub const INSTANCED_MAGIC: u32 = 0x4946_4E53;
/// Instanced format version. Bump in lockstep with the TS decoder.
pub const INSTANCED_VERSION: u32 = 1;

const INST_IDENTITY_F32: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// A unique geometry decoded from an instanced shard.
#[derive(Debug, Clone)]
pub struct DecodedTemplate {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    /// Per-template local origin (f64); world vertex = transform · (origin + position).
    pub origin: [f64; 3],
}

/// One occurrence of a decoded template.
#[derive(Debug, Clone)]
pub struct DecodedInstance {
    pub template_index: u32,
    pub entity_id: u32,
    pub color: [f32; 4],
    /// Row-major mat4 mapping the template's world geometry onto this occurrence.
    pub transform: [f32; 16],
}

/// A decoded instanced shard.
#[derive(Debug, Clone, Default)]
pub struct DecodedInstanced {
    pub templates: Vec<DecodedTemplate>,
    pub instances: Vec<DecodedInstance>,
}

/// Encode a [`Collated`] result + its source mesh views into an instanced shard.
/// Per-occurrence entity id + colour come from each `InstanceMeshRef`.
pub fn encode_refs(meshes: &[InstanceMeshRef], collated: &Collated) -> Vec<u8> {
    // (template mesh index, [(occurrence mesh index, rel transform)]).
    struct TSpec {
        mesh_idx: usize,
        instances: Vec<(usize, [f32; 16])>,
    }
    let mut tspecs: Vec<TSpec> = Vec::with_capacity(collated.templates.len() + collated.flat_indices.len());
    for t in &collated.templates {
        tspecs.push(TSpec {
            mesh_idx: t.template_index,
            instances: t.occurrences.iter().map(|o| (o.mesh_index, o.transform)).collect(),
        });
    }
    for &f in &collated.flat_indices {
        tspecs.push(TSpec {
            mesh_idx: f,
            instances: vec![(f, INST_IDENTITY_F32)],
        });
    }

    let template_count = tspecs.len();
    let instance_count: usize = tspecs.iter().map(|t| t.instances.len()).sum();
    let positions_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].positions.len()).sum();
    let normals_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].normals.len()).sum();
    let indices_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].indices.len()).sum();

    // Wire offsets/lengths are u32 (header + template records). A pool exceeding
    // u32::MAX elements (>16GB of positions in ONE shard) would wrap SILENTLY and
    // corrupt template lookups. Fail loudly instead — the caller must chunk shards
    // below this (real instanced shards are <<1GB; this is an impossible-scale
    // backstop, not a normal limit).
    assert!(
        positions_len <= u32::MAX as usize
            && normals_len <= u32::MAX as usize
            && indices_len <= u32::MAX as usize
            && template_count <= u32::MAX as usize
            && instance_count <= u32::MAX as usize,
        "instanced shard exceeds u32 wire limits (pos={positions_len} idx={indices_len}); chunk it"
    );

    let mut buf: Vec<u8> = Vec::with_capacity(
        32 + template_count * 48 + instance_count * 88 + (positions_len + normals_len + indices_len) * 4,
    );
    let pu32 = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
    let pf32 = |b: &mut Vec<u8>, v: f32| b.extend_from_slice(&v.to_le_bytes());
    let pf64 = |b: &mut Vec<u8>, v: f64| b.extend_from_slice(&v.to_le_bytes());

    // Header.
    pu32(&mut buf, INSTANCED_MAGIC);
    pu32(&mut buf, INSTANCED_VERSION);
    pu32(&mut buf, template_count as u32);
    pu32(&mut buf, instance_count as u32);
    pu32(&mut buf, positions_len as u32);
    pu32(&mut buf, normals_len as u32);
    pu32(&mut buf, indices_len as u32);
    pu32(&mut buf, 0);

    // Template table (running element offsets into the pooled data arrays).
    let (mut pos_off, mut nrm_off, mut idx_off) = (0u32, 0u32, 0u32);
    for t in &tspecs {
        let m = &meshes[t.mesh_idx];
        pu32(&mut buf, pos_off);
        pu32(&mut buf, m.positions.len() as u32);
        pu32(&mut buf, nrm_off);
        pu32(&mut buf, m.normals.len() as u32);
        pu32(&mut buf, idx_off);
        pu32(&mut buf, m.indices.len() as u32);
        pf64(&mut buf, m.origin[0]);
        pf64(&mut buf, m.origin[1]);
        pf64(&mut buf, m.origin[2]);
        pos_off += m.positions.len() as u32;
        nrm_off += m.normals.len() as u32;
        idx_off += m.indices.len() as u32;
    }

    // Instance table.
    for (ti, t) in tspecs.iter().enumerate() {
        for (occ_idx, transform) in &t.instances {
            pu32(&mut buf, ti as u32);
            pu32(&mut buf, meshes[*occ_idx].entity_id);
            for c in meshes[*occ_idx].color {
                pf32(&mut buf, c);
            }
            for v in transform {
                pf32(&mut buf, *v);
            }
        }
    }

    // Data pools.
    for t in &tspecs {
        for &p in meshes[t.mesh_idx].positions {
            pf32(&mut buf, p);
        }
    }
    for t in &tspecs {
        for &n in meshes[t.mesh_idx].normals {
            pf32(&mut buf, n);
        }
    }
    for t in &tspecs {
        for &i in meshes[t.mesh_idx].indices {
            pu32(&mut buf, i);
        }
    }
    buf
}

/// `encode_refs` over geometry `Mesh` values, with id/colour accessor closures
/// (thin wrapper, no geometry clone).
pub fn encode_instanced(
    meshes: &[Mesh],
    collated: &Collated,
    entity_id: impl Fn(usize) -> u32,
    color: impl Fn(usize) -> [f32; 4],
) -> Vec<u8> {
    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let mut r = InstanceMeshRef::from_mesh(m);
            r.entity_id = entity_id(i);
            r.color = color(i);
            r
        })
        .collect();
    encode_refs(&refs, collated)
}

/// One-shot producer: collate the mesh views into templates + instances and
/// encode them as an instanced shard. The caller (e.g. the native helper) builds
/// `InstanceMeshRef`s borrowing its own mesh storage — no geometry is cloned.
pub fn collate_and_encode(meshes: &[InstanceMeshRef], min_group: usize, rtc: [f64; 3]) -> Vec<u8> {
    let collated = collate_refs(meshes, min_group, rtc);
    encode_refs(meshes, &collated)
}

/// Decode an instanced shard. Returns None on a bad magic/version or truncation.
pub fn decode_instanced(bytes: &[u8]) -> Option<DecodedInstanced> {
    let ru32 = |o: usize| -> Option<u32> {
        bytes.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf32 = |o: usize| -> Option<f32> {
        bytes.get(o..o + 4).map(|s| f32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf64 = |o: usize| -> Option<f64> {
        bytes.get(o..o + 8).map(|s| f64::from_le_bytes(s.try_into().unwrap()))
    };
    if ru32(0)? != INSTANCED_MAGIC || ru32(4)? != INSTANCED_VERSION {
        return None;
    }
    let template_count = ru32(8)? as usize;
    let instance_count = ru32(12)? as usize;
    let positions_len = ru32(16)? as usize;
    let normals_len = ru32(20)? as usize;
    let _indices_len = ru32(24)? as usize;

    let tt_off = 32;
    let it_off = tt_off + template_count * 48;
    let data_off = it_off + instance_count * 88;
    let nrm_data = data_off + positions_len * 4;
    let idx_data = nrm_data + normals_len * 4;

    let mut templates = Vec::with_capacity(template_count);
    for t in 0..template_count {
        let r = tt_off + t * 48;
        let pos_off = ru32(r)? as usize;
        let pos_len = ru32(r + 4)? as usize;
        let nrm_off = ru32(r + 8)? as usize;
        let nrm_len = ru32(r + 12)? as usize;
        let i_off = ru32(r + 16)? as usize;
        let i_len = ru32(r + 20)? as usize;
        let origin = [rf64(r + 24)?, rf64(r + 32)?, rf64(r + 40)?];
        let positions = (0..pos_len)
            .map(|k| rf32(data_off + (pos_off + k) * 4))
            .collect::<Option<Vec<f32>>>()?;
        let normals = (0..nrm_len)
            .map(|k| rf32(nrm_data + (nrm_off + k) * 4))
            .collect::<Option<Vec<f32>>>()?;
        let indices = (0..i_len)
            .map(|k| ru32(idx_data + (i_off + k) * 4))
            .collect::<Option<Vec<u32>>>()?;
        templates.push(DecodedTemplate { positions, normals, indices, origin });
    }

    let mut instances = Vec::with_capacity(instance_count);
    for i in 0..instance_count {
        let r = it_off + i * 88;
        let template_index = ru32(r)?;
        let entity_id = ru32(r + 4)?;
        let mut color = [0.0f32; 4];
        for (k, c) in color.iter_mut().enumerate() {
            *c = rf32(r + 8 + k * 4)?;
        }
        let mut transform = [0.0f32; 16];
        for (k, v) in transform.iter_mut().enumerate() {
            *v = rf32(r + 24 + k * 4)?;
        }
        instances.push(DecodedInstance { template_index, entity_id, color, transform });
    }
    Some(DecodedInstanced { templates, instances })
}
