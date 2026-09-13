// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `prepass_sharded`, split out for the module-size ratchet.

use super::check_rgba_columns;

/// `finalizePrepassStyles` used to index `orphan_colors[i * 4 + 3]` with no
/// length check, so on wasm (`panic=abort`) a short colour column crashed the
/// worker mid-load (#4614). Mutation that fails this test: compare against
/// `ids.len()` instead of four floats per id.
#[test]
fn a_colour_column_must_carry_exactly_four_floats_per_id() {
    assert_eq!(check_rgba_columns("orphan", &[], &[]), Ok(()));
    assert_eq!(check_rgba_columns("orphan", &[1, 2], &[0.0; 8]), Ok(()));

    let short = check_rgba_columns("orphan", &[1, 2], &[0.0; 4]).unwrap_err();
    assert!(short.contains("2 ids need 8 colour floats, got 4"), "{short}");
    assert!(short.starts_with("orphan"), "{short}");
    // `isColumnLengthRefusal` (packages/geometry/src/wasm-column-refusal.ts)
    // keys on this phrase to skip its copy-and-retry fallback; rewording it
    // silently re-enables the retry.
    assert!(short.contains("columns disagree"), "{short}");

    // One float short of the last id is the off-by-one that reads past the end.
    let one_short = check_rgba_columns("geometry", &[1, 2], &[0.0; 7]).unwrap_err();
    assert!(one_short.contains("got 7"), "{one_short}");

    // Too many floats is equally a disagreement: the pairing is by index, so
    // a surplus means some id is reading another id's colour.
    let long = check_rgba_columns("geometry", &[1], &[0.0; 8]).unwrap_err();
    assert!(long.contains("1 ids need 4 colour floats, got 8"), "{long}");
}
