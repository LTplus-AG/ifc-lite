// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{check_index_columns, IfcAPI};

#[test]
fn issue_3989_borrowed_rust_api_preserves_caller_ownership_and_duplicate_semantics() {
    // The borrowed Rust adapter keeps its slice parameters; only the return
    // type grew a `Result` (recorded as a Rust API break for the pending major).
    let install: fn(&IfcAPI, &[u32], &[u32], &[u32]) -> Result<(), String> =
        IfcAPI::set_entity_index;
    let api = IfcAPI::new();
    let mut ids = [7, 3, 7];
    let mut starts = [10, 20, 30];
    let mut lengths = [1, 2, 3];
    install(&api, &ids, &starts, &lengths).unwrap();
    // Borrowed inputs remain caller-owned. Reusing them cannot corrupt the
    // installed index, and stable last-occurrence-wins behavior is unchanged.
    ids.fill(99);
    starts.fill(99);
    lengths.fill(99);
    let slot = api.cached_entity_index.lock().unwrap();
    let index = slot.as_ref().unwrap();
    assert_eq!(index.lookup(7), Some((30, 33)));
    assert_eq!(index.lookup(3), Some((20, 22)));
    assert_eq!(index.lookup(99), None);
}

#[test]
fn issue_3989_owned_binding_adopts_sorted_columns_without_reallocation() {
    let api = IfcAPI::new();
    let ids = vec![3, 7];
    let starts = vec![20, 30];
    let lengths = vec![2, 3];
    let pointers = (ids.as_ptr(), starts.as_ptr(), lengths.as_ptr());
    api.set_entity_index_owned_binding(ids, starts, lengths).unwrap();
    let slot = api.cached_entity_index.lock().unwrap();
    let index = slot.as_ref().unwrap();
    assert_eq!((index.ids().as_ptr(), index.starts().as_ptr(), index.lengths().as_ptr()), pointers);
    assert_eq!(index.lookup(7), Some((30, 33)));
}

#[test]
fn issue_3989_both_adapters_reset_content_caches_on_replacement() {
    let api = IfcAPI::new();
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    // A new source must not inherit old representation-map suppression.
    api.set_entity_index_owned_binding(vec![2], vec![30], vec![4]).unwrap();
    assert!(api.cached_referenced_repmaps.lock().unwrap().is_none());
    api.set_referenced_repmaps(&[2]);
    api.set_entity_index(&[3], &[40], &[5]).unwrap();
    assert!(api.cached_referenced_repmaps.lock().unwrap().is_none());
    assert_eq!(api.cached_entity_index.lock().unwrap().as_ref().unwrap().lookup(3), Some((40, 45)));
}

/// The boundary rule itself: the columns agree, or the error names every length.
#[test]
fn index_columns_must_agree_in_length() {
    assert_eq!(check_index_columns(3, 3, 3, None), Ok(()));
    assert_eq!(check_index_columns(3, 3, 3, Some(3)), Ok(()));
    assert_eq!(check_index_columns(0, 0, 0, None), Ok(()), "an empty index is consistent");
    let short_starts = check_index_columns(3, 2, 3, None).unwrap_err();
    assert!(short_starts.contains("ids 3, starts 2, lengths 3"), "{short_starts}");
    let short_lengths = check_index_columns(3, 3, 0, None).unwrap_err();
    assert!(short_lengths.contains("lengths 0"), "{short_lengths}");
    let short_classes = check_index_columns(3, 3, 3, Some(2)).unwrap_err();
    assert!(short_classes.contains("classes 2"), "{short_classes}");
}

/// A rejected `setEntityIndex` is an error the caller sees, and it leaves no
/// trace of the previous file behind. Before this, mismatched columns
/// produced an EMPTY `ColumnarEntityIndex`, `install_entity_index` treated
/// empty as "keep what we have", and a worker reused across loads carried
/// file 1's byte offsets, content caches and diagnostics into file 2 with no
/// signal (review finding K8). Mutation that fails this test: restore the
/// `if index.is_empty() { return; }` early return, or install nothing and
/// skip the state reset on the `Err` arm.
#[test]
fn a_rejected_entity_index_reports_the_mismatch_and_drops_the_previous_state() {
    let api = IfcAPI::new();
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    api.record_pipeline_batch(7, 0, 0, 0, 0, 0, 0, &Default::default());
    assert_eq!(api.pipeline_diagnostics.lock().unwrap().element_count, 7, "sanity: recorded");

    let rejected = api.set_entity_index(&[2], &[], &[3]);
    let message = rejected.expect_err("mismatched columns must be rejected");
    assert!(message.contains("ids 1, starts 0, lengths 1"), "{message}");

    assert!(
        api.cached_entity_index.lock().unwrap().is_none(),
        "file 1's index must not survive a rejected swap"
    );
    assert!(
        api.cached_referenced_repmaps.lock().unwrap().is_none(),
        "file 1's content caches must not survive a rejected swap"
    );
    assert_eq!(
        api.pipeline_diagnostics.lock().unwrap().element_count,
        0,
        "the diagnostics accumulator restarts on every swap attempt"
    );

    // Empty columns agree in length, so they are accepted, but they swap in
    // "no index" (the next batch scans its bytes), never an installed empty
    // index that would resolve no reference. Mutation that fails this: drop
    // the `is_empty` arm in `install_entity_index`.
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    api.set_entity_index(&[], &[], &[]).expect("empty columns are consistent");
    assert!(api.cached_entity_index.lock().unwrap().is_none(), "empty swaps in no index");
    assert!(api.cached_referenced_repmaps.lock().unwrap().is_none());

    // The owned JS binding (`setEntityIndex`) runs the same check and the
    // same install path; its `Err` arm builds a `JsValue`, which is a wasm
    // import that aborts the process off-target, so only its `Ok` arm is
    // exercised natively (the two `issue_3989_*` tests above).
}
