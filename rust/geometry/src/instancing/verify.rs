// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-group reconstruction verification for `collate_refs` (issue #3666).
//!
//! `rep_identity` is documented as a guarantee that every occurrence sharing
//! it bakes from the SAME canonical geometry, but the guarantee is only as
//! strong as the hash behind it. A run over a large multi-model merge found
//! 28 of 6395 occurrences (11 `rep_identity` groups) where that did not hold:
//! reconstructing an occurrence from its template and per-instance transform
//! landed up to 2.0m away from the occurrence's own baked vertices — a
//! `rep_identity` collision between unrelated geometry from different source
//! models, with nothing on the path erroring, warning, or logging. The
//! occurrence still rendered, just in the wrong place.
//!
//! `collate_refs` previously trusted `rep_identity` outright: it computed
//! `rel` for every member of a group from placement metadata alone, with no
//! way to notice a wrong pairing (the exact-tier guard only compared vertex
//! and index COUNTS, which a same-shaped colliding pair still passes). This
//! module reconstructs each occurrence's own baked world vertices from
//! `(template, rel)` and compares them against the occurrence's OWN baked
//! vertices — the same computation `verify_recomposition` already performs
//! as an out-of-band diagnostic/test helper — but run inline, per candidate
//! pairing, on the production path, so a failing group falls back to the
//! flat (unshared) path instead of shipping a mis-grouped occurrence.
//!
//! Scoped to the exact tier only (see `collate_refs`): the RIGID tier
//! substitutes a congruent-but-not-bit-identical template by design, so its
//! members can legitimately carry a different raw vertex count than the
//! template — this check would reject correct rigid groups, not just
//! colliding ones. Rigid-tier congruence is established (and, per its own
//! doc comment, verified) upstream of collation via `canonical_transform`.
//!
//! **Frame contract.** `verify_pairing` reconstructs by applying `rel` — which
//! is always computed from `InstanceMeta.transform`, native-frame (IFC Z-up) —
//! to the template's OWN baked vertices, so the comparison is only valid when
//! the baked vertices it is handed (`template.positions`/`mesh.positions`) are
//! ALSO in that native frame. `collate_refs_verified_in`'s `verify_basis`
//! parameter exists because the glTF exporter's in-memory assembler converts
//! every visible mesh's baked positions Z-up→Y-up BEFORE calling in (so the
//! template/flat geometry it emits is already Y-up), while `InstanceMeta`
//! itself stays Z-up throughout — the per-occurrence node matrix is
//! independently recomposed and Y-up-conjugated downstream (`occurrence_node_matrix`
//! in the export crate), never reading this module's `rel` back. Left
//! unaccounted for, that frame mismatch reads as a `rep_identity` collision on
//! nearly every rotated group in a real model (a Z-up `rel` reconstructing
//! against Y-up vertices), which is what motivated this parameter rather than
//! loosening [`tolerance`] — the mismatch is orders of magnitude larger than
//! any plausible tolerance, in either direction, at every coordinate scale.

use super::collate::Collated;
use crate::mesh::Mesh;
use nalgebra::{Matrix4, Vector4};

/// Reconstruction tolerance at world-coordinate magnitude `mag` (metres):
/// relative to the vertex's own magnitude (f32 ULP-scale — the same
/// far-from-origin precedent `rect_fast.rs`'s watertight-cut volume check
/// uses, where a wall 220km from the origin carries ~12mm of inherent f32
/// error per coordinate and a fixed epsilon there would be meaningless) OR a
/// micrometre-scale floor near the origin, whichever is larger. f32 stores
/// positions at ~2^-23 relative precision; composing and applying `rel` (a
/// handful of float ops) can accumulate a few ULPs of drift beyond that,
/// hence the small multiplier. A genuine `rep_identity` collision (#3666)
/// misplaces geometry by the FULL offset between two unrelated shapes —
/// metres, per the issue's own measurement — so it clears this tolerance at
/// any coordinate magnitude; only recomposition noise between truly-shared
/// geometry stays under it.
const ABS_FLOOR_M: f64 = 1e-6;
// 8 * 2^-23 (f32 ULP), computed out-of-line: `powi` is not `const fn` here.
const ULP_FACTOR: f64 = 9.5367431640625e-7;

