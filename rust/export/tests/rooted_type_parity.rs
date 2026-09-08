// SPDX-License-Identifier: MPL-2.0
//! Pins `rooted_type::is_rooted_type` (Rust) to the shared cross-language
//! sweep in `tests/fixtures/rooted_type_sweep.json`. The JS classifier in
//! `packages/export/src/merged-exporter.ts` (`isRootedType`) is held to the
//! same fixture (`packages/export/src/rooted-type-sweep.parity.test.ts`), so
//! the two "is this entity type an IfcRoot subtype" answers cannot silently
//! drift apart -- the exact failure mode #3015 is about.
//!
//! Exhaustive over a universe this file re-derives itself rather than trusts:
//! the whole IFC4X3 generated schema, the legacy IFC2X3/IFC4 rooted table,
//! and `ifc_lite_core::LEGACY_ENTITY_NAMES` (the Rust mirror of the JS
//! `ENTITY_NAME_ALIASES` table), plus the two vendor names that exercise the
//! safe-miss direction. Both halves matter, and for different reasons:
//!
//!   - a name the universe omits is one the gate cannot see, which is how the
//!     three stratum leaves stayed divergent while both halves were green;
//!   - a row the fixture omits is a disagreement that can be deleted away,
//!     since a count-only floor (`> 900`) survives dropping 31 rows.
//!
//! `fixture_covers_the_whole_type_universe` closes both.

use ifc_lite_export::rooted_type::{is_rooted_type, LEGACY_ROOTED_TYPES};
use std::collections::BTreeSet;

/// The two vendor names the sweep carries deliberately: neither is in
/// `IFC_TYPES` nor in any legacy table, so nothing else in the workspace can
/// re-derive them, and they are the only rows that exercise "unrecognised
/// name is NOT rooted" -- the direction whose absence would reintroduce the
/// corruption `rooted_type.rs` exists to prevent.
const VENDOR_NAMES: &[&str] = &["IFCACMEWIDGETPROXY", "IFCVENDOREXTENSIONFOO"];

fn fixture_cases() -> Vec<(String, bool)> {
    let raw = include_str!("fixtures/rooted_type_sweep.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    doc["cases"]
        .as_array()
        .expect("cases is an array")
        .iter()
        .map(|case| {
            (
                case["type"].as_str().expect("type is a string").to_string(),
                case["rooted"].as_bool().expect("rooted is a bool"),
            )
        })
        .collect()
}

/// Pins WHICH rows the fixture holds, not just how many. Without this, a row
/// whose two sides disagree can be deleted and both halves of the gate go
/// green again on the remaining rows -- the fixture is the only thing the two
/// languages share, so nothing else would notice.
#[test]
fn fixture_covers_the_whole_type_universe() {
    let mut want: BTreeSet<String> = ifc_lite_core::IFC_TYPES
        .iter()
        .map(|t| t.as_str().to_string())
        .collect();
    want.extend(LEGACY_ROOTED_TYPES.iter().map(|n| n.to_string()));
    want.extend(
        ifc_lite_core::LEGACY_ENTITY_NAMES
            .iter()
            .map(|n| n.to_string()),
    );
    want.extend(VENDOR_NAMES.iter().map(|n| n.to_string()));

    let have: BTreeSet<String> = fixture_cases().into_iter().map(|(name, _)| name).collect();

    let missing: Vec<&String> = want.difference(&have).collect();
    assert!(
        missing.is_empty(),
        "{} type(s) in the universe have no fixture row -- the sweep is blind to them:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|n| n.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );

    let extra: Vec<&String> = have.difference(&want).collect();
    assert!(
        extra.is_empty(),
        "{} fixture row(s) are outside the universe this test can re-derive; \
         add them to a table or to VENDOR_NAMES so the universe stays checkable:\n{}",
        extra.len(),
        extra
            .iter()
            .map(|n| n.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn rust_rooted_type_matches_the_shared_sweep() {
    let cases = fixture_cases();
    assert!(
        cases.len() > 900,
        "fixture should exhaustively cover the ~936-type sweep, got {}",
        cases.len()
    );

    let mut mismatches: Vec<String> = Vec::new();
    for (type_name, expected) in &cases {
        let got = is_rooted_type(type_name);
        if got != *expected {
            mismatches.push(format!("{type_name}: rust={got} js={expected}"));
        }
    }

    assert!(
        mismatches.is_empty(),
        "{} type(s) disagree with the JS classifier:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
