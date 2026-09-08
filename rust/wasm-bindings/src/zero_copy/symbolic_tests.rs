/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Tests for the `SymbolicData` → `SymbolicRepresentationCollection` boundary.
//!
//! `from_data` is a 40-odd-field hand-written transcription between two
//! structs that are field-for-field parallel but share no type, so nothing
//! but a test can notice a pair swapped (`x`/`y`, `center_x`/`center_y`,
//! `start_angle`/`end_angle`, an rgba lane) or a field silently dropped.
//! Every fixture below therefore gives each field a value distinct from
//! every other field of the same type: an `x` that equals its `y`, or a
//! colour whose channels agree, cannot observe a swap.
//!
//! Lives in a sibling file rather than inline so a 750-line wrapper module
//! does not carry its own test weight against the size ratchet.

use super::symbolic::SymbolicRepresentationCollection;
use ifc_lite_processing as proc_types;

/// A polyline whose points are NOT palindromic and whose id/elevation are
/// distinct from every other fixture's, so ordering and per-item identity
/// are both observable.
fn polyline(express_id: u32, world_y: f32) -> proc_types::SymbolicPolyline {
    proc_types::SymbolicPolyline {
        express_id,
        ifc_type: format!("IfcWall{express_id}"),
        // Deliberately asymmetric: reversing or transposing this ring changes it.
        points: vec![1.0, 2.0, 4.0, 8.0, 16.0, 32.0],
        closed: true,
        world_y,
        representation: "Plan".to_string(),
    }
}

fn circle(express_id: u32) -> proc_types::SymbolicCircle {
    proc_types::SymbolicCircle {
        express_id,
        ifc_type: "IfcColumn".to_string(),
        // center_x != center_y and radius differs from both: a swap moves it.
        center_x: 3.0,
        center_y: -7.0,
        radius: 0.25,
        world_y: 11.5,
        // A genuine arc, not a full circle: start != 0 and end != TAU, so
        // neither angle can be confused with the other or with a default.
        start_angle: 0.5,
        end_angle: 2.5,
        representation: "Annotation".to_string(),
    }
}

fn text(express_id: u32) -> proc_types::SymbolicText {
    proc_types::SymbolicText {
        express_id,
        ifc_type: "IfcAnnotation".to_string(),
        x: 12.0,
        y: -3.5,
        // NOT the (1, 0) default: an identity default would hide a dropped
        // direction, and dir_x != dir_y so the pair cannot be swapped unseen.
        dir_x: 0.6,
        dir_y: -0.8,
        height: 0.35,
        content: "A-101".to_string(),
        alignment: "top-right".to_string(),
        world_y: 4.25,
        // Four distinct channels: an rgba lane swap is invisible on grey.
        color: [0.1, 0.2, 0.3, 0.4],
        // Non-zero, so "0 = renderer default" cannot stand in for a drop.
        target_px: 30.0,
        representation: "Axis".to_string(),
    }
}

