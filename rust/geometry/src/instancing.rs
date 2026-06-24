// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU-instancing collation.
//!
//! Phase A produces baked meshes that carry [`InstanceMeta`] (rep-identity +
//! the per-occurrence world transform, split into placement `transform` and
//! optional mapping `local_transform`). This module groups occurrences that
//! share a representation into a single *template* geometry plus a list of
//! per-instance transforms, so the renderer can upload each unique mesh once
//! and `drawIndexed(.., instanceCount)`.
//!
//! ## Correctness contract
//!
//! All occurrences of one `rep_identity` are produced from the *same* cached
//! source-coords geometry (the `mapped_item_cache` returns clones of one mesh),
//! so their canonical geometry is bit-identical. The baked world vertices of
//! occurrence *k* are therefore `M_k · canonical`, where
//! `M_k = transform_k · local_transform_k`. Taking occurrence 0 as the template,
//! the per-instance transform that maps the template's baked world geometry onto
//! occurrence *k* is `rel_k = M_k · M_0⁻¹` (so `rel_0 = I`). This is exact up to
//! floating point; [`verify_recomposition`] bounds the residual and the unit
//! tests assert it stays within a micrometre.

use crate::mesh::{InstanceMeta, Mesh};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

const IDENTITY16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];

/// Full world transform `transform · local_transform` for an occurrence.
fn compose_world(meta: &InstanceMeta) -> Matrix4<f64> {
    let t = Matrix4::from_row_slice(&meta.transform);
    let l = Matrix4::from_row_slice(meta.local_transform.as_ref().unwrap_or(&IDENTITY16));
    // Rigid tier: canonical->local transform, composed innermost. For occurrences
    // grouped by congruence (not bit-identity) this carries the recovered rotation
    // so the shared template reproduces this occurrence's baked geometry.
    let c = Matrix4::from_row_slice(meta.canonical_transform.as_ref().unwrap_or(&IDENTITY16));
    t * l * c
}

/// Flatten a column-major nalgebra matrix into a row-major `[f32; 16]`.
fn mat4_to_row_major_f32(m: &Matrix4<f64>) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)] as f32;
        }
    }
    out
}

/// One occurrence of a template geometry.
#[derive(Debug, Clone)]
pub struct InstanceOccurrence {
    /// Index of the original mesh in the input slice (carries entity id / colour).
    pub mesh_index: usize,
    /// Row-major mat4 mapping the template's baked world geometry onto this
    /// occurrence. The template occurrence's transform is identity.
    pub transform: [f32; 16],
}

/// A unique geometry shared by two or more occurrences.
#[derive(Debug, Clone)]
pub struct InstanceTemplate {
    /// Representation-identity key (RepresentationMap id for mapped items).
    pub rep_identity: u128,
    /// Index of the mesh whose geometry is the template to upload.
    pub template_index: usize,
    /// Every occurrence (including the template itself, with identity transform).
    pub occurrences: Vec<InstanceOccurrence>,
}

/// Result of collation: instanced templates + the meshes left to render flat.
#[derive(Debug, Clone, Default)]
pub struct Collated {
    /// Unique geometries with their per-instance transforms.
    pub templates: Vec<InstanceTemplate>,
    /// Indices of input meshes rendered without instancing (non-instanceable,
    /// singleton groups, or groups that failed the geometry-shape guard).
    pub flat_indices: Vec<usize>,
}

impl Collated {
    /// Total number of unique geometries that would be uploaded (templates +
    /// flat meshes) — the figure that bounds browser ingestion.
    pub fn unique_geometry_count(&self) -> usize {
        self.templates.len() + self.flat_indices.len()
    }

    /// Total occurrences represented across all templates (excludes flat meshes).
    pub fn instanced_occurrence_count(&self) -> usize {
        self.templates.iter().map(|t| t.occurrences.len()).sum()
    }
}

/// A borrowed view of a mesh for collation/encoding — lets callers feed geometry
/// from any owner (geometry's `Mesh`, processing's `MeshData`) WITHOUT cloning the
/// vertex data (cloning 219k meshes' geometry risks the build-container OOM).
pub struct InstanceMeshRef<'a> {
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub indices: &'a [u32],
    pub origin: [f64; 3],
    pub instance_meta: Option<&'a InstanceMeta>,
    /// Per-occurrence entity id (used only by the encoder).
    pub entity_id: u32,
    /// Per-occurrence RGBA (used only by the encoder).
    pub color: [f32; 4],
}

