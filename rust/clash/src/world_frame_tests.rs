// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Session-level origin-shift invariance for [`ClashSession::run_rule`]
//! (#5406, prerequisite named on #5405/#5406).
//!
//! A rigid translation of every input changes nothing geometric, so it must
//! not change what `run_rule` reports: the same pairs, the same status, the
//! same distance provenance, and a distance that agrees to within the f32
//! quantisation the translation itself introduces. Nothing asserted that
//! before: #5355 swept `detect_obb` and the OBB depth at fixture level, but a
//! session could still move a flush pair between `Touch` and `Hard` because
//! the tri-tri predicate upstream of both decided "touching" on a floating-
//! point tie (#5406), and nothing observed the verdict end to end.
//!
//! Every scene is AUTHORED in f64 near the origin, translated in f64, and
//! only then baked through f32 — exactly what ingestion does to a model
//! placed far from its origin, and why a translation is not a no-op on the
//! stored coordinates. The translations are the shared corpus placements
//! (`world_frame_corpus`: the origin and 10 km out along X only) plus
//! arbitrary, non-power-of-two ones on every axis, including the few-metre
//! shift of the #5355 report. Rotations are generic (no face aligned with a
//! coordinate axis) so that flush faces are NOT bit-identical after
//! rounding — the case a tie-deciding predicate gets wrong — alongside an
//! axis-aligned counter-case where they are.
//!
//! What is deliberately NOT compared: the contact `point` and `bounds` of a
//! `Touch`. For two faces in contact every point of the shared face is an
//! equally valid closest point, so which one the distance routine returns is
//! not a function of the geometry and translating the pair may legitimately
//! pick another.

use crate::narrow::{ClashStatus, DistanceKind};
use crate::session::ClashSession;
use crate::world_frame_corpus::{ulp32, WORLD_FRAME_CASES};

const HARD: u8 = 0;
const CLEARANCE: u8 = 1;
/// The product default tolerance (`DEFAULT_CLASH_SETTINGS.tolerance`).
const TOLERANCE: f64 = 0.002;

/// Every translation a scene is run under. The corpus cases come first;
/// the rest are arbitrary, so none of them lands on a power of two that
/// would make f32 rounding coincidentally exact.
fn translations() -> Vec<[f64; 3]> {
    let mut t: Vec<[f64; 3]> = WORLD_FRAME_CASES.iter().map(|c| c.offset()).collect();
    t.extend_from_slice(&[
        [7.4, 0.0, 0.0],
        [3.7, -12.9, 2.35],
        [123.456, -45.678, 9.1],
        [1000.0, 0.0, 0.0],
        [0.0, 1000.0, 0.0],
        [0.0, 0.0, 1000.0],
        [0.0, 10_000.0, 0.0],
    ]);
    t
}

/// Rotation `Rz(rz) * Ry(ry) * Rx(rx)`.
fn rotation(r: [f64; 3]) -> [[f64; 3]; 3] {
    let (cz, sz) = (r[0].cos(), r[0].sin());
    let (cy, sy) = (r[1].cos(), r[1].sin());
    let (cx, sx) = (r[2].cos(), r[2].sin());
    [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]
}