fn tolerance(mag: f64) -> f64 {
    (mag * ULP_FACTOR).max(ABS_FLOOR_M)
}

/// Reconstructed world-space error of vertex `v`: applies `rel` to the
/// template's own baked world vertex (`template_origin + template_positions[v]`)
/// and returns its distance from the occurrence's own baked world vertex
/// (`target_origin + target_positions[v]`). This is the one reconstruction
/// kernel both [`verify_pairing`] (the inline pass/fail gate) and
/// [`verify_recomposition`] (the out-of-band diagnostic max-error scan) run —
/// same math, different verdicts drawn from it — so a frame or precision fix
/// here reaches both instead of needing to be made twice.
fn reconstructed_vertex_error(
    template_origin: [f64; 3],
    template_positions: &[f32],
    target_origin: [f64; 3],
    target_positions: &[f32],
    rel: &Matrix4<f64>,
    v: usize,
) -> f64 {
    let tx = template_origin[0] + template_positions[v * 3] as f64;
    let ty = template_origin[1] + template_positions[v * 3 + 1] as f64;
    let tz = template_origin[2] + template_positions[v * 3 + 2] as f64;
    let w = rel * Vector4::new(tx, ty, tz, 1.0);
    let (rx, ry, rz) = (w.x / w.w, w.y / w.w, w.z / w.w);
    let gx = target_origin[0] + target_positions[v * 3] as f64;
    let gy = target_origin[1] + target_positions[v * 3 + 1] as f64;
    let gz = target_origin[2] + target_positions[v * 3 + 2] as f64;
    ((rx - gx).powi(2) + (ry - gy).powi(2) + (rz - gz).powi(2)).sqrt()
}

/// Verify a candidate template<->occurrence pairing: applying `rel` to every
/// one of the template's own baked world vertices
/// (`template_origin + template_positions`) must reproduce the occurrence's
/// own baked world vertices (`target_origin + target_positions`) within
/// [`tolerance`]. A vertex-count mismatch is treated as failure (an
/// occurrence claiming a different raw vertex count than its template cannot
/// be recomposed from it) rather than panicking on an out-of-bounds index.
pub(super) fn verify_pairing(
    template_origin: [f64; 3],
    template_positions: &[f32],
    target_origin: [f64; 3],
    target_positions: &[f32],
    rel: &Matrix4<f64>,
) -> bool {
    let n = template_positions.len() / 3;
    if target_positions.len() / 3 != n {
        return false;
    }
    for v in 0..n {
        let err = reconstructed_vertex_error(
            template_origin,
            template_positions,
            target_origin,
            target_positions,
            rel,
            v,
        );
        // Scale by the STORED (origin-relative) position, not the absolute
        // world coordinate (target_origin + position): the f32 quantization
        // this tolerance accounts for lives in the stored position, and for
        // a georeferenced mesh `origin` alone can carry a multi-million-metre
        // offset while positions stay small local deltas. Scaling off the
        // absolute coordinate inflates tolerance with the georeference
        // itself, wide enough to wave through a genuine rep_identity
        // collision (#3666 measured up to 2.0m) at real-world georeferenced
        // magnitudes -- the same "scaled tolerance flips direction across
        // the range" shape this project has hit before.
        let mag = (target_positions[v * 3] as f64)
            .abs()
            .max((target_positions[v * 3 + 1] as f64).abs())
            .max((target_positions[v * 3 + 2] as f64).abs());
        // `err.is_nan()` must be checked explicitly: `err > tolerance(mag)`
        // is false whenever `err` is NaN (a NaN transform or position
        // propagates through the matrix multiply and subtraction into a NaN
        // `err`), so an unguarded comparison here is fail-open in the one
        // check that exists to fail closed on a bad reconstruction.
        if err.is_nan() || err > tolerance(mag) {
            return false;
        }
    }
    true
}

