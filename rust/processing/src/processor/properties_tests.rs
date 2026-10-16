// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `properties.rs`.
//!
//! `IfcRelDefinesByProperties.RelatingPropertyDefinition` is typed
//! `IfcPropertySetDefinitionSelect`, whose `IfcPropertySetDefinitionSet`
//! alternative is a defined `SET [1:?] OF IfcPropertySetDefinition` —
//! schema-legally written inline in STEP as `(#20,#22)` rather than a single
//! `#id`. `collect_rel_defines_by_properties_link` used to read that slot
//! with `get_ref`, which recognises only a bare reference and returns `None`
//! for the grouped form, so the `?` silently dropped the WHOLE relationship —
//! every related space/zone lost every property/quantity set in the group.
//! This is the same root cause as issue #4772 / PR #4773
//! (`apps/server/src/services/data_model/relationships.rs::extract_relationship`),
//! an independent second site in `rust/processing`.

use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};

/// Mirrors the repro shape from the issue: a single `IfcRelDefinesByProperties`
/// whose `RelatingPropertyDefinition` groups two property-set definitions.
fn grouped_rel_defines_content() -> &'static [u8] {
    b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
      #20=IFCPROPERTYSET('gid1',$,'Pset_A',$,(#30));\n\
      #22=IFCELEMENTQUANTITY('gid2',$,'Qto_B',$,$,(#31));\n\
      #40=IFCRELDEFINESBYPROPERTIES('gid3',$,$,$,(#50),(#20,#22));\n\
      ENDSEC;\nEND-ISO-10303-21;\n"
}

#[test]
fn collects_both_property_sets_from_a_grouped_relating_property_definition() {
    let content = grouped_rel_defines_content();
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);

    let rel_defines = decoder
        .decode_by_id(40)
        .expect("IFCRELDEFINESBYPROPERTIES #40 should decode");

    let link = collect_rel_defines_by_properties_link(&rel_defines)
        .expect("a grouped RelatingPropertyDefinition must not be silently dropped");

    assert_eq!(
        link.property_set_ids,
        vec![20, 22],
        "both entries of the grouped IfcPropertySetDefinitionSet must be collected, \
         not just the first (or none, if get_ref alone returned None for the list)"
    );
    assert_eq!(link.related_object_ids, vec![50]);
}

/// EXPORT-DATA-1 (#7681): ISO 10303-21 writes a defined type inside a SELECT
/// as a typed parameter, so the `IfcPropertySetDefinitionSet` alternative is
/// also spelled `IFCPROPERTYSETDEFINITIONSET((#20,#22))`. `get_refs` saw only
/// the bare-list spelling, so that one dropped the whole relationship here too.
#[test]
fn collects_both_property_sets_from_a_typed_property_set_definition_set() {
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #20=IFCPROPERTYSET('gid1',$,'Pset_A',$,(#30));\n\
        #22=IFCELEMENTQUANTITY('gid2',$,'Qto_B',$,$,(#31));\n\
        #40=IFCRELDEFINESBYPROPERTIES('gid3',$,$,$,(#50),IFCPROPERTYSETDEFINITIONSET((#20,#22)));\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let rel_defines = decoder.decode_by_id(40).expect("#40 decodes");
    let link = collect_rel_defines_by_properties_link(&rel_defines)
        .expect("a typed IfcPropertySetDefinitionSet must not drop the relationship");
    assert_eq!(link.property_set_ids, vec![20, 22]);
    assert_eq!(link.related_object_ids, vec![50]);
}

/// The ordinary, non-grouped shape must still work unchanged.
#[test]
fn collects_a_single_bare_relating_property_definition() {
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #20=IFCPROPERTYSET('gid1',$,'Pset_A',$,(#30));\n\
        #40=IFCRELDEFINESBYPROPERTIES('gid3',$,$,$,(#50),#20);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);

    let rel_defines = decoder
        .decode_by_id(40)
        .expect("IFCRELDEFINESBYPROPERTIES #40 should decode");

    let link = collect_rel_defines_by_properties_link(&rel_defines)
        .expect("a bare RelatingPropertyDefinition must still resolve");

    assert_eq!(link.property_set_ids, vec![20]);
    assert_eq!(link.related_object_ids, vec![50]);
}

#[test]
fn direct_assignment_applies_every_grouped_property_set() {
    let mut jobs = vec![EntityJob {
        id: 50,
        ifc_type: IfcType::IfcSpace,
        start: 0,
        end: 0,
        product_definition_shape_id: None,
        element_color: [0.0; 4],
        global_id: None,
        name: None,
        presentation_layer: None,
        space_zone_properties: None,
        representation_map_id: None,
    }];
    let property_values_by_id = FxHashMap::from_iter([
        (30, ("PropA".to_string(), "value-a".to_string())),
        (31, ("PropB".to_string(), "value-b".to_string())),
    ]);
    let property_sets_by_id = FxHashMap::from_iter([
        (
            20,
            PropertySetDefinition {
                name: Some("Pset_A".to_string()),
                property_ids: vec![30],
            },
        ),
        (
            22,
            PropertySetDefinition {
                name: Some("Pset_B".to_string()),
                property_ids: vec![31],
            },
        ),
    ]);
    let links = [RelDefinesByPropertiesLink {
        property_set_ids: vec![20, 22],
        related_object_ids: vec![50],
    }];

    assign_space_zone_properties(
        &mut jobs,
        &property_values_by_id,
        &property_sets_by_id,
        &links,
    );

    let properties = jobs[0]
        .space_zone_properties
        .as_ref()
        .expect("direct assignment should retain both grouped property sets");
    assert_eq!(
        properties.get("Pset_A.PropA").map(String::as_str),
        Some("value-a")
    );
    assert_eq!(
        properties.get("Pset_B.PropB").map(String::as_str),
        Some("value-b")
    );
}
