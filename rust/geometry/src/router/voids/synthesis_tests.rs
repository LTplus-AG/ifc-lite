// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// Non-finite file coords (e.g. `1.E999` → +inf) make the bbox-fallback's
/// axis extents `inf - inf = NaN`; the old `partial_cmp().unwrap()` panicked
/// on that NaN. A zero `axis_dir` forces that fallback branch.
#[test]
fn remove_internal_membrane_no_panic_on_non_finite_coords() {
    let mut m = Mesh::new();
    // 4 triangles (the minimum the membrane pass processes), all x = +inf so
    // the fallback's ext[0] = inf - inf = NaN reaches the axis-length sort.
    for t in 0..4u32 {
        let base = t * 3;
        for k in 0..3u32 {
            m.positions
                .extend_from_slice(&[f32::INFINITY, t as f32 + k as f32, k as f32]);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }

    // Zero axis_dir → bbox fallback that sorts the NaN-bearing extents.
    let out =
        GeometryRouter::remove_internal_membrane(&m, Vector3::new(0.0, 0.0, 0.0));
    // Reaching here at all means no panic; sanity-check a well-formed result.
    assert_eq!(out.indices.len() % 3, 0);
}

/// ALL-NaN extents (every coordinate +inf, so ext = [NaN, NaN, NaN]) must
/// not panic either, and the result must be deterministic run-to-run —
/// `total_cmp` is a total order, so `max_by` resolves ties identically
/// every time (no HashMap/pointer nondeterminism can leak into the pick).
#[test]
fn remove_internal_membrane_deterministic_on_all_nan_extents() {
    let build = || {
        let mut m = Mesh::new();
        for t in 0..4u32 {
            let base = t * 3;
            for _ in 0..3u32 {
                m.positions.extend_from_slice(&[
                    f32::INFINITY,
                    f32::INFINITY,
                    f32::INFINITY,
                ]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    };
    let a = GeometryRouter::remove_internal_membrane(&build(), Vector3::new(0.0, 0.0, 0.0));
    let b = GeometryRouter::remove_internal_membrane(&build(), Vector3::new(0.0, 0.0, 0.0));
    assert_eq!(a.indices, b.indices, "all-NaN extents must pick a deterministic axis");
    assert_eq!(a.positions.len(), b.positions.len());
    assert_eq!(a.indices.len() % 3, 0);
}

/// Pin the semantics the fix relies on: `total_cmp` orders -0.0 < 0.0 and
/// finite < NaN, and `max_by` keeps the LAST maximum on ties — so the axis
/// pick over any extent triple (including NaN and signed zeros) is total,
/// panic-free, and deterministic. This mirrors the exact selection
/// expression in `remove_internal_membrane`'s bbox fallback.
#[test]
fn axis_pick_total_order_semantics() {
    let pick = |ext: [f64; 3]| -> usize {
        (0..3).max_by(|&i, &j| ext[i].total_cmp(&ext[j])).unwrap()
    };
    assert_eq!(pick([-0.0, 0.0, -1.0]), 1, "+0.0 outranks -0.0 in the total order");
    assert_eq!(pick([0.0, 0.0, 0.0]), 2, "ties resolve to the last index");
    assert_eq!(pick([f64::NAN, f64::NAN, f64::NAN]), 2, "all-NaN ties resolve to the last index");
    assert_eq!(pick([f64::NAN, 1.0, 2.0]), 0, "positive NaN outranks finite values");
    assert_eq!(pick([1.0, f64::INFINITY, f64::NAN]), 2, "positive NaN outranks +inf");
}