impl<'a> InstanceMeshRef<'a> {
    /// Build a view over a geometry `Mesh` (encoder id/colour default to 0).
    pub fn from_mesh(m: &'a Mesh) -> Self {
        InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance_meta.as_ref(),
            entity_id: 0,
            color: [0.0; 4],
        }
    }
}

/// Group instanceable meshes by representation identity into templates +
/// per-instance transforms. `min_group` is the smallest occurrence count worth
/// instancing (groups below it are emitted flat); use 2 to instance any repeat.
pub fn collate_refs(meshes: &[InstanceMeshRef], min_group: usize) -> Collated {
    // First-seen order keeps output deterministic regardless of hash iteration.
    let mut order: Vec<u128> = Vec::new();
    let mut groups: FxHashMap<u128, Vec<usize>> = FxHashMap::default();
    // Non-instanceable meshes (void-cut walls, multi-item merges, site-rotated
    // elements — anything carrying no usable InstanceMeta) still must be DRAWN, so
    // they're routed to flat_indices and emitted as flat singleton templates.
    // Dropping them here would silently lose geometry now that capture is always-on
    // and real models feed the collator — the unit fixtures were all instanceable,
    // which hid this. Empty meshes carry nothing to draw and are the only skip.
    let mut flat: Vec<usize> = Vec::new();
    for (i, m) in meshes.iter().enumerate() {
        if m.positions.is_empty() {
            continue;
        }
        match m.instance_meta {
            Some(im) if im.instanceable => {
                groups
                    .entry(im.rep_identity)
                    .or_insert_with(|| {
                        order.push(im.rep_identity);
                        Vec::new()
                    })
                    .push(i);
            }
            _ => flat.push(i),
        }
    }

    let mut out = Collated {
        flat_indices: flat,
        ..Collated::default()
    };
    for rep in order {
        let members = &groups[&rep];
        if members.len() < min_group.max(1) {
            out.flat_indices.extend_from_slice(members);
            continue;
        }
        let t_idx = members[0];
        let template = &meshes[t_idx];
        let m_ref = compose_world(template.instance_meta.unwrap());
        let Some(m_ref_inv) = m_ref.try_inverse() else {
            out.flat_indices.extend_from_slice(members);
            continue;
        };

        // A rigid-tier group (rotation-normalized) holds occurrences that are
        // congruent but NOT bit-identical, so their raw vertex counts can differ —
        // the renderer substitutes the template's geometry at each occurrence's
        // pose (rel_k is pose-only). The exact-bit tier keeps the defensive
        // same-count check (a mismatch there means something is wrong).
        let is_rigid = members
            .iter()
            .any(|&i| meshes[i].instance_meta.and_then(|m| m.canonical_transform).is_some());
        let (vlen, ilen) = (template.positions.len(), template.indices.len());
        let mut occurrences = Vec::with_capacity(members.len());
        let mut shapes_match = true;
        for &i in members {
            let mesh = &meshes[i];
            // Exact-tier occurrences share the SAME local geometry (so same counts),
            // differing only by placement — we can't byte-compare their BAKED
            // positions (those legitimately differ). Content-equality is instead
            // guaranteed upstream: rep_identity is a FULL 128-bit content hash
            // (compute_mesh_hash_full | tag), so a same-counts/different-content
            // collision is ~2^-127. The count check stays as a cheap guard.
            // Rigid-tier occurrences are intentionally non-identical (verified).
            if !is_rigid && (mesh.positions.len() != vlen || mesh.indices.len() != ilen) {
                shapes_match = false;
                break;
            }
            let m_k = compose_world(mesh.instance_meta.unwrap());
            let rel = m_k * m_ref_inv;
            occurrences.push(InstanceOccurrence {
                mesh_index: i,
                transform: mat4_to_row_major_f32(&rel),
            });
        }

        if shapes_match {
            out.templates.push(InstanceTemplate {
                rep_identity: rep,
                template_index: t_idx,
                occurrences,
            });
        } else {
            out.flat_indices.extend_from_slice(members);
        }
    }
    out
}