fn apply(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// One authored box: centre and half-extents in the scene's rotated frame.
#[derive(Clone, Copy)]
struct BoxSpec {
    centre: [f64; 3],
    half: [f64; 3],
}

/// A scene: boxes sharing one rotation, authored near the origin.
struct Scene {
    name: &'static str,
    rotation: [f64; 3],
    boxes: Vec<BoxSpec>,
}

impl Scene {
    /// The scene's local x axis in world coordinates: every scene below
    /// puts its contact (or gap, or overlap) along it.
    fn normal(&self) -> [f64; 3] {
        apply(&rotation(self.rotation), [1.0, 0.0, 0.0])
    }

    /// Ingest the scene translated by `t`: rotate and translate in f64, THEN
    /// bake through f32, and take each AABB from the baked vertices.
    fn session(&self, t: [f64; 3]) -> ClashSession {
        let m = rotation(self.rotation);
        let mut positions: Vec<f32> = Vec::new();
        let mut pos_ranges: Vec<u32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut idx_ranges: Vec<u32> = Vec::new();
        let mut aabbs: Vec<f32> = Vec::new();
        for b in &self.boxes {
            let c = apply(&m, b.centre);
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            pos_ranges.push(positions.len() as u32);
            for s in [
                [-1.0, -1.0, -1.0],
                [1.0, -1.0, -1.0],
                [1.0, 1.0, -1.0],
                [-1.0, 1.0, -1.0],
                [-1.0, -1.0, 1.0],
                [1.0, -1.0, 1.0],
                [1.0, 1.0, 1.0],
                [-1.0, 1.0, 1.0],
            ] {
                let local = [s[0] * b.half[0], s[1] * b.half[1], s[2] * b.half[2]];
                let w = apply(&m, local);
                for k in 0..3 {
                    let v = (w[k] + c[k] + t[k]) as f32;
                    positions.push(v);
                    min[k] = min[k].min(v);
                    max[k] = max[k].max(v);
                }
            }
            pos_ranges.push(24);
            idx_ranges.push(indices.len() as u32);
            indices.extend_from_slice(&[
                0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3,
                7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
            ]);
            idx_ranges.push(36);
            aabbs.extend_from_slice(&[min[0], min[1], min[2], max[0], max[1], max[2]]);
        }
        let mut session = ClashSession::new();
        session.ingest(&positions, &pos_ranges, &indices, &idx_ranges, &aabbs);
        session
    }
}

/// Axis-aligned: flush faces are bit-identical after rounding (the
/// counter-case), contact normal world X — the corpus's far offset axis.
const AXIS_ALIGNED: [f64; 3] = [0.0, 0.0, 0.0];
/// Contact normal world Z, so the corpus's X offset is ORTHOGONAL to the
/// axis under test (the corpus's own design rule).
const NORMAL_Z: [f64; 3] = [0.0, -std::f64::consts::FRAC_PI_2, 0.0];
/// A yaw about Z: flush faces vertical but not axis-aligned.
const YAW: [f64; 3] = [0.3, 0.0, 0.0];
/// A genuine three-axis rotation: no face shares an axis with the world.
const THREE_AXIS: [f64; 3] = [1.1, 0.37, -0.61];

/// A 50 mm curtain-wall panel and a 200 mm mullion placed along the panel's
/// local x at centre distance `0.025 + 0.1 - overlap`: flush at
/// `overlap = 0`, interpenetrating for `overlap > 0`, a gap for `< 0`. The
/// shape of the #5355 report.
fn panel_and_mullion(name: &'static str, rotation: [f64; 3], overlap: f64) -> Scene {
    Scene {
        name,
        rotation,
        boxes: vec![
            BoxSpec { centre: [1.0, 2.0, 1.5], half: [0.025, 0.75, 1.5] },
            BoxSpec { centre: [1.0 + 0.125 - overlap, 2.0, 1.5], half: [0.1, 0.1, 1.5] },
        ],
    }
}

/// One record reduced to what a translation must preserve.
#[derive(Debug, PartialEq)]
struct Verdict {
    a: u32,
    b: u32,
    status: ClashStatus,
    kind: DistanceKind,
}

fn run(session: &ClashSession, mode: u8, clearance: f64, report_touch: bool) -> Vec<(Verdict, f64)> {
    let mut out: Vec<(Verdict, f64)> = session
        .run_rule(&[0], Some(&[1]), mode, TOLERANCE, clearance, report_touch)
        .records
        .into_iter()
        .map(|r| {
            (
                Verdict { a: r.a, b: r.b, status: r.status, kind: r.distance_kind },
                r.distance,
            )
        })
        .collect();
    out.sort_by_key(|(v, _)| (v.a, v.b));
    out
}

/// How far a reported distance may legitimately move under translation `t`:
/// the f32 re-quantisation of the translated coordinates, projected onto the
/// contact normal (`sum_k |n_k| * ulp32(extent_k)`, the corpus's own bound),
/// for each of the two surfaces the distance is measured between, with 4x
/// headroom for the rotation that bakes each vertex from three coordinates.
/// Derived from the translation, never from the answer.
fn distance_slack(scene: &Scene, t: [f64; 3]) -> f64 {
    let n = scene.normal();
    // Scene extent is a few metres around the origin; the translation
    // dominates every axis it touches.
    let bound: f64 = (0..3).map(|k| n[k].abs() * ulp32(t[k].abs() + 4.0)).sum();
    8.0 * bound
}

/// Assert the scene reports the same verdicts, and distances within the
/// translation's own f32 slack, under every translation — and return the
/// origin run so the caller can pin what that shared answer IS (an
/// invariant that is wrong everywhere is still invariant).
fn assert_translation_invariant(
    scene: &Scene,
    mode: u8,
    clearance: f64,
    report_touch: bool,
) -> Vec<(Verdict, f64)> {
    let reference = run(&scene.session([0.0; 3]), mode, clearance, report_touch);
    for t in translations() {
        let got = run(&scene.session(t), mode, clearance, report_touch);
        let verdicts = |r: &[(Verdict, f64)]| r.iter().map(|(v, _)| format!("{v:?}")).collect::<Vec<_>>();
        assert_eq!(
            verdicts(&got),
            verdicts(&reference),
            "{} (rotation {:?}): translating by {t:?} changed the verdicts; distances origin {:?} vs translated {:?}",
            scene.name,
            scene.rotation,
            reference.iter().map(|(_, d)| *d).collect::<Vec<_>>(),
            got.iter().map(|(_, d)| *d).collect::<Vec<_>>(),
        );
        let slack = distance_slack(scene, t);
        for ((_, d_ref), (v, d)) in reference.iter().zip(got.iter()) {
            assert!(
                (d - d_ref).abs() <= slack,
                "{} (rotation {:?}): translating by {t:?} moved {v:?}'s distance {d_ref} -> {d} (slack {slack})",
                scene.name,
                scene.rotation,
            );
        }
    }
    reference
}

#[test]
fn a_flush_panel_and_mullion_is_a_touch_under_every_translation_5406() {
    // Before #5406 the three-axis rotation reported this flush pair as Hard,
    // -1.38 m (the AABB estimate) at the origin and at six of the nine
    // translations: faces coplanar to within one f32 ULP "crossed". The yaw
    // additionally exercises #5473: the mullion's AABB lies inside the yawed
    // panel's, so with no crossing the pair reaches the enclosed-solid test,
    // whose old probe (the mullion's vertex 0) sat ON the panel's face and
    // flipped to Hard at 3.7 m and at 1 km.
    for r in [AXIS_ALIGNED, NORMAL_Z, YAW, THREE_AXIS] {
        assert_flush_is_touch(r);
    }
}

fn assert_flush_is_touch(r: [f64; 3]) {
    let scene = panel_and_mullion("flush panel/mullion", r, 0.0);
    let with_touch = assert_translation_invariant(&scene, HARD, 0.0, true);
    assert_eq!(with_touch.len(), 1, "{r:?}: the contact itself is real and must report");
    assert_eq!(with_touch[0].0.status, ClashStatus::Touch, "{r:?}");
    assert!(
        with_touch[0].1.abs() <= distance_slack(&scene, [0.0; 3]),
        "{r:?}: a flush touch measured {}",
        with_touch[0].1
    );

    let hard_only = assert_translation_invariant(&scene, HARD, 0.0, false);
    assert!(hard_only.is_empty(), "{r:?}: a flush contact is not a hard clash: {hard_only:?}");
}

/// 20 mm: far above the f32 noise of the farthest placement projected onto
/// the contact normal (~2.4 mm at 10 km), so a translation that swallowed it
/// would be a defect, not a resolution limit. Companion to the flush tests:
/// without it, reporting nothing everywhere would pass as "invariant".
const OVERLAP: f64 = 0.02;

fn assert_overlap_is_hard_at_its_depth(r: [f64; 3]) {
    let scene = panel_and_mullion("20 mm overlap", r, OVERLAP);
    let got = assert_translation_invariant(&scene, HARD, 0.0, false);
    assert_eq!(got.len(), 1, "{r:?}: {got:?}");
    assert_eq!(got[0].0.status, ClashStatus::Hard, "{r:?}");
    assert_eq!(got[0].0.kind, DistanceKind::Mesh, "{r:?}: two boxes have a certified depth");
    assert!((got[0].1 + OVERLAP).abs() <= 1e-6, "{r:?}: depth {} != -{OVERLAP}", got[0].1);
}

#[test]
fn a_genuine_overlap_is_hard_at_its_own_depth_under_every_translation_5406() {
    for r in [AXIS_ALIGNED, NORMAL_Z] {
        assert_overlap_is_hard_at_its_depth(r);
    }
}

/// A thin ROTATED box pair: the OBB frame and centre were computed from
/// absolute world coordinates, so the error of a single triangle's normal was
/// multiplied by the element's distance from the origin — the 20 mm overlap
/// read 23 mm (yaw) / 30 mm (three-axis) at 123 m and fell back to the AABB
/// `Estimate` (-0.25 m / -1.38 m) from 1 km out. Pinned as `should_panic`
/// until #5474 made box recognition origin-independent.
#[test]
fn a_rotated_overlap_keeps_its_certified_depth_under_every_translation_5474() {
    for r in [YAW, THREE_AXIS] {
        assert_overlap_is_hard_at_its_depth(r);
    }
}

#[test]
fn a_clearance_gap_is_measured_the_same_under_every_translation_5406() {
    // A 20 mm gap under a 50 mm clearance rule: a violation at its own gap.
    // Before #5406 the three-axis rotation reported this 20 mm GAP as Hard,
    // -1.38 m, at the origin: the two elements' end faces are coplanar and
    // 20 mm apart, and with no coplanar handling a non-bit-identical coplanar
    // pair had no separating axis left (every edge-edge axis of two coplanar
    // triangles is parallel to their shared normal).
    const GAP: f64 = 0.02;
    for r in [AXIS_ALIGNED, NORMAL_Z, YAW, THREE_AXIS] {
        let scene = panel_and_mullion("20 mm gap", r, -GAP);
        let got = assert_translation_invariant(&scene, CLEARANCE, 0.05, false);
        assert_eq!(got.len(), 1, "{r:?}: {got:?}");
        assert_eq!(got[0].0.status, ClashStatus::Clearance, "{r:?}");
        assert!((got[0].1 - GAP).abs() <= 1e-6, "{r:?}: gap {} != {GAP}", got[0].1);
    }
}

#[test]
fn a_gap_beyond_tolerance_reports_nothing_under_every_translation_5406() {
    for r in [AXIS_ALIGNED, NORMAL_Z, YAW, THREE_AXIS] {
        let scene = panel_and_mullion("20 mm gap, hard rule", r, -0.02);
        let got = assert_translation_invariant(&scene, HARD, 0.0, true);
        assert!(got.is_empty(), "{r:?}: {got:?}");
    }
}

#[test]
fn a_1mm_overlap_is_hard_at_its_own_depth_under_every_translation_5405() {
    // 1 mm along a Z contact normal: above the Z noise at every placement in
    // the corpus (Z translations reach 1 km, ~0.24 mm of noise there), but
    // BELOW the old max-over-all-axes floor once the pair is 10 km out along
    // X or Y (10,000 * 2^-22 ~ 2.4 mm), which reported it as a Touch there
    // and a Hard at the origin (#5405). The floor is now the pair's noise
    // projected onto the depth's own direction, so the X and Y offsets say
    // nothing about it.
    const OVERLAP_1MM: f64 = 0.001;
    let scene = panel_and_mullion("1 mm overlap, contact normal Z", NORMAL_Z, OVERLAP_1MM);
    let got = assert_translation_invariant(&scene, HARD, 0.0, false);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].0.status, ClashStatus::Hard);
    assert_eq!(got[0].0.kind, DistanceKind::Mesh);
    assert!((got[0].1 + OVERLAP_1MM).abs() <= 1e-6, "depth {}", got[0].1);
}

