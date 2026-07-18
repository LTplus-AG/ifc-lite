// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the fuzzy f64 subtract tier. These exercise the fuzzy path
//! DIRECTLY (not through the env gate), so they run regardless of
//! `IFC_LITE_FUZZY_BOOL`.

use super::super::arrangement::{box_mesh, cube_mesh};
use super::super::arrangement::Tri;
use super::{is_watertight, subtract};

fn vol6(tris: &[Tri]) -> f64 {
    // ×6 signed volume about origin — inputs here are near-origin boxes.
    tris.iter()
        .map(|t| {
            let cr = [
                t[1][1] * t[2][2] - t[1][2] * t[2][1],
                t[1][2] * t[2][0] - t[1][0] * t[2][2],
                t[1][0] * t[2][1] - t[1][1] * t[2][0],
            ];
            t[0][0] * cr[0] + t[0][1] * cr[1] + t[0][2] * cr[2]
        })
        .sum()
}

fn vol(tris: &[Tri]) -> f64 {
    vol6(tris) / 6.0
}

/// A single box subtracted from a slab: the fuzzy result must be watertight and
/// match the exact box−box volume, with the opening actually removed.
#[test]
fn fuzzy_box_from_slab_is_watertight_and_exact_volume() {
    // slab [0,4]×[0,3]×[0,0.2] (vol 2.4) minus a through-opening box
    // [1,2]×[1,2]×[-0.5,0.7] (removed 0.2) ⇒ 2.2.
    let host = box_mesh([0., 0., 0.], [4., 3., 0.2]);
    let opening = box_mesh([1., 1., -0.5], [2., 2., 0.7]);
    let result = subtract(&host, &[opening]).expect("fuzzy subtract produced no mesh");
    assert!(is_watertight(&result), "fuzzy result is not watertight");
    let v = vol(&result);
    assert!((v - 2.2).abs() < 2e-3, "fuzzy volume = {v}, expected ~2.2 (snap-scale tol)");
}

/// Two pairwise-disjoint through-openings: fuzzy result watertight + analytic
/// volume, the same 3-D contract the exact `subtract_many` verifies.
#[test]
fn fuzzy_two_disjoint_openings_match_analytic() {
    let host = box_mesh([0., 0., 0.], [6., 3., 0.2]); // vol 3.6
    let op1 = box_mesh([1., 1., -0.5], [2., 2., 0.7]); // 0.2
    let op2 = box_mesh([4., 1., -0.5], [5., 2., 0.7]); // 0.2
    let result = subtract(&host, &[op1, op2]).expect("fuzzy subtract produced no mesh");
    assert!(is_watertight(&result), "fuzzy result is not watertight");
    let v = vol(&result);
    assert!((v - 3.2).abs() < 2e-3, "fuzzy volume = {v}, expected ~3.2 (snap-scale tol)");
}

/// Corner-overlap cube−cube (the classic 7-of-8 case): watertight + volume 7.
#[test]
fn fuzzy_corner_overlap_cube_is_exact() {
    let host = cube_mesh(0.0, 2.0); // vol 8
    let cutter = cube_mesh(1.0, 3.0); // overlap [1,2]³ = 1
    let result = subtract(&host, &[cutter]).expect("fuzzy subtract produced no mesh");
    assert!(is_watertight(&result), "fuzzy corner-overlap result not watertight");
    let v = vol(&result);
    assert!((v - 7.0).abs() < 1e-6, "fuzzy volume = {v}, expected 7");
}

/// Determinism: the same input yields byte-identical output triangles (the
/// fuzzy path must be reproducible, the manifest precondition).
#[test]
fn fuzzy_subtract_is_deterministic() {
    let host = box_mesh([0., 0., 0.], [6., 3., 0.2]);
    let op1 = box_mesh([1., 1., -0.5], [2., 2., 0.7]);
    let op2 = box_mesh([4., 1., -0.5], [5., 2., 0.7]);
    let a = subtract(&host, &[op1.clone(), op2.clone()]).unwrap();
    let b = subtract(&host, &[op1, op2]).unwrap();
    assert_eq!(a.len(), b.len(), "fuzzy output triangle count varied");
    for (ta, tb) in a.iter().zip(b.iter()) {
        for k in 0..3 {
            for c in 0..3 {
                assert_eq!(
                    ta[k][c].to_bits(),
                    tb[k][c].to_bits(),
                    "fuzzy output not bit-identical across runs"
                );
            }
        }
    }
}

/// A disjoint (non-overlapping) cutter removes nothing: every host face is kept,
/// no cutter face is inside the host — the result equals the host (watertight,
/// same volume). Guards the classification "outside stays" branch.
#[test]
fn fuzzy_disjoint_cutter_keeps_host() {
    let host = cube_mesh(0.0, 1.0); // vol 1
    let far = cube_mesh(5.0, 6.0); // no overlap
    // No candidate pairs ⇒ every face passes through; result is the host itself.
    let result = subtract(&host, &[far]).expect("fuzzy subtract produced no mesh");
    assert!(is_watertight(&result), "disjoint result not watertight");
    let v = vol(&result);
    assert!((v - 1.0).abs() < 1e-9, "disjoint fuzzy volume = {v}, expected 1");
}

/// `is_watertight` rejects an open surface (a single triangle) — the guard the
/// self-check relies on to force exact fallback on a torn fuzzy result.
#[test]
fn watertight_rejects_open_surface() {
    let open: Vec<Tri> = vec![[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]];
    assert!(!is_watertight(&open), "a lone triangle must read as not watertight");
    assert!(!is_watertight(&[]), "empty must read as not watertight");
    // A closed box reads watertight.
    assert!(is_watertight(&cube_mesh(0.0, 1.0)), "a closed box must read watertight");
}

/// A FLUSH-BOTTOM notch (cutter bottom coplanar with the host bottom, top and
/// sides transversal) is a partial coplanar interface the transversal fuzzy
/// intersection does not resolve, so it produces a NON-watertight result — which
/// the self-check catches, forcing `subtract_many` to discard it and run the
/// exact kernel. This pins the fallback trigger: a torn fuzzy result is never
/// accepted (correctness cannot regress). The exact kernel handles this case.
#[test]
fn fuzzy_flush_bottom_notch_fails_self_check() {
    let host = box_mesh([0., 0., 0.], [4., 4., 2.]);
    let cutter = box_mesh([1., 1., 0.], [3., 3., 1.]); // bottom z=0 flush with host
    let rejected = match subtract(&host, &[cutter]) {
        None => true,                  // structurally gave up ⇒ fall back
        Some(m) => !is_watertight(&m), // torn ⇒ self-check rejects ⇒ fall back
    };
    assert!(
        rejected,
        "flush-bottom fuzzy result must fail the watertight self-check so the exact kernel takes over"
    );
}

/// Default-OFF guard: with no `IFC_LITE_FUZZY_BOOL` in the environment the tier
/// is disabled, so a default build routes every subtract through the exact
/// kernel and is byte-identical to `main` (and the `mesh_determinism` manifest
/// is unperturbed). The A/B and any future default flip are explicit opt-ins.
#[test]
fn fuzzy_tier_is_off_by_default() {
    // Only meaningful when the env does NOT force the tier on (the CI `=0` leg
    // and a bare run); a deliberate `IFC_LITE_FUZZY_BOOL=1` A/B leg is exempt so
    // this test never contradicts the "with it ON, green" requirement.
    if std::env::var_os("IFC_LITE_FUZZY_BOOL").is_none() {
        assert!(!super::enabled(), "fuzzy tier must be OFF unless IFC_LITE_FUZZY_BOOL opts in");
    }
}
