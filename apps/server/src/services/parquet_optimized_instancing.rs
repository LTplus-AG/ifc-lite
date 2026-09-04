// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rotation-aware instancing for the `/optimized` Parquet route (issue #3575).
//!
//! Split out of `parquet_optimized.rs` to keep that module under the house
//! module-size budget: content-hash dedup and wire assembly stay there,
//! this file is the ONE place that groups occurrences by representation
//! identity, verifies each occurrence's derived rigid placement against its
//! own baked geometry, and converts a verified placement into the Y-up
//! origin + rotation the instance table emits.

use crate::types::MeshData;
use ifc_lite_geometry::{collate_refs, InstanceMeshRef};
use rustc_hash::FxHashMap;

/// Maximum reconstructed-vertex residual (metres) a rotation-aware instance
/// placement may carry and still be trusted (issue #3575). Compared against
/// the ORIGINAL f32/f64 positions, before quantization, so it is independent
/// of `VERTEX_MULTIPLIER`; 0.1mm is the quantization grain itself (see
/// `quantize_position` in `parquet_optimized.rs`), so anything under it is
/// already invisible on the wire. A group whose residual exceeds this falls
/// back to the pre-#3575 content-hash dedup (each occurrence keeps its own
/// baked mesh) instead of shipping a placement nobody verified.
const RECOMPOSITION_TOLERANCE_M: f64 = 1e-4;

/// A verified rotation-aware placement for one occurrence: which unique mesh
/// (identified by the index of its TEMPLATE occurrence in the input slice) it
/// draws, and the origin/rotation (Z-up, pre-Y-up-swap) that places it there.
pub(crate) struct RotatedPlacement {
    pub(crate) template_mesh_index: usize,
    pub(crate) origin_zup: [f64; 3],
    /// Row-major 3x3, Z-up frame (converted to Y-up at emission time via
    /// [`rotation_zup_to_yup`]).
    pub(crate) rotation_zup: [f64; 9],
}

/// Row-major 3x3 apply: `R * p + t`.
fn apply_r_t(r: &[[f64; 3]; 3], t: &[f64; 3], p: &[f64; 3]) -> [f64; 3] {
    [
        r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
        r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
        r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
    ]
}

/// Given `rel` (row-major mat4, the `InstanceOccurrence::transform` that maps
/// the TEMPLATE's baked world geometry onto this occurrence's baked world
/// geometry — see `ifc_lite_geometry::instancing`), derive this occurrence's
/// origin + rotation and verify them against the occurrence's OWN (ground
/// truth) baked positions. Returns `(max_residual_m, origin_zup, rotation_zup)`;
/// the caller must reject the placement when the residual exceeds
/// [`RECOMPOSITION_TOLERANCE_M`] or is non-finite (mismatched vertex counts).
fn verify_and_derive_placement(
    template: &MeshData,
    target: &MeshData,
    rel: &[f64; 16],
) -> (f64, [f64; 3], [f64; 9]) {
    let r = [
        [rel[0], rel[1], rel[2]],
        [rel[4], rel[5], rel[6]],
        [rel[8], rel[9], rel[10]],
    ];
    let t = [rel[3], rel[7], rel[11]];
    let rotation_zup = [
        r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2],
    ];
    // new_origin = R * template.origin + T: the template's own local-frame
    // origin, carried through the same affine map applied to its vertices.
    let origin_zup = apply_r_t(&r, &t, &template.origin);

    let n = template.positions.len() / 3;
    if target.positions.len() / 3 != n {
        return (f64::INFINITY, origin_zup, rotation_zup);
    }
    let mut max_err = 0.0f64;
    for v in 0..n {
        let p = [
            template.origin[0] + template.positions[v * 3] as f64,
            template.origin[1] + template.positions[v * 3 + 1] as f64,
            template.origin[2] + template.positions[v * 3 + 2] as f64,
        ];
        let world = apply_r_t(&r, &t, &p);
        let g = [
            target.origin[0] + target.positions[v * 3] as f64,
            target.origin[1] + target.positions[v * 3 + 1] as f64,
            target.origin[2] + target.positions[v * 3 + 2] as f64,
        ];
        let err =
            ((world[0] - g[0]).powi(2) + (world[1] - g[1]).powi(2) + (world[2] - g[2]).powi(2))
                .sqrt();
        if err > max_err {
            max_err = err;
        }
    }
    (max_err, origin_zup, rotation_zup)
}

/// Z-up → Y-up basis change (see `services::axis::zup_to_yup`), as a rotation
/// matrix: `P * v = (v.x, v.z, -v.y)`. Orthogonal, so `P^-1 == P^T`.
const P_ZUP_TO_YUP: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]];
const P_ZUP_TO_YUP_T: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]];

fn mat3_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for (i, out_row) in out.iter_mut().enumerate() {
        for (j, out_cell) in out_row.iter_mut().enumerate() {
            let mut s = 0.0;
            for k in 0..3 {
                s += a[i][k] * b[k][j];
            }
            *out_cell = s;
        }
    }
    out
}