/// Every `Hard` record's reported depth floor (#5639), per translation.
fn hard_floors(scene: &Scene, t: [f64; 3], mode: u8) -> Vec<(f64, f64)> {
    let (result, floors) = scene
        .session(t)
        .run_rule_with_depth_floors(&[0], Some(&[1]), mode, TOLERANCE, 0.0, true);
    result
        .records
        .iter()
        .zip(floors)
        .filter(|(r, _)| r.status == ClashStatus::Hard)
        .map(|(r, f)| (-r.distance, f.expect("every Hard record carries its depth floor")))
        .collect()
}

#[test]
fn the_reported_depth_floor_stays_below_the_depth_and_ignores_orthogonal_offsets_5639() {
    // The reported touching band (`isTouching` in `@ifc-lite/clash`) is
    // `max(TOUCHING_EPSILON, depth_floor)`. It is decided by the same rule as
    // the verdict when the floor it reads is the classification floor of the
    // reported depth itself. Two invariants make it translation-proof:
    //
    // 1. A `Hard` record's depth always exceeds its own floor, at every
    //    placement — so the band collapses to the fixed TOUCHING_EPSILON and
    //    cannot flip a verdict the kernel did not flip.
    // 2. A translation ORTHOGONAL to the depth leaves the floor unchanged up
    //    to the rounding of the elements' own spans. The 1 mm scene's depth is
    //    along Z; the corpus's far offsets are along X and Y. The old band read
    //    the X coordinate instead: 10,000 * 2^-22 ~ 2.4 mm > 1 mm, so this very
    //    clash was reported as "touching" 10 km out in X and not at the
    //    origin.
    let scene = panel_and_mullion("1 mm overlap, contact normal Z", NORMAL_Z, 0.001);
    let origin = hard_floors(&scene, [0.0; 3], HARD);
    assert_eq!(origin.len(), 1);
    let origin_floor = origin[0].1;
    for t in translations() {
        let got = hard_floors(&scene, t, HARD);
        assert_eq!(got.len(), 1, "translated by {t:?}");
        let (depth, floor) = got[0];
        assert!(floor < depth, "translated by {t:?}: floor {floor} not below depth {depth}");
        if t[2] == 0.0 {
            assert!(
                (floor - origin_floor).abs() <= 1e-3 * origin_floor,
                "translated by {t:?} (orthogonal to the Z depth): floor {origin_floor} -> {floor}"
            );
        }
    }
    // The old band at the corpus's far placement, for contrast: it exceeds the
    // depth, which is what made the reported verdict origin-dependent.
    let far_band_old = crate::world_frame_corpus::WORLD_FRAME_OFFSET_M / 4_194_304.0;
    assert!(far_band_old > 0.001 && origin_floor < 1e-5, "{far_band_old} vs {origin_floor}");
}

