// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The symbolic primitives use `f32::NAN` as a SENTINEL meaning "this scalar
//! was never resolved" — `world_y` when the placement chain yields no
//! elevation, `hatch_angle_secondary` when a fill carries no cross-hatch.
//! The distinction that sentinel exists to preserve is "unresolved" vs. a
//! genuine `0.0`, which is a real elevation / a real angle.
//!
//! JSON has no NaN. `serde_json` writes `f32::NAN` as `null` and — before the
//! fix — the derived `Deserialize` could not read `null` back into an `f32`
//! (`invalid type: null, expected f32`). Every JSON hop therefore DESTROYED
//! the sentinel:
//!
//! - `apps/server/src/routes/parse/cache_keys.rs` serializes `SymbolicData`
//!   into the `{cache_key}-symbolic-v1` cache entry and reads it back with
//!   `serde_json::from_slice(..).unwrap_or_else(|_| SymbolicData::default())`
//!   — so ONE unresolved scalar anywhere in the model made the whole cached
//!   blob unreadable and every replayed request silently served NO symbolic
//!   data at all.
//! - `apps/server/src/types/response.rs` embeds `SymbolicData` in the
//!   `complete` stream event and in `POST /api/v1/parse`, so the same value
//!   reaches TypeScript clients.
//!
//! These tests drive the REAL serializer and the REAL deserializer — never a
//! hand-written JSON literal — so they pin the wire format rather than an
//! assumption about it.

use ifc_lite_processing::{SymbolicData, SymbolicFillArea, SymbolicGridAxis, SymbolicPolyline};

fn axis(world_y: f32) -> SymbolicGridAxis {
    SymbolicGridAxis {
        express_id: 1,
        grid_express_id: 2,
        tag: "A".to_string(),
        endpoints: [0.0, 0.0, 1.0, 0.0],
        world_y,
    }
}

fn polyline(world_y: f32) -> SymbolicPolyline {
    SymbolicPolyline {
        express_id: 3,
        ifc_type: "IfcAnnotation".to_string(),
        points: vec![0.0, 0.0, 1.0, 1.0],
        closed: false,
        world_y,
        representation: "Annotation".to_string(),
    }
}

fn fill(world_y: f32, hatch_angle_secondary: f32) -> SymbolicFillArea {
    SymbolicFillArea {
        express_id: 4,
        ifc_type: "IfcAnnotation".to_string(),
        points: vec![0.0, 0.0, 1.0, 0.0, 1.0, 1.0],
        holes_offsets: vec![],
        fill_color: [0.0, 0.0, 0.0, 1.0],
        has_hatching: true,
        hatch_spacing: 0.1,
        hatch_angle: 0.0,
        hatch_angle_secondary,
        hatch_line_width: 0.01,
        world_y,
        representation: "Annotation".to_string(),
    }
}

/// RED: an unresolved `world_y` must survive a full JSON round-trip through
/// the same serializer/deserializer pair the server's symbolic cache uses.
///
/// Before the fix this panicked on `from_str` with
/// `invalid type: null, expected f32`.
#[test]
fn unresolved_world_y_survives_a_json_round_trip() {
    let data = SymbolicData {
        grid_axes: vec![axis(f32::NAN)],
        polylines: vec![polyline(f32::NAN)],
        circles: vec![],
        texts: vec![],
        fills: vec![fill(f32::NAN, f32::NAN)],
    };

    let json = serde_json::to_string(&data).expect("SymbolicData serializes");
    let back: SymbolicData =
        serde_json::from_str(&json).expect("unresolved SymbolicData must deserialize");

    assert!(
        back.grid_axes[0].world_y.is_nan(),
        "grid axis world_y must come back unresolved, got {}",
        back.grid_axes[0].world_y
    );
    assert!(
        back.polylines[0].world_y.is_nan(),
        "polyline world_y must come back unresolved, got {}",
        back.polylines[0].world_y
    );
    assert!(
        back.fills[0].world_y.is_nan(),
        "fill world_y must come back unresolved, got {}",
        back.fills[0].world_y
    );
    assert!(
        back.fills[0].hatch_angle_secondary.is_nan(),
        "absent cross-hatch angle must come back unresolved, got {}",
        back.fills[0].hatch_angle_secondary
    );
}

/// The wire spelling of "unresolved" is JSON `null` — not a missing key, not
/// a magic number. Pinned so the TypeScript declaration
/// (`packages/server-client/src/types.ts`, `world_y: number | null`) and this
/// side cannot drift apart.
#[test]
fn unresolved_world_y_is_spelled_null_on_the_wire() {
    let data = SymbolicData {
        grid_axes: vec![axis(f32::NAN)],
        polylines: vec![],
        circles: vec![],
        texts: vec![],
        fills: vec![],
    };

    let json = serde_json::to_value(&data).expect("SymbolicData serializes");
    let wire = &json["grid_axes"][0];
    assert!(
        wire.as_object().unwrap().contains_key("world_y"),
        "unresolved must be an explicit null, never an omitted key: {json}"
    );
    assert!(
        wire["world_y"].is_null(),
        "unresolved world_y must serialize as null, got {}",
        wire["world_y"]
    );
}