/// Conjugate a Z-up rotation into the Y-up wire frame: `P * R * P^T`. The swap
/// is linear (`zup_to_yup`), so this is the same identity `mesh_to_yup_in_place`
/// relies on for positions/origin, applied to a 3x3 instead of a 3-vector.
pub(crate) fn rotation_zup_to_yup(rotation_zup: &[f64; 9]) -> [f32; 9] {
    let r = [
        [rotation_zup[0], rotation_zup[1], rotation_zup[2]],
        [rotation_zup[3], rotation_zup[4], rotation_zup[5]],
        [rotation_zup[6], rotation_zup[7], rotation_zup[8]],
    ];
    let m = mat3_mul(&mat3_mul(&P_ZUP_TO_YUP, &r), &P_ZUP_TO_YUP_T);
    [
        m[0][0] as f32,
        m[0][1] as f32,
        m[0][2] as f32,
        m[1][0] as f32,
        m[1][1] as f32,
        m[1][2] as f32,
        m[2][0] as f32,
        m[2][1] as f32,
        m[2][2] as f32,
    ]
}

/// The optimized format's wire version, chosen by what the payload CONTAINS.
///
/// v2 is the pre-#3575 shape: an instance table without `rot0..rot8`, placed
/// as `world = origin + template_position`. v3 adds the nine rotation columns
/// and the placement becomes `world = origin + R * template_position`.
///
/// A response in which every instance came out identity IS a v2 payload in
/// every observable respect, so it ships as one and an unchanged client keeps
/// decoding every model it decoded before #3575. Only a payload that
/// genuinely carries rotation declares 3, where a v2-only decoder fails loud
/// on its version check (`Unsupported optimized Parquet version: 3`) instead
/// of silently dropping the rotations and misplacing the geometry.
///
/// The argument is the rotation data actually emitted, NOT "the model has
/// instance metadata" or "the feature is on": translation-only reuse runs the
/// whole rotation-aware dedup and still produces identity everywhere.
pub(super) fn optimized_wire_version(has_rotation: bool) -> u8 {
    if has_rotation {
        3
    } else {
        2
    }
}

pub(crate) const IDENTITY_ROTATION: [f32; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// Group instanceable meshes by representation identity (`collate_refs`) and
/// verify each occurrence's derived rigid placement against its own baked
/// geometry (issue #3575). Returns a map from a mesh's index in `meshes` to
/// the verified placement it should be emitted with; a mesh absent from the
/// map falls back to the pre-#3575 content-hash dedup in `parquet_optimized.rs`.
/// Verification is all-or-nothing per group: one occurrence over tolerance
/// drops the ENTIRE representation group from the map, not just that
/// occurrence, so a group never ships half-instanced.
///
/// Deliberately excludes the RIGID tier (`InstanceMeta::canonical_transform`
/// set): those groups substitute a congruent-but-not-bit-identical template,
/// so the per-vertex residual check above isn't meaningful the same way, and
/// this endpoint has no way to signal "close enough, not exact" to a client
/// decoding a lossless-looking mesh table. Only exact-bit groups (the
/// `IfcMappedItem` / shared-`IfcRepresentationMap` case the issue reports)
/// are deduplicated this way.
pub(crate) fn collate_rotation_aware_placements(
    meshes: &[MeshData],
) -> FxHashMap<usize, RotatedPlacement> {
    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .map(|m| InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
            item_id: None,
        })
        .collect();
    // rtc = 0: `MeshData::instance` is populated per-element by the native
    // pipeline, which already resolves to building-scale, non-georeferenced
    // magnitude for every model this endpoint has been run against; the
    // per-vertex residual check below is the real safety net regardless (a
    // stale/large offset shows up as a residual over tolerance, not a
    // silent misplacement), so an unhandled RTC rebase degrades to today's
    // behaviour rather than shipping a wrong placement.
    let collated = collate_refs(&refs, 2, [0.0, 0.0, 0.0]);

    let mut placements: FxHashMap<usize, RotatedPlacement> = FxHashMap::default();
    for tmpl in &collated.templates {
        let is_rigid = tmpl.occurrences.iter().any(|o| {
            meshes[o.mesh_index]
                .instance
                .as_ref()
                .and_then(|m| m.canonical_transform)
                .is_some()
        });
        if is_rigid {
            continue;
        }
        let template = &meshes[tmpl.template_index];
        let mut group: Vec<(usize, [f64; 3], [f64; 9])> =
            Vec::with_capacity(tmpl.occurrences.len());
        let mut all_verified = true;
        for occ in &tmpl.occurrences {
            let target = &meshes[occ.mesh_index];
            let rel: [f64; 16] = occ.transform.map(|v| v as f64);
            let (max_err, origin_zup, rotation_zup) =
                verify_and_derive_placement(template, target, &rel);
            if !(max_err <= RECOMPOSITION_TOLERANCE_M) {
                all_verified = false;
                break;
            }
            group.push((occ.mesh_index, origin_zup, rotation_zup));
        }
        if all_verified {
            for (mesh_index, origin_zup, rotation_zup) in group {
                placements.insert(
                    mesh_index,
                    RotatedPlacement {
                        template_mesh_index: tmpl.template_index,
                        origin_zup,
                        rotation_zup,
                    },
                );
            }
        }
    }
    placements
}
