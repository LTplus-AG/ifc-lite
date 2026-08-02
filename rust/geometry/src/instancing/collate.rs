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

/// Subtract the model RTC offset from a composed (pre-RTC) world transform's
/// translation column, giving the post-RTC placement that matches the post-RTC
/// per-mesh `origin` the renderer applies the relative transform to.
fn to_post_rtc(mut m: Matrix4<f64>, rtc: [f64; 3]) -> Matrix4<f64> {
    m[(0, 3)] -= rtc[0];
    m[(1, 3)] -= rtc[1];
    m[(2, 3)] -= rtc[2];
    m
}

/// Group instanceable meshes by representation identity into templates +
/// per-instance transforms. `min_group` is the smallest occurrence count worth
/// instancing (groups below it are emitted flat); use 2 to instance any repeat.
///
/// `rtc` is the model RTC offset (`InstanceMeta.transform` is documented pre-RTC
/// at georeferenced magnitude, while each mesh's baked `origin` is post-RTC and
/// small). The per-occurrence relative transform is computed in the post-RTC
/// frame: on raw absolute placements `rel = m_k · m_ref⁻¹` lets a *rotated*
/// occurrence's translation reach `T_k − R_rel·T_ref ≈ 2× rtc` (the two ~1e6 m
/// terms add instead of cancel), which then places the occurrence at twice the
/// georeference and collapses f32 GLB exports. Reducing both transforms by `rtc`
/// first keeps `rel.translation` at building scale and consistent with the small
/// template origin.
pub fn collate_refs(meshes: &[InstanceMeshRef], min_group: usize, rtc: [f64; 3]) -> Collated {
    // First-seen order keeps output deterministic regardless of hash iteration.
    let mut order: Vec<u128> = Vec::new();
    let mut groups: FxHashMap<u128, Vec<usize>> = FxHashMap::default();
    // Non-instanceable meshes (void-cut walls, multi-item merges, site-rotated
    // elements — anything carrying no usable InstanceMeta) still must be DRAWN, so
    // they're routed to flat_indices and emitted as flat singleton templates.
    // Dropping them here would silently lose geometry now that capture is always-on
    // and real models feed the collator — the unit fixtures were all instanceable,
    // which hid this. A non-empty non-instanceable mesh goes flat; an EMPTY mesh
    // carries nothing to draw UNLESS it is a #1623 Phase 3 don't-bake occurrence
    // placeholder (empty geometry + instanceable InstanceMeta) — the shared template
    // supplies its geometry, so it joins its rep group like a materialized member.
    let mut flat: Vec<usize> = Vec::new();
    for (i, m) in meshes.iter().enumerate() {
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
            // Empty + non-instanceable = nothing to draw (skip); non-empty +
            // non-instanceable = flat singleton.
            _ if !m.positions.is_empty() => flat.push(i),
            _ => {}
        }
    }

    // Route only DRAWABLE members flat: an empty don't-bake placeholder carries no
    // geometry, so it can never render flat — the caller (the wasm don't-bake
    // finalize) recovers such occurrences flat itself before collation, so a group
    // it feeds here always has a materialized template and passes the count gate.
    // Filtering defends against ever silently emitting an empty flat singleton.
    let drawable = |members: &[usize]| -> Vec<usize> {
        members
            .iter()
            .copied()
            .filter(|&i| !meshes[i].positions.is_empty())
            .collect::<Vec<_>>()
    };

    let mut out = Collated {
        flat_indices: flat,
        ..Collated::default()
    };
    for rep in order {
        let members = &groups[&rep];
        if members.len() < min_group.max(1) {
            out.flat_indices.extend(drawable(members));
            continue;
        }
        // Template = the first NON-EMPTY (materialized) member. Empty members are
        // don't-bake placeholders whose geometry IS this template.
        let Some(t_idx) = members
            .iter()
            .copied()
            .find(|&i| !meshes[i].positions.is_empty())
        else {
            // All-empty group: no template geometry to draw against. Unreachable by
            // the caller contract (a materialized template always accompanies its
            // occurrences); drop rather than emit empty singletons that draw nothing.
            continue;
        };
        let template = &meshes[t_idx];
        // Compose in the post-RTC frame so the georeferenced offset cancels
        // exactly regardless of each occurrence's rotation (see fn docs).
        let m_ref = to_post_rtc(compose_world(template.instance_meta.unwrap()), rtc);
        let Some(m_ref_inv) = m_ref.try_inverse() else {
            out.flat_indices.extend(drawable(members));
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
            // A #1623 Phase 3 don't-bake placeholder (empty geometry) is pose-only:
            // its geometry IS the template, so skip the same-shape guard (like the
            // rigid tier). Exact-tier materialized occurrences share the SAME local
            // geometry (so same counts), differing only by placement — we can't
            // byte-compare their BAKED positions (those legitimately differ).
            // Content-equality is guaranteed upstream: rep_identity is a FULL 128-bit
            // content hash (or the RepresentationMap id), so a same-counts/
            // different-content collision is ~2^-127. The count check stays a cheap
            // guard. Rigid-tier occurrences are intentionally non-identical (verified).
            let pose_only = mesh.positions.is_empty();
            if !pose_only
                && !is_rigid
                && (mesh.positions.len() != vlen || mesh.indices.len() != ilen)
            {
                shapes_match = false;
                break;
            }
            let m_k = to_post_rtc(compose_world(mesh.instance_meta.unwrap()), rtc);
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
            out.flat_indices.extend(drawable(members));
        }
    }
    out
}