#[test]
fn every_hard_record_in_the_corpus_carries_a_floor_below_its_depth_5639() {
    // Invariant 1 above, over every scene of this suite that produces a
    // `Hard` record, at every translation and rotation.
    for r in [AXIS_ALIGNED, NORMAL_Z, YAW, THREE_AXIS] {
        for overlap in [0.02, 0.001] {
            let scene = panel_and_mullion("overlap", r, overlap);
            for t in translations() {
                for (depth, floor) in hard_floors(&scene, t, HARD) {
                    assert!(floor > 0.0 && floor < depth, "{r:?} {overlap} {t:?}: floor {floor}, depth {depth}");
                }
            }
        }
    }
}

#[test]
fn a_through_penetration_tie_reports_the_same_depth_under_every_translation_5742() {
    // A 26 mm plate and a member overlapping it by 26 mm: the member pokes
    // out of the plate's far face by a few microns, so whether the pair is a
    // THROUGH-penetration is a genuine tie, and f32 noise decides it
    // differently per placement (it was `false` only at `[0, 1000, 0]`). No
    // tolerance on that comparison is translation-invariant (#5742), so what
    // must not move is the NUMBER. It did: `through` swapped the certified
    // 0.026 m MTD for the rotated boxes' AABB estimate, 0.786 m, a 30x
    // swing on a tie. A reported depth never exceeds the MTD, a translation
    // proven to separate the pair, so both sides of the tie now report it.
    let rot = [1.5800129994571253, 3.5225093160578957, 1.8017834383956415];
    let h0 = [0.013013728003234151, 0.9714054867418568, 1.3767230571852422];
    let h1 = [0.23902077510958353, 0.7165054118524359, 0.26588907459338434];
    let sep = -0.02604616601887833;
    let scene = Scene {
        name: "through-penetration tie (#5742)",
        rotation: rot,
        boxes: vec![
            BoxSpec { centre: [0.0, 0.0, 0.0], half: h0 },
            BoxSpec { centre: [h0[0] + h1[0] + sep, 0.0, 0.0], half: h1 },
        ],
    };
    let mut placements = vec![[1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0], [10_000.0, 0.0, 0.0]];
    placements.extend(translations());
    let origin = run(&scene.session([0.0; 3]), HARD, 0.0, false);
    assert_eq!(origin.len(), 1, "{origin:?}");
    assert!((origin[0].1 + sep.abs()).abs() <= 1e-4, "origin depth {} != the 26 mm overlap", origin[0].1);
    for t in placements {
        let got = run(&scene.session(t), HARD, 0.0, false);
        assert_eq!(got.len(), 1, "{t:?}: {got:?}");
        assert_eq!(got[0].0.status, ClashStatus::Hard, "{t:?}");
        let slack = distance_slack(&scene, t).max(1e-4);
        assert!(
            (got[0].1 - origin[0].1).abs() <= slack,
            "{t:?}: depth {} ({:?}) vs origin {} (slack {slack})",
            got[0].1,
            got[0].0.kind,
            origin[0].1,
        );
    }
}
