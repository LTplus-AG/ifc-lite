// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `mesh_frame.rs`, split out under the house pattern (AGENTS.md).
//! Regression tests for #4611 (one frame selection for native and browser)
//! and #7684 (one way back from the frame to IFC world).

use super::*;

const FAR: (f64, f64, f64) = (2_679_062.0, 1_247_992.0, 532.0);
const LARGE_FAR: RtcVerdict = RtcVerdict::Large { anchor: FAR };

/// A column-major 4x4 site placement: identity rotation, `t` translation.
fn site_at(t: (f64, f64, f64)) -> [f64; 16] {
    let mut m = [0.0; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m[12] = t.0;
    m[13] = t.1;
    m[14] = t.2;
    m
}

/// The same, yawed `degrees` about Z.
fn site_at_yawed(t: (f64, f64, f64), degrees: f64) -> [f64; 16] {
    let (s, c) = degrees.to_radians().sin_cos();
    let mut m = site_at(t);
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
    m
}

/// The site tier wins whenever the site is translated at all, and it wins
/// over a detected anchor. Deleting the site arm of `select` sends the
/// first two cases to `ModelRtc`/`RawIfc`.
#[test]
fn a_translated_site_selects_site_local_over_everything() {
    let placement = site_at((500.0, 0.0, 0.0));
    let frame = MeshFrame::select(Some(&placement), Some(LARGE_FAR));
    assert_eq!(frame, MeshFrame::SiteLocal { placement });
    assert_eq!(frame.rtc_offset(), (500.0, 0.0, 0.0));
    assert!(frame.needs_shift());
    assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
    let tiny = site_at((0.0, 0.0, 1e-6));
    assert_eq!(
        MeshFrame::select(Some(&tiny), None),
        MeshFrame::SiteLocal { placement: tiny }
    );
}

/// An identity (or absent) site falls through to the detector's anchor.
#[test]
fn an_identity_site_falls_through_to_the_detected_anchor() {
    let identity = site_at((0.0, 0.0, 0.0));
    let sub_epsilon = site_at((1e-10, -1e-10, 0.0));
    for site in [None, Some(&identity), Some(&sub_epsilon)] {
        let frame = MeshFrame::select(site.map(|m| &m[..]), Some(LARGE_FAR));
        assert_eq!(frame, MeshFrame::ModelRtc { anchor: FAR }, "site {site:?}");
        assert_eq!(frame.rtc_offset(), FAR);
        assert!(frame.needs_shift());
        assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::ModelRtc);
    }
}

/// "Detector found nothing" and "detector found only small coordinates"
/// both mean raw IFC, with a zero offset and no shift. A frame that said
/// `needs_shift` with a zero offset cannot be built.
#[test]
fn no_site_and_no_anchor_is_raw_ifc_with_nothing_to_subtract() {
    for detected in [None, Some(RtcVerdict::Small)] {
        let frame = MeshFrame::select(None, detected);
        assert_eq!(frame, MeshFrame::RawIfc, "detected {detected:?}");
        assert_eq!(frame.rtc_offset(), (0.0, 0.0, 0.0));
        assert!(!frame.needs_shift());
        assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::RawIfc);
    }
}

/// #4643 (gate lowered to 1 km by #4934): a `Large` verdict whose anchor
/// is inside the gate (bbox centre for a 200 m to 1.5 km extent) is still
/// subtracted; judging the anchor's own magnitude cast 1.5 km straight to
/// f32. Origin-anchored `Large` has nothing to subtract; re-gating the
/// anchor arm on `coord_is_large` fails the loop.
#[test]
fn a_large_verdict_with_a_sub_threshold_anchor_is_subtracted() {
    for anchor in [(-500.0, 0.0, 0.0), (850.0, 0.0, 0.0), (0.0, 0.0, 1_000.0)] {
        let frame = MeshFrame::select(None, Some(RtcVerdict::Large { anchor }));
        assert_eq!(frame, MeshFrame::ModelRtc { anchor }, "{anchor:?}");
        assert!(frame.needs_shift());
    }
    let at_origin = RtcVerdict::Large { anchor: (0.0, 0.0, 0.0) };
    assert_eq!(MeshFrame::select(None, Some(at_origin)), MeshFrame::RawIfc);
}

/// Why `ifc_lite_ffi::normalize_to_site_local` could be deleted: it
/// subtracted the site translation from `raw_ifc` output whenever the site
/// sat more than 1 km from the origin, and that input cannot be produced.
/// Any site translation past the identity epsilon selects `SiteLocal`, so
/// `RawIfc` with a translated site is not a state the selector can emit.
/// Removing the `translation_is_nonidentity` filter on the site arm, or
/// the site arm itself, fails this.
#[test]
fn raw_ifc_is_never_selected_beside_a_translated_site() {
    for translation in [
        (1e-8, 0.0, 0.0),
        (999.0, 0.0, 0.0),
        (1_000.5, 0.0, 0.0),
        (0.0, -1_500.0, 0.0),
        FAR,
    ] {
        let placement = site_at(translation);
        for detected in [None, Some(RtcVerdict::Small), Some(LARGE_FAR)] {
            let frame = MeshFrame::select(Some(&placement), detected);
            assert_ne!(frame, MeshFrame::RawIfc, "{translation:?} / {detected:?}");
            assert_eq!(frame.coordinate_space(), MeshCoordinateSpace::SiteLocal);
        }
    }
    assert_eq!(
        MeshFrame::select(Some(&site_at((0.0, 0.0, 0.0))), None),
        MeshFrame::RawIfc
    );
}