/// Maximum per-vertex world-space error (in mesh units) when each occurrence is
/// reconstructed by applying its instance transform to the template's baked
/// world geometry, versus the occurrence's own baked world geometry. The
/// template-relative transform operates on world coords, so each mesh's `origin`
/// is folded in. Used by tests + as a runtime diagnostic — [`verify_pairing`]
/// above runs the same [`reconstructed_vertex_error`] kernel inline, per
/// candidate group, so a production caller never has to run this after the
/// fact to find out its `Collated` shipped a mis-grouped occurrence.
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
                let err = reconstructed_vertex_error(
                    template.origin,
                    &template.positions,
                    target.origin,
                    &target.positions,
                    &rel,
                    v,
                );
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

    #[test]
    fn tolerance_scales_with_magnitude_above_the_floor() {
        assert_eq!(tolerance(0.0), ABS_FLOOR_M);
        assert_eq!(tolerance(1.0), ABS_FLOOR_M);
        // At 220km (the rect_fast.rs far-from-origin precedent), the
        // ULP-scale term dominates and lands in the low-decimetre range —
        // wider than the origin floor, narrower than the metre-scale
        // collision residual #3666 measured (so a genuine collision still
        // fails this check by an order of magnitude even at this range).
        let far = tolerance(220_000.0);
        assert!(
            far > ABS_FLOOR_M && far < 1.0,
            "expected a sub-metre tolerance at 220km, got {far}"
        );
    }

    #[test]
    fn identical_geometry_through_identity_rel_passes() {
        let positions: [f32; 6] = [0.0, 0.0, 0.0, 1.0, 2.0, 3.0];
        let identity = Matrix4::identity();
        assert!(verify_pairing(
            [0.0, 0.0, 0.0],
            &positions,
            [0.0, 0.0, 0.0],
            &positions,
            &identity,
        ));
    }

    #[test]
    fn a_translated_target_fails_identity_rel() {
        let template: [f32; 3] = [0.0, 0.0, 0.0];
        // Same vertex COUNT, but genuinely different geometry (as a hash
        // collision between two unrelated shapes would produce) — must not
        // pass under the transform that maps the template onto itself.
        let target: [f32; 3] = [2.0, 0.0, 0.0];
        let identity = Matrix4::identity();
        assert!(!verify_pairing(
            [0.0, 0.0, 0.0],
            &template,
            [0.0, 0.0, 0.0],
            &target,
            &identity,
        ));
    }

    #[test]
    fn a_nan_in_the_transform_fails_verification_instead_of_passing() {
        // `err > tolerance(mag)` alone is false for NaN, so a NaN anywhere in
        // `rel` must be caught explicitly rather than silently verifying.
        let template: [f32; 3] = [0.0, 0.0, 0.0];
        let target: [f32; 3] = [0.0, 0.0, 0.0];
        let mut rel = Matrix4::identity();
        rel[(0, 0)] = f64::NAN;
        assert!(
            !verify_pairing([0.0, 0.0, 0.0], &template, [0.0, 0.0, 0.0], &target, &rel),
            "a NaN transform must not pass reconstruction verification"
        );
    }

    #[test]
    fn a_nan_in_a_position_fails_verification_instead_of_passing() {
        // Same fail-open shape, sourced from a NaN baked coordinate rather
        // than a NaN transform.
        let template: [f32; 3] = [f64::NAN as f32, 0.0, 0.0];
        let target: [f32; 3] = [0.0, 0.0, 0.0];
        let identity = Matrix4::identity();
        assert!(
            !verify_pairing(
                [0.0, 0.0, 0.0],
                &template,
                [0.0, 0.0, 0.0],
                &target,
                &identity,
            ),
            "a NaN position must not pass reconstruction verification"
        );
    }

    #[test]
    fn a_genuine_match_still_passes_after_the_nan_guard() {
        // The NaN guard must not turn into a guard that rejects everything —
        // a real matching pair (non-trivial transform, non-zero vertices)
        // still has to clear verification.
        let template: [f32; 6] = [0.0, 0.0, 0.0, 1.0, 2.0, 3.0];
        let rel = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, -2.0, 0.5));
        let target: [f32; 6] = [5.0, -2.0, 0.5, 6.0, 0.0, 3.5];
        assert!(
            verify_pairing(
                [0.0, 0.0, 0.0],
                &template,
                [0.0, 0.0, 0.0],
                &target,
                &rel,
            ),
            "a genuine matching pair must still pass verification"
        );
    }
}
