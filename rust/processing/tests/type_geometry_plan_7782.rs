// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7782: native discovery, browser spans, and batch fallback agree on the
//! authored maps and class/order decisions, and (F2 #8341) on the type
//! records the full decoder rejects, which both omit and report.
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_processing::{
    discovery::{Discovery, TypeGeometryPlan},
    element::TypeGeometryMode,
    scan::ScanClass,
};

fn compare(content: &[u8], mode: TypeGeometryMode) -> TypeGeometryPlan {
    let mut discovery = Discovery::new(true);
    let mut mapped = Vec::new();
    let mut defines = Vec::new();
    let mut candidates = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        let class = ScanClass::classify(name);
        discovery.observe(content, class, id, name, start, end);
        if class == ScanClass::MappedItem { mapped.push((id, start, end)); }
        if class == ScanClass::RelDefinesByType { defines.push((id, start, end)); }
        if let Some(ty) = ifc_lite_core::type_product_ifc_type(name) {
            candidates.push((id, start, end, ty));
        }
    }
    let mut native = TypeGeometryPlan::from_scan(discovery.types, discovery.mapped_item_plan, mode);
    let native_omitted = native.retain_decodable_products(&EntityDecoder::new(content));
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index.clone());
    let mut browser = TypeGeometryPlan::from_spans(content, &mapped, &defines, &[], &mut decoder, mode);
    assert_eq!(native_omitted, browser.decode_products_reporting(content, &candidates, &mut decoder));
    let mut fallback_decoder = EntityDecoder::with_index(content, index);
    let fallback = TypeGeometryPlan::from_file(content, &mut fallback_decoder, mode);
    for plan in [&browser, &fallback] {
        assert_eq!(native.referenced_representation_maps, plan.referenced_representation_maps);
        assert_eq!(native.instantiated_type_ids, plan.instantiated_type_ids);
        assert_eq!(native.mapped_item_plan, plan.mapped_item_plan);
        for (id, _, _, _, maps) in &native.products {
            let authored: Vec<_> = maps.iter().map(|(map, _)| *map).collect();
            assert_eq!(native.maps_for(*id, &authored), plan.maps_for(*id, &authored));
        }
    }
    {
        let shape = |p: &TypeGeometryPlan| p.products.iter()
            .map(|(id, _, _, _, maps)| (*id, maps.clone())).collect::<Vec<_>>();
        assert_eq!(shape(&native), shape(&browser));
        assert_eq!(native.jobs(), browser.jobs());
    }
    browser
}

#[test]
fn issue_7782_type_plan_modes_and_fallback_agree() {
    for content in [
        include_bytes!("fixtures/c4_0_refusal_parity_7782.ifc").as_slice(),
        include_bytes!("fixtures/c4_bare_type_map_7782.ifc").as_slice(),
        include_bytes!("fixtures/c4_native_unsliced_layers_7782.ifc").as_slice(),
        include_bytes!("fixtures/c4_type_geometry_modes_7782.ifc").as_slice(),
        include_bytes!("fixtures/f2_omitted_type_record_8341.ifc").as_slice(),
        include_bytes!("fixtures/issue_1781_image_textures.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc").as_slice(),
        include_bytes!("fixtures/issue_2019_wall_two_overlapping_openings.ifc").as_slice(),
        include_bytes!("fixtures/issue_3641_voiding_trap.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc").as_slice(),
        include_bytes!("fixtures/issue_6601_multicolor_element.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_indexed_colour.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_indexed_colour_uniform.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_site_rotated.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_site_translated.ifc").as_slice(),
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc").as_slice(),
    ] {
        let native = compare(content, TypeGeometryMode::SuppressInstanced);
        let browser = compare(content, TypeGeometryMode::EmitTagged);
        assert_eq!(native.referenced_representation_maps, browser.referenced_representation_maps);
        assert_eq!(native.instantiated_type_ids, browser.instantiated_type_ids);
    }
    let content = include_bytes!("fixtures/c4_type_geometry_modes_7782.ifc");
    let browser = compare(content, TypeGeometryMode::EmitTagged);
    let native = compare(content, TypeGeometryMode::SuppressInstanced);
    assert!(browser.products.iter().any(|(id, _, _, _, maps)| *id == 101 && maps == &[(116, 2)]));
    assert!(native.products.iter().any(|(id, _, _, _, maps)| *id == 101 && maps.is_empty()));
    assert!(native.products.iter().any(|(id, _, _, _, maps)| *id == 100 && maps == &[(16, 1)]));
}