/// `collate_refs` over geometry `Mesh` values (thin wrapper, no geometry clone).
pub fn collate_instances(meshes: &[Mesh], min_group: usize) -> Collated {
    let refs: Vec<InstanceMeshRef> = meshes.iter().map(InstanceMeshRef::from_mesh).collect();
    collate_refs(&refs, min_group)
}

/// Maximum per-vertex world-space error (in mesh units) when each occurrence is
/// reconstructed by applying its instance transform to the template's baked
/// world geometry, versus the occurrence's own baked world geometry. The
/// template-relative transform operates on world coords, so each mesh's `origin`
/// is folded in. Used by tests + as a runtime diagnostic.
pub fn verify_recomposition(meshes: &[Mesh], collated: &Collated) -> f64 {
    let mut max_err = 0.0f64;
    for tmpl in &collated.templates {
        let template = &meshes[tmpl.template_index];
        for occ in &tmpl.occurrences {
            let target = &meshes[occ.mesh_index];
            let rel = Matrix4::from_row_slice(&occ.transform.map(|v| v as f64));
            // A valid template↔occurrence pair shares the same geometry (same
            // vertex count, different transform). If the counts differ the
            // occurrence can't be recomposed from the template — flag it as an
            // unbounded error instead of panicking on an out-of-bounds index,
            // so the diagnostic surfaces the mismatch. (#1238 review)
            let n = template.positions.len() / 3;
            if target.positions.len() / 3 != n {
                max_err = f64::INFINITY;
                continue;
            }
            for v in 0..n {
                // Template world vertex = template.origin + position.
                let tx = template.origin[0] + template.positions[v * 3] as f64;
                let ty = template.origin[1] + template.positions[v * 3 + 1] as f64;
                let tz = template.origin[2] + template.positions[v * 3 + 2] as f64;
                let w = rel * nalgebra::Vector4::new(tx, ty, tz, 1.0);
                let (rx, ry, rz) = (w.x / w.w, w.y / w.w, w.z / w.w);
                // Target world vertex.
                let gx = target.origin[0] + target.positions[v * 3] as f64;
                let gy = target.origin[1] + target.positions[v * 3 + 1] as f64;
                let gz = target.origin[2] + target.positions[v * 3 + 2] as f64;
                let err = ((rx - gx).powi(2) + (ry - gy).powi(2) + (rz - gz).powi(2)).sqrt();
                if err > max_err {
                    max_err = err;
                }
            }
        }
    }
    max_err
}

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
pub fn collate_and_encode(meshes: &[InstanceMeshRef], min_group: usize) -> Vec<u8> {
    let collated = collate_refs(meshes, min_group);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mat_rm(m: &Matrix4<f64>) -> [f64; 16] {
        let mut out = [0.0f64; 16];
        for r in 0..4 {
            for c in 0..4 {
                out[r * 4 + c] = m[(r, c)];
            }
        }
        out
    }

    /// Bake a canonical mesh through a full world transform `m`.
    fn baked(canonical: &[f32], m: &Matrix4<f64>) -> Vec<f32> {
        let mut out = Vec::with_capacity(canonical.len());
        for v in canonical.chunks_exact(3) {
            let w = m * nalgebra::Vector4::new(v[0] as f64, v[1] as f64, v[2] as f64, 1.0);
            out.push((w.x / w.w) as f32);
            out.push((w.y / w.w) as f32);
            out.push((w.z / w.w) as f32);
        }
        out
    }

    fn mesh_from(positions: Vec<f32>, meta: InstanceMeta) -> Mesh {
        let n = positions.len() / 3;
        let mut m = Mesh::new();
        m.positions = positions;
        m.normals = vec![0.0; n * 3];
        m.indices = (0..n as u32).collect();
        m.instance_meta = Some(meta);
        m
    }

    // A canonical unit tetra in source coords.
    const CANON: [f32; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    #[test]
    fn collates_repeated_representation_and_recomposes_within_a_micrometre() {
        use std::f64::consts::FRAC_PI_3;
        // Three occurrences of rep S=42: distinct placements (rotation + translation),
        // captured as `transform` with no mapping (local_transform None).
        let placements = [
            Matrix4::new_translation(&nalgebra::Vector3::new(10.0, 0.0, 0.0)),
            Matrix4::from_euler_angles(0.0, 0.0, FRAC_PI_3)
                * Matrix4::new_translation(&nalgebra::Vector3::new(-5.0, 7.0, 2.0)),
            Matrix4::from_euler_angles(FRAC_PI_3, 0.0, 0.0)
                * Matrix4::new_translation(&nalgebra::Vector3::new(100.0, -50.0, 3.0)),
        ];
        let meshes: Vec<Mesh> = placements
            .iter()
            .map(|m| {
                mesh_from(
                    baked(&CANON, m),
                    InstanceMeta {
                        transform: mat_rm(m),
                        local_transform: None,
                        canonical_transform: None,
                        rep_identity: 42,
                        instanceable: true,
                    },
                )
            })
            .collect();

        let collated = collate_instances(&meshes, 2);
        assert_eq!(collated.templates.len(), 1, "one shared template");
        assert_eq!(collated.flat_indices.len(), 0, "nothing left flat");
        let tmpl = &collated.templates[0];
        assert_eq!(tmpl.rep_identity, 42);
        assert_eq!(tmpl.occurrences.len(), 3);
        // Template occurrence maps to identity.
        assert_eq!(tmpl.occurrences[0].mesh_index, 0);
        let id = Matrix4::<f64>::identity();
        for (a, b) in tmpl.occurrences[0]
            .transform
            .iter()
            .zip(mat4_to_row_major_f32(&id).iter())
        {
            assert!((a - b).abs() < 1e-5, "template transform is identity");
        }

        // The compose/inverse/relative math is exact in f64; the only residual is
        // f32 storage of the baked positions (the real pipeline stores f32 too, so
        // instancing adds no error beyond the flat path's). At |coords| <= 100 that
        // floor is ~1e-6; a row/col-major or multiply-order bug would err by the
        // translation magnitude (tens of units), so 1e-4 stays a sharp guard.
        let err = verify_recomposition(&meshes, &collated);
        assert!(err < 1e-4, "recomposition error {err} exceeds the f32 storage floor");
    }

    #[test]
    fn composes_placement_and_mapping_transform() {
        // M = placement · mapping; split across `transform` and `local_transform`.
        let mapping = Matrix4::new_translation(&nalgebra::Vector3::new(0.5, 0.0, 0.0))
            * Matrix4::new_scaling(1.0);
        let placements = [
            Matrix4::new_translation(&nalgebra::Vector3::new(3.0, 0.0, 0.0)),
            Matrix4::from_euler_angles(0.0, std::f64::consts::FRAC_PI_4, 0.0)
                * Matrix4::new_translation(&nalgebra::Vector3::new(20.0, 1.0, -4.0)),
        ];
        let meshes: Vec<Mesh> = placements
            .iter()
            .map(|p| {
                let full = p * mapping;
                mesh_from(
                    baked(&CANON, &full),
                    InstanceMeta {
                        transform: mat_rm(p),
                        local_transform: Some(mat_rm(&mapping)),
                        canonical_transform: None,
                        rep_identity: 7,
                        instanceable: true,
                    },
                )
            })
            .collect();

        let collated = collate_instances(&meshes, 2);
        assert_eq!(collated.templates.len(), 1);
        assert_eq!(collated.templates[0].occurrences.len(), 2);
        let err = verify_recomposition(&meshes, &collated);
        assert!(err < 1e-4, "placement·mapping recomposition error {err}");
    }

    #[test]
    fn rigid_canonical_transform_recomposes() {
        // Rigid tier: two occurrences of one canonical shape, the second rotated
        // (canonical_transform = C_B ≠ identity). collate must reproduce both
        // baked meshes from the shared template.
        let c_b = Matrix4::from_euler_angles(0.3, 0.9, 0.2)
            * Matrix4::new_translation(&nalgebra::Vector3::new(0.4, -0.2, 0.1));
        let m_a = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 0.0, 0.0));
        let m_b = Matrix4::from_euler_angles(0.0, 0.0, 1.2)
            * Matrix4::new_translation(&nalgebra::Vector3::new(-3.0, 8.0, 2.0));
        let meshes = vec![
            mesh_from(
                baked(&CANON, &m_a),
                InstanceMeta {
                    transform: mat_rm(&m_a),
                    local_transform: None,
                    canonical_transform: None, // template
                    rep_identity: 99,
                    instanceable: true,
                },
            ),
            mesh_from(
                baked(&CANON, &(m_b * c_b)),
                InstanceMeta {
                    transform: mat_rm(&m_b),
                    local_transform: None,
                    canonical_transform: Some(mat_rm(&c_b)),
                    rep_identity: 99,
                    instanceable: true,
                },
            ),
        ];
        let collated = collate_instances(&meshes, 2);
        assert_eq!(collated.templates.len(), 1, "one rigid template");
        assert_eq!(collated.templates[0].occurrences.len(), 2);
        let err = verify_recomposition(&meshes, &collated);
        assert!(err < 1e-4, "rigid canonical_transform recompose error {err}");
    }

    #[test]
    fn instanced_wire_format_roundtrips_and_expands_to_flat() {
        // Two occurrences sharing rep 50 (exact tier, bit-identical local) + a
        // singleton rep 60 (flat). entity_id == input mesh index.
        let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
        let m1 = Matrix4::from_euler_angles(0.0, 0.0, 1.1)
            * Matrix4::new_translation(&nalgebra::Vector3::new(-4.0, 6.0, 2.0));
        let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(9.0, 9.0, 9.0));
        let mk = |m: &Matrix4<f64>, rep: u128| {
            mesh_from(
                baked(&CANON, m),
                InstanceMeta {
                    transform: mat_rm(m),
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: rep,
                    instanceable: true,
                },
            )
        };
        let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
        let collated = collate_instances(&meshes, 2);

        let bytes = encode_instanced(&meshes, &collated, |i| i as u32, |_| [0.25, 0.5, 0.75, 1.0]);
        let dec = decode_instanced(&bytes).expect("decodes");
        // rep50 -> 1 template (2 occ); rep60 singleton -> 1 template (1 occ).
        assert_eq!(dec.templates.len(), 2, "two templates");
        assert_eq!(dec.instances.len(), 3, "every input mesh is an instance");
        // Losslessness: the rep-50 template geometry is mesh 0 verbatim.
        assert_eq!(dec.templates[0].positions, meshes[0].positions);
        assert_eq!(dec.templates[0].indices, meshes[0].indices);
        assert_eq!(dec.instances[0].color, [0.25, 0.5, 0.75, 1.0]);

        // Expand-to-flat: applying each instance transform to its template
        // reproduces the original occurrence's world geometry.
        for inst in &dec.instances {
            let tmpl = &dec.templates[inst.template_index as usize];
            let rel = Matrix4::from_row_slice(&inst.transform.map(|v| v as f64));
            let orig = &meshes[inst.entity_id as usize];
            assert_eq!(tmpl.positions.len(), orig.positions.len());
            let n = tmpl.positions.len() / 3;
            for v in 0..n {
                let w = rel
                    * nalgebra::Vector4::new(
                        tmpl.origin[0] + tmpl.positions[v * 3] as f64,
                        tmpl.origin[1] + tmpl.positions[v * 3 + 1] as f64,
                        tmpl.origin[2] + tmpl.positions[v * 3 + 2] as f64,
                        1.0,
                    );
                let gx = orig.origin[0] + orig.positions[v * 3] as f64;
                let gy = orig.origin[1] + orig.positions[v * 3 + 1] as f64;
                let gz = orig.origin[2] + orig.positions[v * 3 + 2] as f64;
                let err = ((w.x / w.w - gx).powi(2)
                    + (w.y / w.w - gy).powi(2)
                    + (w.z / w.w - gz).powi(2))
                .sqrt();
                assert!(err < 1e-4, "expand-to-flat vertex error {err}");
            }
        }
    }

    /// Dumps a deterministic instanced-shard fixture as hex for the cross-language
    /// TS conformance test (packed-instanced-decoder.test.ts). Run on demand:
    /// `cargo test -p ifc-lite-geometry --lib dump_instanced_fixture -- --ignored --nocapture`
    /// then paste the hex into the TS fixture. Pure-translation transforms keep
    /// the expected world geometry trivially checkable on both sides.
    #[test]
    #[ignore]
    fn dump_instanced_fixture() {
        let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
        let m1 = Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 2.0, 0.0));
        let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 5.0, 5.0));
        let mk = |m: &Matrix4<f64>, rep: u128| {
            mesh_from(
                baked(&CANON, m),
                InstanceMeta {
                    transform: mat_rm(m),
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: rep,
                    instanceable: true,
                },
            )
        };
        let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
        let collated = collate_instances(&meshes, 2);
        let bytes = encode_instanced(&meshes, &collated, |i| (1000 + i) as u32, |i| {
            [i as f32 * 0.1, 0.2, 0.3, 1.0]
        });
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        println!("INSTANCED_FIXTURE_HEX_BEGIN");
        println!("{hex}");
        println!("INSTANCED_FIXTURE_HEX_END");
    }

    #[test]
    fn collate_count_guard_drops_mismatched_group_to_flat() {
        // A rep_identity grouping with mismatched vertex/index counts (e.g. a
        // hash collision that survived the count differing) must NOT instance —
        // the cheap count guard falls the whole group to flat. (Same-count content
        // collisions are prevented upstream by the 128-bit rep_identity hash.)
        let p = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
        let meta = |rep| InstanceMeta {
            transform: mat_rm(&p),
            local_transform: None,
            canonical_transform: None,
            rep_identity: rep,
            instanceable: true,
        };
        // canon_b has 5 vertices vs CANON's 4 → different counts.
        let canon_b: [f32; 15] = [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 2.0, 2.0,
        ];
        let meshes = vec![
            mesh_from(baked(&CANON, &p), meta(777)),
            mesh_from(baked(&canon_b, &p), meta(777)), // same rep, different counts
        ];
        let collated = collate_instances(&meshes, 2);
        assert_eq!(collated.templates.len(), 0, "count mismatch must NOT form a template");
        assert_eq!(collated.flat_indices.len(), 2, "both fall to flat");
    }

    #[test]
    fn collate_and_encode_matches_mesh_path() {
        // The zero-copy ref one-shot must produce byte-identical output to the
        // Mesh-based collate + encode (the engine emit uses the ref path).
        let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
        let m1 = Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 2.0, 0.0));
        let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 5.0, 5.0));
        let mk = |m: &Matrix4<f64>, rep: u128| {
            mesh_from(
                baked(&CANON, m),
                InstanceMeta {
                    transform: mat_rm(m),
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: rep,
                    instanceable: true,
                },
            )
        };
        let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
        let col = |i: usize| [i as f32 * 0.1, 0.2, 0.3, 1.0];

        let collated = collate_instances(&meshes, 2);
        let bytes_mesh = encode_instanced(&meshes, &collated, |i| i as u32, col);

        let refs: Vec<InstanceMeshRef> = meshes
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let mut r = InstanceMeshRef::from_mesh(m);
                r.entity_id = i as u32;
                r.color = col(i);
                r
            })
            .collect();
        let bytes_ref = collate_and_encode(&refs, 2);

        assert_eq!(bytes_mesh, bytes_ref, "ref one-shot must match the Mesh path byte-for-byte");
        // And it must still decode + expand.
        let dec = decode_instanced(&bytes_ref).expect("decodes");
        assert_eq!(dec.templates.len(), 2);
        assert_eq!(dec.instances.len(), 3);
    }

    #[test]
    fn decode_rejects_bad_magic() {
        assert!(decode_instanced(&[0u8; 32]).is_none());
        assert!(decode_instanced(&[]).is_none());
    }

    #[test]
    fn singletons_and_non_instanceable_go_flat() {
        let p = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 2.0, 3.0));
        let meta = |rep, inst| InstanceMeta {
            transform: mat_rm(&p),
            local_transform: None,
                        canonical_transform: None,
            rep_identity: rep,
            instanceable: inst,
        };
        let meshes = vec![
            mesh_from(baked(&CANON, &p), meta(1, true)), // singleton rep 1
            mesh_from(baked(&CANON, &p), meta(2, false)), // not instanceable
        ];
        let collated = collate_instances(&meshes, 2);
        // BOTH meshes must be represented. The instanceable singleton has no repeat
        // so it goes flat; the non-instanceable mesh must STILL be drawn (emitted as
        // a flat singleton), not dropped — dropping it silently loses geometry on
        // real models (void-cut walls / multi-item merges carry instance: None).
        assert_eq!(collated.templates.len(), 0);
        let mut flat = collated.flat_indices.clone();
        flat.sort_unstable();
        assert_eq!(flat, vec![0, 1], "singleton + non-instanceable both emitted flat");
        assert_eq!(collated.unique_geometry_count(), 2);
    }
}
