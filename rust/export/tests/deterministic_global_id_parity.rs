// SPDX-License-Identifier: MPL-2.0
//! Pins `ifc_lite_export::deterministic_global_id` (Rust) to the shared
//! cross-language vectors in `tests/fixtures/deterministic_global_id_vectors.json`.
//! The TS implementation in `@ifc-lite/parser`
//! (`packages/parser/src/deterministic-global-id.ts`) is held to the SAME
//! fixture (`packages/parser/src/deterministic-global-id.parity.test.ts`), so
//! the two mints cannot silently drift apart -- the exact gap #3015 names:
//! "the Rust side has four JS golden-value anchors [now three, verified
//! against current code]; the missing piece is the other direction". This is
//! that other direction.

use ifc_lite_export::deterministic_global_id;

#[test]
fn rust_deterministic_global_id_matches_the_shared_vectors() {
    let raw = include_str!("fixtures/deterministic_global_id_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    // Same floor as the TS half (`deterministic-global-id.parity.test.ts`
    // asserts `> 10`). A parity pair whose two sides accept different fixture
    // sizes has a hole exactly the width of the difference: a fixture trimmed
    // to one case would leave this side green while the other side failed --
    // or, worse, be trimmed on a branch where only this side runs. Every other
    // parity pair in the repo matches its floors, `csv_cell_parity.rs`
    // included.
    assert!(
        cases.len() > 10,
        "fixture should carry the full vector set, got {}",
        cases.len()
    );

    for case in cases {
        let seed = case["seed"].as_str().expect("seed is a string");
        let expected = case["expected"].as_str().expect("expected is a string");
        let got = deterministic_global_id(seed);
        assert_eq!(
            got, expected,
            "seed {seed:?}: rust minted {got}, JS minted {expected}"
        );
    }
}