/// Compose an occurrence's full PRE-RTC world transform `transform·local·canonical`
/// as a row-major `[f64; 16]`. Public so the processing crate's don't-bake finalize
/// (#1623 Phase 2) can record the SAME world placement `collate_refs` computes for a
/// baked occurrence — without materializing the occurrence's vertices.
pub fn compose_instance_world_row_major(meta: &InstanceMeta) -> [f64; 16] {
    let m = compose_world(meta);
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)];
        }
    }
    out
}

/// Template-relative instance transform `rel = post_rtc(M_k) · post_rtc(M_ref)⁻¹`
/// as a row-major `[f32; 16]`, or `None` when `M_ref` is singular. `m_k` / `m_ref`
/// are PRE-RTC row-major world transforms (see [`compose_instance_world_row_major`]);
/// `rtc` is the model offset. This is EXACTLY `collate_refs`' per-occurrence `rel`,
/// exposed for the don't-bake finalize where the occurrence carries no geometry to
/// group — the template's baked world geometry placed by `rel` reproduces the
/// occurrence's world geometry (bounded by `verify_recomposition`). #1623 Phase 2.
pub fn instance_rel_row_major_f32(
    m_k: &[f64; 16],
    m_ref: &[f64; 16],
    rtc: [f64; 3],
) -> Option<[f32; 16]> {
    let mk = to_post_rtc(Matrix4::from_row_slice(m_k), rtc);
    let mref = to_post_rtc(Matrix4::from_row_slice(m_ref), rtc);
    let mref_inv = mref.try_inverse()?;
    Some(mat4_to_row_major_f32(&(mk * mref_inv)))
}

/// Bake a SOURCE-coords `Mesh` at a PRE-RTC row-major world transform into absolute
/// POST-RTC world geometry `(positions, normals, indices)` — the #1623 Phase 2
/// finalize fallback for a don't-bake instance whose template occurrence never
/// materialized (an orphan; effectively unreachable for the eligible single-solid
/// type-instanced set, but kept so geometry is NEVER silently lost). The affine part
/// transforms positions; the inverse-transpose of the linear part transforms normals
/// (renormalized). Geometrically equal to the baked flat occurrence (same triangles);
/// the registry source is pre-weld, so vertices are unwelded — that changes only the
/// vertex count, not the rendered surface.
pub fn bake_source_at_world(
    source: &Mesh,
    world_row_major: &[f64; 16],
    rtc: [f64; 3],
) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let m = to_post_rtc(Matrix4::from_row_slice(world_row_major), rtc);
    let vcount = source.positions.len() / 3;
    let mut positions = Vec::with_capacity(source.positions.len());
    for v in 0..vcount {
        let p = m * nalgebra::Vector4::new(
            source.positions[v * 3] as f64,
            source.positions[v * 3 + 1] as f64,
            source.positions[v * 3 + 2] as f64,
            1.0,
        );
        positions.push((p.x / p.w) as f32);
        positions.push((p.y / p.w) as f32);
        positions.push((p.z / p.w) as f32);
    }
    let linear = m.fixed_view::<3, 3>(0, 0).into_owned();
    let nmat = linear
        .try_inverse()
        .map(|inv| inv.transpose())
        .unwrap_or(linear);
    let ncount = source.normals.len() / 3;
    let mut normals = Vec::with_capacity(source.normals.len());
    for v in 0..ncount {
        let nv = nmat
            * nalgebra::Vector3::new(
                source.normals[v * 3] as f64,
                source.normals[v * 3 + 1] as f64,
                source.normals[v * 3 + 2] as f64,
            );
        let nv = nv.try_normalize(0.0).unwrap_or(nv);
        normals.push(nv.x as f32);
        normals.push(nv.y as f32);
        normals.push(nv.z as f32);
    }
    (positions, normals, source.indices.clone())
}

/// `collate_refs` over geometry `Mesh` values (thin wrapper, no geometry clone).
pub fn collate_instances(meshes: &[Mesh], min_group: usize, rtc: [f64; 3]) -> Collated {
    let refs: Vec<InstanceMeshRef> = meshes.iter().map(InstanceMeshRef::from_mesh).collect();
    collate_refs(&refs, min_group, rtc)
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
