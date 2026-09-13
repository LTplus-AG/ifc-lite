// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn model_rtc(anchor: (f64, f64, f64)) -> RenderFrameRebase {
    RenderFrameRebase::from_frame(MeshFrame::ModelRtc { anchor })
}

/// Mutually distinct components, none of them a plausible stand-in for
/// another: a wrong pick shows up as a kilometre-scale error, and the signs
/// differ so a sign slip cannot cancel.
const OFFSET: (f64, f64, f64) = (12_050.0, -14_530.0, 407.0);

#[test]
fn each_axis_is_rebased_by_its_own_component() {
    let rebase = model_rtc(OFFSET);
    // IFC (12_000, -14_500, 400) → render (-50, -30 after the flip, -7).
    let (x, y) = rebase.plan(12_000.0, -14_500.0);
    assert!((x - -50.0).abs() < 1e-3, "x: {x}");
    assert!((y - -30.0).abs() < 1e-3, "y2d: {y}");
    assert!(
        (rebase.elevation(400.0) - -7.0).abs() < 1e-3,
        "elevation: {}",
        rebase.elevation(400.0)
    );
}

/// The plan pair flips handedness on the northing axis: two points differing
/// only in IFC Y come back ordered the other way. Pins the sign of the flip
/// independently of the offset, so an "improvement" that drops the negation
/// cannot hide behind a symmetric offset.
#[test]
fn the_plan_flip_reverses_the_northing_axis() {
    let rebase = model_rtc(OFFSET);
    let south = rebase.plan(12_000.0, -14_600.0).1;
    let north = rebase.plan(12_000.0, -14_400.0).1;
    assert!(
        south > north,
        "expected the flip to reverse northing, got south={south} north={north}"
    );
}

/// Counter-case: a frame that subtracts nothing leaves the overlay where it
/// is, or a small building lands off-screen.
#[test]
fn a_raw_ifc_frame_is_not_rebased() {
    let rebase = RenderFrameRebase::from_frame(MeshFrame::RawIfc);
    assert_eq!(rebase, RenderFrameRebase::default());
    let (x, y) = rebase.plan(3.5, -7.25);
    assert!((x - 3.5).abs() < 1e-6, "x: {x}");
    assert!((y - 7.25).abs() < 1e-6, "y2d: {y}");
    assert!((rebase.elevation(2.75) - 2.75).abs() < 1e-6);
}

/// #4665: the placement-bounds fallback anchors on the bbox centre, which can
/// be inside 10 km while a corner is past it. The meshes subtract that anchor,
/// so the overlay must too; a second threshold test on the anchor here left
/// the overlay 8.5 km away from the meshes.
#[test]
fn a_sub_threshold_anchor_is_subtracted() {
    let rebase = model_rtc((8_500.0, 0.0, 0.0));
    let (x, _) = rebase.plan(2_000.0, 0.0);
    assert!((x - -6_500.0).abs() < 1e-3, "x: {x}");
}

/// An anchor that is large on ONE axis re-bases all three. A model 12 km east
/// but at ground level must still have its northing and elevation re-based by
/// the anchor's other components.
#[test]
fn every_anchor_component_is_subtracted() {
    let rebase = model_rtc((12_050.0, 30.0, 7.0));
    let (_, y) = rebase.plan(0.0, 0.0);
    assert!((y - 30.0).abs() < 1e-3, "y2d: {y}");
    assert!((rebase.elevation(0.0) - -7.0).abs() < 1e-3);
}

/// A zero northing must come out as +0.0, not the -0.0 that writing the flip
/// as a negation produces. Nothing renders differently, but the overlay's
/// golden digests record sign of zero deliberately, so leaking -0.0 there
/// spends a real signal on an artifact of the arithmetic.
#[test]
fn plan_does_not_emit_negative_zero_for_a_zero_northing() {
    let identity = RenderFrameRebase::from_frame(MeshFrame::RawIfc);
    let (_, y) = identity.plan(3.5, 0.0);
    assert_eq!(y, 0.0);
    assert!(
        !y.is_sign_negative(),
        "a zero northing produced -0.0; the pinned symbolic goldens distinguish it",
    );

    // The normalisation must not disturb a genuine negative, which is the
    // failure mode of "fixing" this by taking an absolute value.
    let (_, flipped) = identity.plan(0.0, 4.0);
    assert_eq!(flipped, -4.0);
}
