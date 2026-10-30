// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::IfcAPI;
use ifc_lite_core::ColumnLengthMismatch;

fn populate_type_plan(api: &IfcAPI) {
    api.set_referenced_repmaps(&[91]);
    api.set_instantiated_type_ids(&[92]);
    let mut decoder = ifc_lite_core::EntityDecoder::new(b"");
    let plan = api.get_or_build_type_geometry_plan(b"", &mut decoder);
    assert!(plan.referenced_representation_maps.contains(&91));
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_some());
}

#[test]
fn issue_7782_type_plan_is_dropped_on_clear_prepass_cache() {
    let api = IfcAPI::new();
    populate_type_plan(&api);
    api.clear_pre_pass_cache();
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_none());
}

#[test]
fn issue_7782_type_plan_honours_each_injected_set_independently() {
    let source = include_str!("../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc")
        .replace("ENDSEC;\nEND-ISO", "#60=IFCMAPPEDITEM(#44,#45);\n#61=IFCRELDEFINESBYTYPE('0RelDefinesByType000A',$,$,$,(#1),#43);\nENDSEC;\nEND-ISO");
    let content = source.as_bytes();
    let index = ifc_lite_core::build_entity_index(content);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(content, index.clone());
    let api = IfcAPI::new();
    api.set_referenced_repmaps(&[999]);
    let plan = api.get_or_build_type_geometry_plan(content, &mut decoder);
    assert!(plan.referenced_representation_maps.contains(&999));
    assert!(!plan.referenced_representation_maps.contains(&44));
    assert!(plan.instantiated_type_ids.contains(&43));

    let api = IfcAPI::new();
    api.set_instantiated_type_ids(&[998]);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(content, index);
    let plan = api.get_or_build_type_geometry_plan(content, &mut decoder);
    assert!(plan.referenced_representation_maps.contains(&44));
    assert!(plan.instantiated_type_ids.contains(&998));
    assert!(!plan.instantiated_type_ids.contains(&43));
}

#[test]
fn issue_3989_borrowed_rust_api_preserves_caller_ownership_and_duplicate_semantics() {
    let api = IfcAPI::new();
    let mut ids = [7, 3, 7];
    let mut starts = [10, 20, 30];
    let mut lengths = [1, 2, 3];
    api.set_entity_index(&ids, &starts, &lengths).unwrap();
    // Borrowed inputs remain caller-owned. Reusing them cannot corrupt the
    // installed index, and stable last-occurrence-wins behavior is unchanged.
    ids.fill(99);
    starts.fill(99);
    lengths.fill(99);
    let slot = api.content.cached_entity_index.lock().unwrap();
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
    let slot = api.content.cached_entity_index.lock().unwrap();
    let index = slot.as_ref().unwrap();
    assert_eq!((index.ids().as_ptr(), index.starts().as_ptr(), index.lengths().as_ptr()), pointers);
    assert_eq!(index.lookup(7), Some((30, 33)));
}

#[test]
fn issue_3989_both_adapters_reset_content_caches_on_replacement() {
    let api = IfcAPI::new();
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    populate_type_plan(&api);
    // A new source must not inherit old representation-map suppression.
    api.set_entity_index_owned_binding(vec![2], vec![30], vec![4]).unwrap();
    assert!(api.content.cached_referenced_repmaps.lock().unwrap().is_none());
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_none());
    api.set_referenced_repmaps(&[2]);
    populate_type_plan(&api);
    api.set_entity_index(&[3], &[40], &[5]).unwrap();
    assert!(api.content.cached_referenced_repmaps.lock().unwrap().is_none());
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_none());
    assert_eq!(api.content.cached_entity_index.lock().unwrap().as_ref().unwrap().lookup(3), Some((40, 45)));
}

/// A rejected `setEntityIndex` is an error the caller sees and leaves nothing
/// of the previous file behind (#4614). Mismatched columns used to build an
/// empty index that `install_entity_index` read as "keep what we have", so a
/// worker reused across loads carried file 1's byte offsets, content caches
/// and diagnostics into file 2 with no signal.
#[test]
fn a_rejected_entity_index_reports_the_mismatch_and_drops_the_previous_state() {
    let api = IfcAPI::new();
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    populate_type_plan(&api);
    api.record_pipeline_batch(7, 0, 0, 0, 0, 0, 0, &Default::default());
    assert_eq!(api.pipeline_diagnostics.lock().unwrap().element_count, 7, "sanity: recorded");

    let rejected = api.set_entity_index(&[2], &[], &[3]);
    assert_eq!(rejected, Err(ColumnLengthMismatch { ids: 1, starts: 0, lengths: 1 }));

    assert!(
        api.content.cached_entity_index.lock().unwrap().is_none(),
        "file 1's index must not survive a rejected swap"
    );
    assert!(
        api.content.cached_referenced_repmaps.lock().unwrap().is_none(),
        "file 1's content caches must not survive a rejected swap"
    );
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_none());
    assert_eq!(
        api.pipeline_diagnostics.lock().unwrap().element_count,
        0,
        "the diagnostics accumulator restarts on every swap attempt"
    );

    // Empty columns are accepted but install no index, so the next batch scans
    // its bytes instead of consulting an index that resolves nothing.
    api.set_entity_index(&[1], &[10], &[2]).unwrap();
    api.set_referenced_repmaps(&[1]);
    populate_type_plan(&api);
    api.set_entity_index(&[], &[], &[]).expect("empty columns are consistent");
    assert!(api.content.cached_entity_index.lock().unwrap().is_none(), "empty swaps in no index");
    assert!(api.content.cached_referenced_repmaps.lock().unwrap().is_none());
    assert!(api.content.cached_type_geometry_plan.lock().unwrap().is_none());

    // The owned JS binding (`setEntityIndex`) runs the same check and the
    // same install path; its `Err` arm builds a `JsValue`, which is a wasm
    // import that aborts the process off-target, so only its `Ok` arm is
    // exercised natively (the two `issue_3989_*` tests above).
}