/// The rotation half of the frame (#4706). `rotate_into_frame` must be
/// `Rᵀ` — the SAME inverse rotation `convert_mesh_to_site_local` applies
/// to the vertices — for the site tier, and the identity for the other
/// two, which remove no rotation. A site yawed 30 degrees maps its own
/// +X axis, `(cos30, sin30, 0)` in world, back onto `(1, 0, 0)`.
/// Transposing the matrix here (reading rows instead of columns) turns
/// the yaw the wrong way and fails on the sign of the second component.
#[test]
fn the_site_tier_undoes_its_own_yaw_and_the_others_rotate_nothing() {
    let yawed = MeshFrame::select(Some(&site_at_yawed((500.0, 300.0, 0.0), 30.0)), None);
    let (s, c) = 30.0f64.to_radians().sin_cos();
    let back = yawed.rotate_into_frame([c, s, 0.0]);
    for (i, want) in [1.0, 0.0, 0.0].iter().enumerate() {
        assert!((back[i] - want).abs() < 1e-12, "axis {i}: {back:?}");
    }
    // A world point on the site origin lands ON the frame origin.
    let offset = yawed.rtc_offset();
    let at_origin = yawed.rotate_into_frame([
        500.0 - offset.0,
        300.0 - offset.1,
        0.0 - offset.2,
    ]);
    assert_eq!(at_origin, [0.0, 0.0, 0.0]);

    let v = [3.0, -7.0, 2.0];
    let translated_only = MeshFrame::select(Some(&site_at((500.0, 300.0, 0.0))), None);
    assert_eq!(translated_only.rotate_into_frame(v), v);
    assert_eq!(
        MeshFrame::select(None, Some(LARGE_FAR)).rotate_into_frame(v),
        v
    );
    assert_eq!(MeshFrame::RawIfc.rotate_into_frame(v), v);
}

/// The wire contract. The three strings are what every consumer (the TS
/// server client, the FFI host, the Python binding) reads back, so a
/// renamed variant or a changed `rename_all` must fail here, not in a
/// downstream deserializer.
#[test]
fn wire_strings_are_the_documented_snake_case_tags() {
    for (space, tag) in [
        (MeshCoordinateSpace::SiteLocal, "\"site_local\""),
        (MeshCoordinateSpace::ModelRtc, "\"model_rtc\""),
        (MeshCoordinateSpace::RawIfc, "\"raw_ifc\""),
    ] {
        assert_eq!(serde_json::to_string(&space).unwrap(), tag);
        assert_eq!(
            serde_json::from_str::<MeshCoordinateSpace>(tag).unwrap(),
            space
        );
    }
    assert!(serde_json::from_str::<MeshCoordinateSpace>("\"SiteLocal\"").is_err());
}

/// #7684: `to_world` is the inverse of the bake, `world_matrix` is the same map
/// as a matrix, and the hoisted mappers agree with both bit for bit.
#[test]
fn to_world_inverts_the_bake_and_agrees_with_world_matrix_and_mappers() {
    let frames = [
        MeshFrame::select(Some(&site_at_yawed((2_600_000.0, 1_200_000.0, 500.0), 33.0)), None),
        MeshFrame::select(Some(&site_at((2_600_000.0, 1_200_000.0, 500.0))), None),
        MeshFrame::select(None, Some(LARGE_FAR)),
        MeshFrame::RawIfc,
    ];
    let world = [2_600_003.5, 1_200_004.25, 507.125];
    for frame in frames {
        let (x, y, z) = frame.rtc_offset();
        let baked = frame.rotate_into_frame([world[0] - x, world[1] - y, world[2] - z]);
        let back = frame.to_world(baked);
        for i in 0..3 {
            assert!((back[i] - world[i]).abs() < 1e-6, "{frame:?} axis {i}: {back:?}");
        }
        let m = frame.world_matrix();
        let by_matrix = [0, 1, 2].map(|r| m[r] * baked[0] + m[4 + r] * baked[1] + m[8 + r] * baked[2] + m[12 + r]);
        for i in 0..3 {
            assert!((by_matrix[i] - back[i]).abs() < 1e-6, "{frame:?} matrix axis {i}");
        }
        assert_eq!(frame.world_mapper()(baked).map(f64::to_bits), back.map(f64::to_bits));
        let n = [0.0, -0.0, 1.0];
        assert_eq!(
            frame.direction_mapper()(n).map(f64::to_bits),
            frame.rotate_out_of_frame(n).map(f64::to_bits)
        );
    }
}

/// Raw IFC is returned untouched, to the sign bit (a `-0.0` must not become
/// `0.0` by an added zero translation).
#[test]
fn raw_ifc_to_world_preserves_negative_zero() {
    let p = [-0.0, 1.5, -0.0];
    for got in [MeshFrame::RawIfc.to_world(p), MeshFrame::RawIfc.world_mapper()(p)] {
        assert_eq!(got.map(f64::to_bits), p.map(f64::to_bits));
    }
}
