// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// Mutually distinct components, none of them a plausible stand-in for
/// another: a wrong pick shows up as a kilometre-scale error, and the signs
/// differ so a sign slip cannot cancel.
const OFFSET: (f64, f64, f64) = (12_050.0, -14_530.0, 407.0);

#[test]
fn each_axis_is_rebased_by_its_own_component() {
    let rebase = RenderFrameRebase::from_rtc_offset(OFFSET);
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
    let rebase = RenderFrameRebase::from_rtc_offset(OFFSET);
    let south = rebase.plan(12_000.0, -14_600.0).1;
    let north = rebase.plan(12_000.0, -14_400.0).1;
    assert!(
        south > north,
        "expected the flip to reverse northing, got south={south} north={north}"
    );
}

/// Counter-case: a local-coordinate model must not be re-based at all, or a
/// small building lands off-screen. A "subtract the centroid unconditionally"
/// fix fails here.
#[test]
fn a_local_coordinate_model_is_not_rebased() {
    let rebase = RenderFrameRebase::from_rtc_offset((3.5, -7.25, 2.75));
    assert_eq!(rebase, RenderFrameRebase::default());
    let (x, y) = rebase.plan(3.5, -7.25);
    assert!((x - 3.5).abs() < 1e-6, "x: {x}");
    assert!((y - 7.25).abs() < 1e-6, "y2d: {y}");
    assert!((rebase.elevation(2.75) - 2.75).abs() < 1e-6);
}

/// The threshold looks at every axis, and an offset that is large on ONE axis
/// re-bases all three. A model 12 km east but at ground level must still have
/// its northing and elevation re-based by the detected offset.
#[test]
fn a_single_large_axis_arms_the_whole_rebase() {
    let rebase = RenderFrameRebase::from_rtc_offset((12_050.0, 30.0, 7.0));
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
    let identity = RenderFrameRebase::from_rtc_offset((0.0, 0.0, 0.0));
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
