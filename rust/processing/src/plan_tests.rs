// SPDX-License-Identifier: MPL-2.0
use super::TypeGeometryPlan;
use ifc_lite_core::{slot, EntityDecoder, EntityScanner};

#[test]
fn issue_7782_template_selection_is_independent_of_scan_order() {
    let content = include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    let mut mapped = Vec::new();
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        if ifc_lite_core::keyword_eq(kind, "IFCMAPPEDITEM") {
            let entity = decoder.decode_at_with_id(id, start, end).unwrap();
            mapped.push((id, entity.ref_at(slot::IfcMappedItem::MAPPING_SOURCE).unwrap()));
        }
    }
    // This fixture has 64 occurrence jobs drawing source #16; #25 is the
    // deterministic template regardless of file/shard observation order.
    assert_eq!(mapped.len(), 64);
    for reverse in [false, true] {
        if reverse { mapped.reverse(); }
        let mut plan = TypeGeometryPlan::default();
        for &(item, source) in &mapped { plan.observe_mapped(item, source, true); }
        assert_eq!(plan.repeated_sources(), vec![16]);
        assert_eq!(plan.into_mapped_instances().into_iter().collect::<Vec<_>>(), vec![(16, (64, 25))]);
    }
    // Disabling native instancing still suppresses type maps drawn by occurrences.
    let mut plan = TypeGeometryPlan::default();
    for &(item, source) in &mapped { plan.observe_mapped(item, source, false); }
    assert!(crate::element::plan_type_geometry(
        &[16], plan.referenced(), false, crate::element::TypeGeometryMode::SuppressInstanced,
    ).is_empty());
    assert!(plan.into_mapped_instances().is_empty());
}