/// Cross-language pin. The TypeScript declaration of this payload lives in
/// `packages/server-client/src/types.ts`, and a hand-written JSON literal on
/// that side would only test TypeScript's assumption about the wire, not the
/// wire. So the fixture the TS test reads is EMITTED HERE, by the real
/// serializer, and this test fails if the checked-in bytes drift from what
/// the serializer now produces.
///
/// Regenerate deliberately with `UPDATE_SYMBOLIC_WIRE_FIXTURE=1 cargo test`.
/// A regeneration that changes these bytes IS a wire-format change and must
/// be matched on the TypeScript side in the same commit.
#[test]
fn the_typescript_wire_fixture_matches_what_the_serializer_emits() {
    let data = SymbolicData {
        // Unresolved elevation.
        grid_axes: vec![axis(f32::NAN)],
        // A genuine 0.0 elevation — the value `null` must never collapse into.
        polylines: vec![polyline(0.0)],
        circles: vec![],
        texts: vec![],
        // Resolved elevation, absent cross-hatch.
        fills: vec![fill(3.5, f32::NAN)],
    };
    let mut emitted = serde_json::to_string_pretty(&data).expect("SymbolicData serializes");
    emitted.push('\n');

    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/server-client/src/__fixtures__/symbolic-unresolved-wire.json");

    if std::env::var_os("UPDATE_SYMBOLIC_WIRE_FIXTURE").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &emitted).unwrap();
        return;
    }

    let checked_in = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing wire fixture {}: {e}", path.display()));
    assert_eq!(
        checked_in,
        emitted,
        "the symbolic wire format changed; `packages/server-client/src/types.ts` \
         must be updated to match, then regenerate with \
         UPDATE_SYMBOLIC_WIRE_FIXTURE=1"
    );
}

/// BOUNDING CONTROL — the one that matters most. A genuine finite `world_y`,
/// **including exactly `0.0`**, must round-trip bit-for-bit and must stay
/// distinguishable from unresolved. This passes before AND after the fix; if
/// it ever stops passing, the fix has eaten a real elevation.
#[test]
fn finite_world_y_including_zero_round_trips_unchanged() {
    for &value in &[0.0f32, -0.0, 3.5, -12.25, 1e-7, 1.0e9] {
        let data = SymbolicData {
            grid_axes: vec![axis(value)],
            polylines: vec![polyline(value)],
            circles: vec![],
            texts: vec![],
            fills: vec![fill(value, 0.0)],
        };

        let json = serde_json::to_string(&data).expect("SymbolicData serializes");
        let back: SymbolicData = serde_json::from_str(&json).expect("finite data deserializes");

        assert_eq!(
            back.grid_axes[0].world_y.to_bits(),
            value.to_bits(),
            "finite grid-axis world_y {value} must round-trip exactly"
        );
        assert_eq!(
            back.polylines[0].world_y.to_bits(),
            value.to_bits(),
            "finite polyline world_y {value} must round-trip exactly"
        );
        assert_eq!(
            back.fills[0].world_y.to_bits(),
            value.to_bits(),
            "finite fill world_y {value} must round-trip exactly"
        );
        assert_eq!(
            back.fills[0].hatch_angle_secondary, 0.0,
            "a genuine 0.0 cross-hatch angle must NOT be read back as absent"
        );
        assert!(
            !back.grid_axes[0].world_y.is_nan(),
            "finite {value} must never be confused with unresolved"
        );
    }
}

/// BOUNDING CONTROL — `0.0` and unresolved must produce DIFFERENT wire bytes
/// and stay different after the round-trip. This is the whole point of the
/// sentinel; a representation that collapses them is worse than the bug.
#[test]
fn zero_and_unresolved_stay_distinguishable_across_the_boundary() {
    let zero = serde_json::to_string(&axis(0.0)).unwrap();
    let unresolved = serde_json::to_string(&axis(f32::NAN)).unwrap();
    assert_ne!(
        zero, unresolved,
        "a real 0.0 elevation and an unresolved one must not share a wire form"
    );

    let zero_back: SymbolicGridAxis = serde_json::from_str(&zero).unwrap();
    let unresolved_back: SymbolicGridAxis = serde_json::from_str(&unresolved).unwrap();
    assert_eq!(zero_back.world_y, 0.0);
    assert!(!zero_back.world_y.is_nan());
    assert!(unresolved_back.world_y.is_nan());
}

/// "Unresolved" (`null`) must stay distinguishable from "the producer never
/// wrote this field at all" (key missing). A missing key is a hard
/// deserialization error — it is NOT quietly reinterpreted as unresolved —
/// so a truncated or foreign payload can never masquerade as a legitimate
/// "elevation not known" signal.
///
/// Guarding `is_nan()` rather than `!is_finite()` matters here: `Infinity`
/// also fails `is_finite`, and it is not the sentinel.
#[test]
fn a_missing_world_y_is_an_error_not_an_unresolved_value() {
    let mut wire = serde_json::to_value(axis(f32::NAN)).unwrap();
    wire.as_object_mut().unwrap().remove("world_y");

    let err = serde_json::from_value::<SymbolicGridAxis>(wire)
        .expect_err("a missing world_y must not silently become unresolved");
    assert!(
        err.to_string().contains("world_y"),
        "error should name the missing field, got: {err}"
    );
}