/// A hatched fill with every hatch field distinct and a real secondary
/// angle (not the NaN "absent" sentinel), so a dropped field is visible.
fn hatched_fill(express_id: u32) -> proc_types::SymbolicFillArea {
    proc_types::SymbolicFillArea {
        express_id,
        ifc_type: "IfcAnnotationFillArea".to_string(),
        // Outer ring of 4 vertices then one hole of 3 — deliberately NOT the
        // same size, so a count/offset mix-up cannot coincide.
        points: vec![
            0.0, 0.0, 10.0, 0.0, 10.0, 5.0, 0.0, 5.0, // outer (4 vertices)
            1.0, 1.0, 2.0, 1.0, 2.0, 2.0, // hole (3 vertices)
        ],
        holes_offsets: vec![4],
        fill_color: [0.9, 0.6, 0.3, 0.5],
        has_hatching: true,
        hatch_spacing: 0.1,
        hatch_angle: 0.7853981,
        hatch_angle_secondary: 2.3561944,
        hatch_line_width: 0.002,
        world_y: 2.75,
        representation: "FootPrint".to_string(),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// from_data: field-for-field transcription
// ───────────────────────────────────────────────────────────────────────────

#[test]
fn from_data_carries_every_polyline_field() {
    let data = proc_types::SymbolicData {
        polylines: vec![polyline(101, 3.5)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    assert_eq!(collection.polyline_count(), 1);
    let p = collection.get_polyline(0).expect("polyline 0");
    assert_eq!(p.express_id(), 101);
    assert_eq!(p.ifc_type(), "IfcWall101");
    assert_eq!(p.point_count(), 3, "6 floats are 3 points, not 6");
    assert!(p.is_closed());
    assert_eq!(p.world_y(), 3.5);
    assert_eq!(p.rep_identifier(), "Plan");
}

#[test]
fn from_data_carries_every_circle_field() {
    let data = proc_types::SymbolicData {
        circles: vec![circle(202)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    let c = collection.get_circle(0).expect("circle 0");
    assert_eq!(c.express_id(), 202);
    assert_eq!(c.ifc_type(), "IfcColumn");
    assert_eq!(c.center_x(), 3.0, "center_x must not come from center_y");
    assert_eq!(c.center_y(), -7.0, "center_y must not come from center_x");
    assert_eq!(c.radius(), 0.25);
    assert_eq!(c.world_y(), 11.5, "world_y must not come from an angle slot");
    assert_eq!(c.start_angle(), 0.5, "start must not come from end");
    assert_eq!(c.end_angle(), 2.5, "end must not come from start");
    assert_eq!(c.rep_identifier(), "Annotation");
    assert!(!c.is_full_circle(), "a 2 rad sweep is not a full circle");
}

#[test]
fn from_data_carries_every_text_field() {
    let data = proc_types::SymbolicData {
        texts: vec![text(303)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    let t = collection.get_text(0).expect("text 0");
    assert_eq!(t.express_id(), 303);
    assert_eq!(t.ifc_type(), "IfcAnnotation");
    assert_eq!(t.x(), 12.0, "x must not come from y");
    assert_eq!(t.y(), -3.5, "y must not come from x");
    assert_eq!(t.dir_x(), 0.6, "dir_x must not come from dir_y");
    assert_eq!(t.dir_y(), -0.8, "dir_y must not come from dir_x");
    assert_eq!(t.height(), 0.35);
    assert_eq!(t.content(), "A-101");
    assert_eq!(t.alignment(), "top-right");
    assert_eq!(t.world_y(), 4.25);
    // Each channel pinned separately: asserting only "some colour arrived"
    // would pass with the lanes rotated.
    assert_eq!(t.color_r(), 0.1);
    assert_eq!(t.color_g(), 0.2);
    assert_eq!(t.color_b(), 0.3);
    assert_eq!(t.color_a(), 0.4);
    assert_eq!(t.target_px(), 30.0);
    assert_eq!(t.rep_identifier(), "Axis");
}

/// `SymbolicText::new` is the un-styled constructor: it must supply the
/// documented defaults rather than leaving the fields at zero, or a caller
/// that does not resolve an `IfcTextStyle` emits invisible transparent text.
#[test]
fn the_unstyled_text_constructor_defaults_to_opaque_dark_grey() {
    let t = super::symbolic::SymbolicText::new(
        1,
        "IfcAnnotation".to_string(),
        0.0,
        0.0,
        1.0,
        0.0,
        1.0,
        "x".to_string(),
        String::new(),
        0.0,
        "Plan".to_string(),
    );
    assert_eq!(t.color_a(), 1.0, "default text must be opaque, not alpha 0");
    assert!(t.color_r() < 0.5 && t.color_g() < 0.5 && t.color_b() < 0.5);
    assert_eq!(t.target_px(), 0.0, "0 means 'renderer global default'");
}

#[test]
fn from_data_carries_every_fill_field() {
    let data = proc_types::SymbolicData {
        fills: vec![hatched_fill(404)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    let f = collection.get_fill(0).expect("fill 0");
    assert_eq!(f.express_id(), 404);
    assert_eq!(f.ifc_type(), "IfcAnnotationFillArea");
    assert_eq!(f.point_count(), 7, "14 floats are 7 vertices");
    assert_eq!(f.hole_count(), 1);
    assert_eq!(f.fill_r(), 0.9);
    assert_eq!(f.fill_g(), 0.6);
    assert_eq!(f.fill_b(), 0.3);
    assert_eq!(f.fill_a(), 0.5);
    assert_eq!(f.world_y(), 2.75);
    assert_eq!(f.rep_identifier(), "FootPrint");
}

/// The viewer reads `hasHatching` / `hatchSpacing` / `hatchAngle` /
/// `hatchAngleSecondary` / `hatchLineWidth` straight off this object
/// (`apps/viewer/src/lib/overlay-parse/symbolic-flat.ts`), and the JSON
/// path round-trips them. If the wasm converter drops them, a hatched
/// region renders as a flat solid in the browser while the server's JSON
/// for the same file carries the style — the exact split `from_data`'s
/// doc comment promises cannot happen.
#[test]
fn from_data_carries_the_hatching_style() {
    let data = proc_types::SymbolicData {
        fills: vec![hatched_fill(404)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);
    let f = collection.get_fill(0).expect("fill 0");

    assert!(
        f.has_hatching(),
        "a hatched fill must arrive hatched, or the browser draws it solid"
    );
    assert_eq!(f.hatch_spacing(), 0.1);
    assert_eq!(f.hatch_angle(), 0.7853981, "primary angle");
    assert_eq!(
        f.hatch_angle_secondary(),
        2.3561944,
        "the cross-hatch angle is a distinct value, not a copy of the primary"
    );
    assert_eq!(f.hatch_line_width(), 0.002);
}

/// Single-direction hatching — the common case — has NO secondary angle, and
/// the absent marker for it is NaN, which the viewer turns into `null`. The
/// hatched fixture above carries a real secondary angle, so on its own it
/// never drives the absent branch: a converter that replaced the sentinel
/// with `0.0` would go unseen and every plain hatch would render crossed.
#[test]
fn a_hatched_fill_with_no_secondary_angle_keeps_the_nan_sentinel() {
    let mut fill = hatched_fill(406);
    fill.hatch_angle_secondary = f32::NAN;
    let data = proc_types::SymbolicData {
        fills: vec![fill],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);
    let f = collection.get_fill(0).expect("fill 0");

    assert!(f.has_hatching(), "still hatched, just single-direction");
    assert_eq!(f.hatch_spacing(), 0.1, "the rest of the style still arrives");
    assert!(
        f.hatch_angle_secondary().is_nan(),
        "absent must stay NaN; 0.0 is a real angle and would cross-hatch"
    );
}

/// The other direction, so "always hatched" is not a passing fix: an
/// unhatched fill must keep NaN as the secondary-angle absent sentinel —
/// the viewer turns exactly NaN into `null`, and `0.0` is a real angle.
#[test]
fn an_unhatched_fill_keeps_the_nan_absent_sentinel() {
    let mut fill = hatched_fill(405);
    fill.has_hatching = false;
    fill.hatch_spacing = 0.0;
    fill.hatch_angle = 0.0;
    fill.hatch_angle_secondary = f32::NAN;
    fill.hatch_line_width = 0.0;
    let data = proc_types::SymbolicData {
        fills: vec![fill],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);
    let f = collection.get_fill(0).expect("fill 0");

    assert!(!f.has_hatching());
    assert!(
        f.hatch_angle_secondary().is_nan(),
        "absent must stay NaN; 0.0 would render as a real cross-hatch"
    );
}

// ───────────────────────────────────────────────────────────────────────────
// Indexing and counting
// ───────────────────────────────────────────────────────────────────────────

/// Every accessor must read the index it was handed. A single-item
/// collection cannot observe an accessor that always returns item 0.
#[test]
fn accessors_read_the_index_they_were_given() {
    let data = proc_types::SymbolicData {
        polylines: vec![polyline(11, 1.0), polyline(22, 2.0), polyline(33, 3.0)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    assert_eq!(collection.get_polyline(0).unwrap().express_id(), 11);
    assert_eq!(collection.get_polyline(1).unwrap().express_id(), 22);
    assert_eq!(collection.get_polyline(2).unwrap().express_id(), 33);
    assert!(
        collection.get_polyline(3).is_none(),
        "one past the end must be None, not a wrapped or clamped item"
    );
}

/// Counts must come from their own vector. Four DIFFERENT lengths, because
/// four equal ones cannot observe `text_count` reading `self.fills`.
#[test]
fn each_count_reads_its_own_collection() {
    let data = proc_types::SymbolicData {
        polylines: vec![polyline(1, 0.0)],
        circles: vec![circle(2), circle(3)],
        texts: vec![text(4), text(5), text(6)],
        fills: vec![
            hatched_fill(7),
            hatched_fill(8),
            hatched_fill(9),
            hatched_fill(10),
        ],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    assert_eq!(collection.polyline_count(), 1);
    assert_eq!(collection.circle_count(), 2);
    assert_eq!(collection.text_count(), 3);
    assert_eq!(collection.fill_count(), 4);
    assert_eq!(
        collection.total_count(),
        10,
        "total must sum all four kinds, not double one of them"
    );
    assert!(!collection.is_empty());
}

/// `get_express_ids` sorts and dedups across all four kinds. The fixture
/// feeds ids out of order and repeated ACROSS kinds — a per-kind dedup or a
/// missing chain link would still pass on sorted, kind-unique input.
#[test]
fn express_ids_are_sorted_deduped_and_drawn_from_all_four_kinds() {
    let data = proc_types::SymbolicData {
        polylines: vec![polyline(50, 0.0), polyline(10, 0.0)],
        circles: vec![circle(30)],
        // 10 repeats the polyline's id; 40 is unique to texts.
        texts: vec![text(10), text(40)],
        fills: vec![hatched_fill(20)],
        ..proc_types::SymbolicData::default()
    };
    let collection = SymbolicRepresentationCollection::from_data(data);

    assert_eq!(
        collection.get_express_ids(),
        vec![10, 20, 30, 40, 50],
        "ascending, deduped, and covering polylines/circles/texts/fills"
    );
}

// ───────────────────────────────────────────────────────────────────────────
// Constructors and derived predicates
// ───────────────────────────────────────────────────────────────────────────

/// `with_capacity` reserves; it must not fabricate items. An empty
/// collection built with a non-zero capacity is the case that separates
/// `Vec::with_capacity` from `vec![_; n]`.
#[test]
fn with_capacity_reserves_without_populating() {
    let collection = SymbolicRepresentationCollection::with_capacity(8, 4);
    assert_eq!(collection.total_count(), 0);
    assert!(collection.is_empty());
    assert!(collection.get_polyline(0).is_none());
}

/// `is_full_circle` is a sweep test, not an endpoint test. The half circle
/// and the reversed sweep both share an endpoint with the full circle, so
/// they are what a naive `end_angle == TAU` check would get wrong.
#[test]
fn is_full_circle_tests_the_sweep_not_an_endpoint() {
    let full = super::symbolic::SymbolicCircle::full_circle(
        1,
        "IfcCircle".to_string(),
        0.0,
        0.0,
        1.0,
        0.0,
        "Plan".to_string(),
    );
    assert!(full.is_full_circle());

    let mk = |start: f32, end: f32| {
        super::symbolic::SymbolicCircle::new(
            1,
            "IfcCircle".to_string(),
            0.0,
            0.0,
            1.0,
            0.0,
            start,
            end,
            "Plan".to_string(),
        )
    };
    // Ends at TAU but only sweeps half of it.
    assert!(!mk(std::f32::consts::PI, std::f32::consts::TAU).is_full_circle());
    // A full sweep that does NOT start at 0 is still a full circle.
    assert!(mk(1.0, 1.0 + std::f32::consts::TAU).is_full_circle());
    // The reversed sweep is not: dropping the sign makes this pass.
    assert!(!mk(std::f32::consts::TAU, 0.0).is_full_circle());
}
