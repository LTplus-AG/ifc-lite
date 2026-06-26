// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
pub(super) fn mat4_to_row_major_f32(m: &Matrix4<f64>) -> [f32; 16] {
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
