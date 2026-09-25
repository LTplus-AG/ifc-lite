// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5784: exact extrusion sources share a bounded occurrence walk with disks.

use std::collections::HashSet;
use ifc_lite_processing::{extract_extrusion_definitions, AnalyticSourceContext};

fn mapped_fixture() -> String {
    std::fs::read_to_string("../geometry/tests/fixtures/mapped_instances_synthetic.ifc").unwrap()
}

#[test]
fn mapped_occurrences_share_one_raw_profile_and_have_distinct_f64_world_frames() {
    let model = mapped_fixture();
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31, 38])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    let source = &view.sources[0];
    assert_eq!(source.source.solid_id, 12);
    assert_eq!(source.source.depth, Some(1.0));
    assert_eq!(source.source.profile.as_ref().unwrap().loops[0].signed_area, 1.0);
    let nominal = source.nominal_quantities.as_ref().unwrap();
    assert_eq!((nominal.profile_area, nominal.projected_height, nominal.nominal_volume),
        (1.0, 1.0, 1.0));
    assert!(matches!(&source.key.context,
        AnalyticSourceContext::Mapped { representation_map_path } if representation_map_path == &[16]));
    let first = &view.instances[&31][0];
    let second = &view.instances[&38][0];
    assert_eq!(first.source, second.source);
    assert_eq!(first.mapping_path, vec![25]);
    assert_eq!(second.mapping_path, vec![32]);
    assert_eq!(first.ordinal, 0);
    assert_eq!(second.ordinal, 0);
    assert!((first.world_from_source.unwrap()[12]).abs() < 1e-12);
    assert!((second.world_from_source.unwrap()[12] - 3.0).abs() < 1e-12);
    let empty = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::new()));
    assert!(empty.sources.is_empty());
    assert!(empty.instances.is_empty());
}

#[test]
fn direct_and_mapped_uses_have_distinct_source_contexts() {
    let model = mapped_fixture().replace(
        "#27=IFCPRODUCTDEFINITIONSHAPE($,$,(#26));",
        "#27=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31, 38])));
    assert_eq!(view.sources.len(), 2);
    assert!(matches!(view.instances[&31][0].source.context,
        AnalyticSourceContext::Direct { representation_id: 13 }));
    assert!(matches!(view.instances[&38][0].source.context,
        AnalyticSourceContext::Mapped { .. }));
}

#[test]
fn large_product_origin_stays_f64_and_does_not_mutate_raw_profile() {
    let model = mapped_fixture().replace(
        "#35=IFCCARTESIANPOINT((3.0,2.0,0.));",
        "#35=IFCCARTESIANPOINT((5000000000.0,2.0,0.));",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([38])));
    let matrix = view.instances[&38][0].world_from_source.unwrap();
    assert!((matrix[12] - 5_000_000_000.0).abs() < 1e-6);
    assert_eq!(view.sources[0].source.profile.as_ref().unwrap().loops[0].signed_area, 1.0);
}

#[test]
fn profile_solid_and_occurrence_positions_remain_separate_in_composition_order() {
    let model = mapped_fixture()
        .replace("#6=IFCCARTESIANPOINT((0.,0.));", "#6=IFCCARTESIANPOINT((2.,0.));")
        .replace("#10=IFCCARTESIANPOINT((0.,0.,0.));", "#10=IFCCARTESIANPOINT((0.,3.,0.));");
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([38])));
    let source = &view.sources[0].source;
    let profile = source.profile.as_ref().unwrap();
    assert_eq!(profile.profile_position.unwrap()[12], 2.0);
    assert_eq!(source.position_matrix.unwrap()[13], 3.0);
    let instance = &view.instances[&38][0];
    assert_eq!(instance.world_from_source.unwrap()[12..14], [3.0, 2.0]);
    // A profile-origin point in this source lands at (5, 5) world metres.
    assert_eq!(instance.world_from_source.unwrap()[12] + source.position_matrix.unwrap()[12]
        + profile.profile_position.unwrap()[12], 5.0);
    assert_eq!(instance.world_from_source.unwrap()[13] + source.position_matrix.unwrap()[13]
        + profile.profile_position.unwrap()[13], 5.0);
}

#[test]
fn real_revit_window_map_preserves_holed_profile_and_reuses_source() {
    let model = std::fs::read("../geometry/tests/fixtures/issue_098_wall_W.ifc").unwrap();
    let view = extract_extrusion_definitions(&model, Some(&HashSet::from([928638, 928672])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    let source = view.sources.iter().find(|source| source.source.solid_id == 338107).unwrap();
    assert_eq!(source.source.profile.as_ref().unwrap().loops.len(), 2);
    assert!(source.nominal_quantities.is_some());
    assert!(matches!(&source.key.context,
        AnalyticSourceContext::Mapped { representation_map_path } if representation_map_path == &[338168]));
    for id in [928638, 928672] {
        let instance = view.instances[&id].iter().find(|instance| instance.solid_id == 338107).unwrap();
        assert_eq!(instance.source, source.key);
        assert_eq!(instance.mapping_path.len(), 1);
        assert!(instance.world_from_source.is_some());
    }
}

#[test]
fn tapered_source_is_retained_with_explicit_unsupported_status() {
    let model = mapped_fixture().replace(
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(view.sources.len(), 1);
    assert!(serde_json::to_value(&view.sources[0].source.status).unwrap()["reason"]
        .as_str().unwrap().contains("tapered"));
    assert!(view.sources[0].nominal_quantities.is_none());
    assert_eq!(view.instances[&31].len(), 1);
}

#[test]
fn repeated_csg_operands_keep_two_ordinals_and_modified_provenance() {
    let model = mapped_fixture().replace(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SolidModel',(#500));",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#500=IFCBOOLEANRESULT(.UNION.,#12,#12);\nENDSEC;\nEND-ISO-10303-21;");
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31])));
    let instances = view.instances.get(&31).unwrap_or_else(|| panic!("{:?}", view.diagnostics));
    assert_eq!(instances.len(), 2);
    assert_eq!([instances[0].ordinal, instances[1].ordinal], [0, 1]);
    assert_eq!(instances[0].source, instances[1].source);
    assert!(instances.iter().all(|instance| instance.source_modified));
}
