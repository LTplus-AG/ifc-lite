// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Baseline parity lock for the styling unification (issue #913, Phase 0).
//!
//! This test does NOT exercise the full mesh pipeline yet — the shared
//! decoder-driven resolver arrives in Phase 2, and the end-to-end golden
//! fixtures (browser vs backend on real IFC files) land alongside it. What
//! it locks today is the **default-color table**, the only shared styling
//! surface that exists so far.
//!
//! It snapshots the two historical tables (`wasm-bindings`
//! `get_default_color_for_type` and `processing` `get_default_color`,
//! captured 2026-06) and asserts that the new canonical
//! `default_color_for_type`:
//!   1. agrees with BOTH old tables on every type they already shared, and
//!   2. resolves the four contested types to the agreed union (plan §8.1).
//!
//! When Phase 1 deletes the old table bodies, this file is the proof that
//! the only behavioral change is the four documented entries.

use ifc_lite_core::IfcType;
use ifc_lite_processing::default_color_for_type;

const NEUTRAL_GRAY: [f32; 4] = [0.8, 0.8, 0.8, 1.0];

/// Snapshot of the historical `wasm-bindings` table
/// (`rust/wasm-bindings/src/api/styling.rs:970`, 2026-06).
/// `None` => the type fell through to the neutral-gray default.
fn wasm_default(t: IfcType) -> [f32; 4] {
    match t {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],
        IfcType::IfcStair => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcCurtainWall => [0.5, 0.7, 0.9, 0.5],
        IfcType::IfcFurnishingElement => [0.7, 0.55, 0.4, 1.0],
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],
        // NOTE: wasm lacked IfcStairFlight and IfcBuildingElementProxy.
        _ => NEUTRAL_GRAY,
    }
}

/// Snapshot of the historical `processing` table
/// (`rust/processing/src/processor.rs:2140`, 2026-06).
fn processing_default(t: IfcType) -> [f32; 4] {
    match t {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],
        IfcType::IfcStair | IfcType::IfcStairFlight => [0.75, 0.75, 0.75, 1.0],
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],
        IfcType::IfcFurnishingElement => [0.5, 0.35, 0.2, 1.0],
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],
        IfcType::IfcBuildingElementProxy => [0.6, 0.6, 0.6, 1.0],
        // NOTE: processing lacked IfcCurtainWall.
        _ => NEUTRAL_GRAY,
    }
}

/// Every type that either historical table mapped explicitly.
const MAPPED_TYPES: &[IfcType] = &[
    IfcType::IfcWall,
    IfcType::IfcWallStandardCase,
    IfcType::IfcSlab,
    IfcType::IfcRoof,
    IfcType::IfcColumn,
    IfcType::IfcBeam,
    IfcType::IfcMember,
    IfcType::IfcWindow,
    IfcType::IfcDoor,
    IfcType::IfcStair,
    IfcType::IfcStairFlight,
    IfcType::IfcRailing,
    IfcType::IfcPlate,
    IfcType::IfcCovering,
    IfcType::IfcCurtainWall,
    IfcType::IfcFurnishingElement,
    IfcType::IfcSpace,
    IfcType::IfcOpeningElement,
    IfcType::IfcSite,
    IfcType::IfcBuildingElementProxy,
];

/// The four types whose values diverged between the tables (plan §2.2/§8.1).
const CONTESTED: &[IfcType] = &[
    IfcType::IfcStairFlight,
    IfcType::IfcCurtainWall,
    IfcType::IfcFurnishingElement,
    IfcType::IfcBuildingElementProxy,
];

fn is_contested(t: IfcType) -> bool {
    CONTESTED.contains(&t)
}

#[test]
fn union_agrees_with_both_tables_on_uncontested_types() {
    for &t in MAPPED_TYPES {
        if is_contested(t) {
            continue;
        }
        let canonical = default_color_for_type(t).to_array();
        assert_eq!(
            canonical,
            wasm_default(t),
            "{t:?}: canonical must match the wasm table on uncontested types"
        );
        assert_eq!(
            canonical,
            processing_default(t),
            "{t:?}: canonical must match the processing table on uncontested types"
        );
    }
}

#[test]
fn union_picks_the_documented_winner_for_contested_types() {
    // Exactly the four contested types, exactly these values, sourced as §8.1 decided.
    let cases = [
        // (type, canonical, came_from_wasm)
        (IfcType::IfcStairFlight, [0.75, 0.75, 0.75, 1.0], false), // processing
        (IfcType::IfcCurtainWall, [0.5, 0.7, 0.9, 0.5], true),     // wasm
        (IfcType::IfcFurnishingElement, [0.7, 0.55, 0.4, 1.0], true), // wasm (light wood)
        (IfcType::IfcBuildingElementProxy, [0.6, 0.6, 0.6, 1.0], false), // processing
    ];

    for (t, expected, from_wasm) in cases {
        let canonical = default_color_for_type(t).to_array();
        assert_eq!(canonical, expected, "{t:?}: unexpected canonical value");

        let winner = if from_wasm {
            wasm_default(t)
        } else {
            processing_default(t)
        };
        assert_eq!(canonical, winner, "{t:?}: canonical must equal the chosen source table");
    }

    // FurnishingElement specifically must NOT keep processing's darker brown.
    assert_ne!(
        default_color_for_type(IfcType::IfcFurnishingElement).to_array(),
        processing_default(IfcType::IfcFurnishingElement),
        "furnishing must change away from processing's [0.5,0.35,0.2,1]"
    );
}

#[test]
fn exactly_four_types_change_per_table() {
    // Guard rail: the migration must touch ONLY the four contested types.
    let wasm_deltas: Vec<IfcType> = MAPPED_TYPES
        .iter()
        .copied()
        .filter(|&t| default_color_for_type(t).to_array() != wasm_default(t))
        .collect();
    let processing_deltas: Vec<IfcType> = MAPPED_TYPES
        .iter()
        .copied()
        .filter(|&t| default_color_for_type(t).to_array() != processing_default(t))
        .collect();

    // vs wasm: StairFlight + BuildingElementProxy gain a non-default value.
    assert_eq!(
        wasm_deltas,
        vec![IfcType::IfcStairFlight, IfcType::IfcBuildingElementProxy],
        "unexpected changes relative to the wasm table"
    );
    // vs processing: CurtainWall gains glass blue, FurnishingElement lightens.
    assert_eq!(
        processing_deltas,
        vec![IfcType::IfcCurtainWall, IfcType::IfcFurnishingElement],
        "unexpected changes relative to the processing table"
    );
}
