// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the shared dropped-item breakdown formatter. It exists so the
//! wasm console warning and the native `tracing::warn!` cannot drift; nothing
//! held it to a shape, so either surface could have been changed back without
//! a failing test.

use super::unsupported_items::{format_unsupported_breakdown, summarize};
use rustc_hash::FxHashMap;

fn map(pairs: &[(&str, u64)]) -> FxHashMap<String, u64> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
}

/// The separator is `", "`. The two surfaces had already diverged on it once
/// (comma vs space), which is why the formatter was extracted; without this,
/// extracting it fixed the drift but left nothing stopping the next one.
#[test]
fn the_breakdown_is_comma_space_separated_and_count_desc() {
    let s = format_unsupported_breakdown(&map(&[
        ("IfcGeometricSet", 2),
        ("IfcAnnotationFillArea", 7),
        ("IfcPolyline", 1),
    ]));
    assert_eq!(s, "IfcAnnotationFillArea=7, IfcGeometricSet=2, IfcPolyline=1");
}

/// The tie-break is by NAME, so a tie cannot be ordered by `FxHashMap`
/// iteration -- two runs over the same model would otherwise print different
/// strings. Built from two different insertion orders of the same counts:
/// sorting on count alone leaves this free to disagree, and it did.
#[test]
fn equal_counts_break_by_name_not_by_hash_order() {
    let forward = map(&[("IfcZeta", 3), ("IfcAlpha", 3), ("IfcMu", 3)]);
    let reverse = map(&[("IfcMu", 3), ("IfcAlpha", 3), ("IfcZeta", 3)]);

    assert_eq!(
        format_unsupported_breakdown(&forward),
        "IfcAlpha=3, IfcMu=3, IfcZeta=3",
        "ties must sort by name"
    );
    assert_eq!(
        format_unsupported_breakdown(&forward),
        format_unsupported_breakdown(&reverse),
        "the same counts must print the same string whatever order they were inserted in"
    );
}

/// Count still wins over name: a later name with a bigger count comes first,
/// so the name tie-break cannot have been implemented as a plain name sort.
#[test]
fn count_outranks_name() {
    let s = format_unsupported_breakdown(&map(&[("IfcAlpha", 1), ("IfcZeta", 9)]));
    assert_eq!(s, "IfcZeta=9, IfcAlpha=1");
}

/// Empty in, empty out: the callers gate on their own emptiness check, so this
/// pins that the formatter does not invent a separator or a placeholder.
#[test]
fn an_empty_map_formats_as_the_empty_string() {
    assert_eq!(format_unsupported_breakdown(&FxHashMap::default()), "");
}

/// `summarize` is the same ordering used for the serialized
/// `unsupportedItemsByType`, so the wire order and the printed order come from
/// one decision rather than two that agree today.
#[test]
fn summarize_totals_and_orders_the_same_way_the_string_does() {
    let (total, by_type) = summarize(&map(&[("IfcZeta", 3), ("IfcAlpha", 3), ("IfcMu", 4)]));
    assert_eq!(total, 10);
    let order: Vec<&str> = by_type.iter().map(|rc| rc.reason.as_str()).collect();
    assert_eq!(order, ["IfcMu", "IfcAlpha", "IfcZeta"]);
}
