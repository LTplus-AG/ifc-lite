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

mod scan_floor;

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

// ---------------------------------------------------------------------------
// "No second table" guard (plan §6.3).
//
// Fails the build if a per-consumer IFC-type → color table reappears anywhere
// in the Rust sources. The canonical table is `style::default_color_for_type`;
// the historical copies were all named `fn get_default_color[...]`, so that is
// the signature we forbid outside the allowlist. This is the tripwire that
// would have caught the server and desktop copies the day they were added.
// ---------------------------------------------------------------------------




#[test]
fn no_duplicate_default_color_tables() {
    let Some(root) = scan_floor::repo_root() else {
        eprintln!("repo root not found (packaged context) — skipping guard");
        return;
    };

    // Paths allowed to still contain a `fn get_default_color*`:
    //  - this guard test itself (it names the pattern in prose/snapshots).
    let allow = |rel: &str| rel.ends_with("rust/processing/tests/styling_parity.rs");

    let files = scan_floor::collect_with_floor(&root, "styling guard");

    // Positive control, tracked INSIDE the loop that already reads each file:
    // the matcher must still find a declaration known to be present. A count of
    // files proves the walk read them; only this proves the MATCHER still works.
    let mut saw_canonical = false;
    let mut offenders = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if allow(&rel) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Match actual function declarations only, not prose/strings that
        // happen to mention the name (e.g. this guard's own doc comment).
        let mut declares_color_table = false;
        for name in src.lines().filter_map(scan_floor::declared_fn_name) {
            if name.starts_with("get_default_color") {
                declares_color_table = true;
            }
            if name == "default_color_for_type" {
                saw_canonical = true;
            }
        }
        if declares_color_table {
            offenders.push(rel);
        }
    }

    assert!(
        saw_canonical,
        "the matcher did not find `fn default_color_for_type`, which is known to exist in \
         processing::style. It is BLIND, so `offenders.is_empty()` below proves nothing (#3200)."
    );
    assert!(
        offenders.is_empty(),
        "found per-consumer default-color table(s) outside the canonical \
         `processing::style` — use `default_color_for_type` instead (issue #913): {offenders:?}"
    );
}

// ---------------------------------------------------------------------------
// "No second surface-style colour extractor" guard.
//
// The `IfcSurfaceStyle → IfcSurfaceStyleRendering → IfcColourRgb` leaf has one
// home: `ifc_lite_processing::style::extract_surface_style_colors`. The browser
// `wasm-bindings` used to carry its own copy (`extract_color_from_rendering` /
// `extract_color_rgb`), which silently disagreed with the server on
// SurfaceColour-vs-DiffuseColour precedence (#859/#871). Forbid those function
// names from reappearing so the two pipelines can't re-fork. (The 2D drafting
// palette in `symbolic.rs` uses differently-named `extract_color_from_*`
// helpers and is unaffected.)
// ---------------------------------------------------------------------------

#[test]
fn no_duplicate_surface_style_color_extraction() {
    let Some(root) = scan_floor::repo_root() else {
        eprintln!("repo root not found (packaged context) — skipping guard");
        return;
    };

    let allow = |rel: &str| {
        rel.ends_with("rust/processing/tests/styling_parity.rs")
            // Standalone debug examples can't depend on the downstream
            // `processing` crate, so they carry their own ad-hoc extraction.
            // They are not a production pipeline and don't affect server/viewer
            // parity, so they're exempt from this guard.
            || rel.starts_with("rust/geometry/examples/")
    };

    let files = scan_floor::collect_with_floor(&root, "styling guard");
    let mut saw_canonical = false;
    let mut offenders = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if allow(&rel) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut declares = false;
        for name in src.lines().filter_map(scan_floor::declared_fn_name) {
            // PREFIX, not equality: that is what this guard had before #3200,
            // and switching to `==` while extracting the shared matcher would
            // have let `extract_color_from_rendering_impl` or
            // `extract_color_rgb_v2` walk straight past a guard that used to
            // catch them — a loosening inside a hardening change. The
            // legitimate exemptions are handled by `allow` above, by path.
            if name.starts_with("extract_color_from_rendering")
                || name.starts_with("extract_color_rgb")
            {
                declares = true;
            }
            if name == "extract_surface_style_colors" {
                saw_canonical = true;
            }
        }
        if declares {
            offenders.push(rel);
        }
    }

    assert!(
        saw_canonical,
        "the matcher did not find `fn extract_surface_style_colors`, which is known to exist in \
         processing::style. It is BLIND, so `offenders.is_empty()` below proves nothing (#3200)."
    );
    assert!(
        offenders.is_empty(),
        "surface-style colour extraction must live only in \
         `ifc_lite_processing::style::extract_surface_style_colors`; found a per-pipeline \
         copy in: {offenders:?}"
    );
}
