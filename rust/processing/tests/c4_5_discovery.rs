// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7782: shared discovery preserves ordering, type maps and shard diagnostics.
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::{discovery::Discovery, scan::ScanClass, scan_shard_result};

#[test]
fn c4_5_discovery_retains_first_spatial_and_type_map_inputs() {
    let content = b"#1=IFCPROJECT();#2=IFCPROJECT();#3=IFCSITE();#4=IFCBUILDING('g',$,$,$,$,$,#42);#5=IFCWALLTYPE('g',$,$,$,$,$,(#10,#11));#6=IFCMAPPEDITEM(#10,#9);#7=IFCMAPPEDITEM(#10,#9);#8=IFCRELDEFINESBYTYPE('g',$,$,$,(#4),#5);";
    let mut discovery = Discovery::new(true);
    let mut scanner = EntityScanner::new(content);
    let mut jobs = Vec::new();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if discovery
            .observe(content, ScanClass::classify(name), id, name, start, end)
            .is_some()
        {
            jobs.push(id);
        }
    }
    assert_eq!(jobs, [3, 4]);
    assert_eq!(discovery.project_id, Some(1));
    assert_eq!(discovery.types.products[0].4, [10, 11]);
    assert!(discovery.types.referenced_representation_maps.contains(&10));
    assert!(discovery.types.instantiated_type_ids.contains(&5));
    assert_eq!(discovery.mapped_item_plan.get(&10), Some(&(2, 6)));
    assert_eq!(discovery.prepass_spans.defines_by_type.len(), 1);
}

#[test]
fn c4_5_shard_named_result_retains_diagnostics_and_optional_classes() {
    let content = b"#1=IFCWALL();#4294967297=IFCWALL();#2=IFCSITE();";
    let plain = scan_shard_result(content, 0, content.len(), false);
    let classified = scan_shard_result(content, 0, content.len(), true);
    assert_eq!(plain.records, classified.records);
    assert_eq!(plain.refusals, [13]);
    assert_eq!(classified.refusals, plain.refusals);
    assert!(plain.classes.is_none());
    assert_eq!(classified.classes.unwrap(), [0x80, 3]);
    assert_eq!(plain.records.iter().map(|r| r.0).collect::<Vec<_>>(), [1, 2]);
}

/// #7782 C4-6b: browser discovery keeps jobs/spans but never retains native maps.
#[test]
fn c4_6b_browser_scope_preserves_discovery_without_native_type_state() {
    let content = b"#1=IFCPROJECT();#2=IFCSITE();#3=IFCWALL();#4=IFCWALLTYPE('g',$,$,$,$,$,(#10,#11));#5=IFCMAPPEDITEM(#10,#9);#6=IFCRELDEFINESBYTYPE('g',$,$,$,(#3),#4);";
    let mut browser = Discovery::default();
    let mut native = Discovery::new(true);
    let mut scanner = EntityScanner::new(content);
    let mut jobs = Vec::new();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        let class = ScanClass::classify(name);
        let job = browser.observe_browser(content, class, id, name, start, end);
        assert_eq!(job, native.observe(content, class, id, name, start, end));
        if job.is_some() {
            jobs.push(id);
        }
    }
    assert_eq!(jobs, [2, 3]);
    assert_eq!(browser.project_id, Some(1));
    assert_eq!(browser.site_entity_pos, native.site_entity_pos);
    assert_eq!(browser.prepass_spans.defines_by_type, native.prepass_spans.defines_by_type);
    assert_eq!(browser.prepass_spans.defines_by_type.len(), 1);
    assert!(browser.types.products.is_empty());
    assert!(browser.types.referenced_representation_maps.is_empty());
    assert!(browser.types.instantiated_type_ids.is_empty());
    assert!(browser.mapped_item_plan.is_empty());
    assert_eq!(native.types.products.len(), 1);
    assert_eq!(native.types.referenced_representation_maps.len(), 1);
    assert_eq!(native.types.instantiated_type_ids.len(), 1);
    assert_eq!(native.mapped_item_plan.len(), 1);
}
