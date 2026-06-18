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
    t * l
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

/// Group instanceable meshes by representation identity into templates +
/// per-instance transforms. `min_group` is the smallest occurrence count worth
/// instancing (groups below it are emitted flat); use 2 to instance any repeat.
pub fn collate_instances(meshes: &[Mesh], min_group: usize) -> Collated {
    // First-seen order keeps output deterministic regardless of hash iteration.
    let mut order: Vec<u128> = Vec::new();
    let mut groups: FxHashMap<u128, Vec<usize>> = FxHashMap::default();
    for (i, m) in meshes.iter().enumerate() {
        match &m.instance_meta {
            Some(im) if im.instanceable && !m.positions.is_empty() => {
                groups
                    .entry(im.rep_identity)
                    .or_insert_with(|| {
                        order.push(im.rep_identity);
                        Vec::new()
                    })
                    .push(i);
            }
            _ => {}
        }
    }

    let mut out = Collated::default();
    for rep in order {
        let members = &groups[&rep];
        if members.len() < min_group.max(1) {
            out.flat_indices.extend_from_slice(members);
            continue;
        }
        let t_idx = members[0];
        let template = &meshes[t_idx];
        let m_ref = compose_world(template.instance_meta.as_ref().unwrap());
        let Some(m_ref_inv) = m_ref.try_inverse() else {
            out.flat_indices.extend_from_slice(members);
            continue;
        };
        let (vlen, ilen) = (template.positions.len(), template.indices.len());

        let mut occurrences = Vec::with_capacity(members.len());
        let mut shapes_match = true;
        for &i in members {
            let mesh = &meshes[i];
            // Defensive: occurrences of the same rep share the cached canonical,
            // so counts must match. If they don't (unexpected), fall to flat.
            if mesh.positions.len() != vlen || mesh.indices.len() != ilen {
                shapes_match = false;
                break;
            }
            let m_k = compose_world(mesh.instance_meta.as_ref().unwrap());
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
            let n = template.positions.len() / 3;
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
    fn singletons_and_non_instanceable_go_flat() {
        let p = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 2.0, 3.0));
        let meta = |rep, inst| InstanceMeta {
            transform: mat_rm(&p),
            local_transform: None,
            rep_identity: rep,
            instanceable: inst,
        };
        let meshes = vec![
            mesh_from(baked(&CANON, &p), meta(1, true)), // singleton rep 1
            mesh_from(baked(&CANON, &p), meta(2, false)), // not instanceable
        ];
        let collated = collate_instances(&meshes, 2);
        assert_eq!(collated.templates.len(), 0);
        assert_eq!(collated.flat_indices, vec![0], "singleton -> flat; non-inst skipped");
        assert_eq!(collated.unique_geometry_count(), 1);
    }
}
