// SPDX-License-Identifier: MPL-2.0
//! #8019: schema-local inheritance coverage and converted record invariants.
use ifc_lite_core::{attribute_names_for_schema, entity_info_for_schema, is_subtype_of_for_schema};
use crate::schema_convert::{convert_entity_type, convert_step_line};
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use crate::step_slot::split_top_level_args;

const COMMON: &str = "'2fv4DZfY55exwX8QDy8dmw',#209,'Duct, supply','Description','Authored object type',#326,#327,'Tag-1'";

#[test]
fn all_missing_mep_occurrences_preserve_product_slots_8019() {
    for (schema, expected_count) in [("IFC4", 65), ("IFC4X3", 71)] {
        let mut count = 0;
        for ty in ifc_lite_core::generated::IFC_TYPES {
            let name = ty.as_str();
            if !is_subtype_of_for_schema(schema, name, "IFCDISTRIBUTIONELEMENT")
                || entity_info_for_schema("IFC2X3", name).is_some() { continue; }
            count += 1;
            let mut ancestor = entity_info_for_schema(schema, name).unwrap().parent.unwrap();
            while entity_info_for_schema("IFC2X3", ancestor).is_none() {
                ancestor = entity_info_for_schema(schema, ancestor).unwrap().parent.unwrap();
            }
            let board = matches!(name, "IFCELECTRICDISTRIBUTIONBOARD" | "IFCDISTRIBUTIONBOARD");
            let target = if board { "IFCELECTRICDISTRIBUTIONPOINT" } else { ancestor };
            assert!(!entity_info_for_schema("IFC2X3", target).unwrap().is_abstract);
            assert_eq!(convert_entity_type(name, schema, "IFC2X3"), target, "{schema} {name}");
            let src_names = attribute_names_for_schema(schema, name).unwrap();
            assert_eq!(&src_names[8..], &["PredefinedType"], "{name}");
            let line = format!("#10={name}({COMMON},.NOTDEFINED.);");
            let out = convert_step_line(&line, schema, "IFC2X3", 10, &mut Ifc2x3SlotFill::new(None), None).unwrap();
            let attrs = out.strip_prefix(&format!("#10={target}(")).unwrap().strip_suffix(");").unwrap();
            let values = split_top_level_args(attrs).unwrap();
            assert_eq!(values.len(), attribute_names_for_schema("IFC2X3", target).unwrap().len(), "{name}");
            assert_eq!(values[..8], split_top_level_args(COMMON).unwrap(), "{name}");
            let tail: &[&str] = if board { &[".NOTDEFINED.", "$"] }
                else if target == "IFCDISTRIBUTIONCONTROLELEMENT" { &["$"] } else { &[] };
            assert_eq!(&values[8..], tail, "{name}");
        }
        assert_eq!(count, expected_count, "{schema} coverage must not be vacuous");
    }
}

#[test]
fn duct_type_and_relationship_endpoints_survive_8019() {
    let duct = format!("#10=IFCDUCTSEGMENT({COMMON},.RIGIDSEGMENT.);");
    let mut slots = Ifc2x3SlotFill::new(None);
    let out = convert_step_line(&duct, "IFC4", "IFC2X3", 10, &mut slots, None).unwrap();
    assert_eq!(out, format!("#10=IFCFLOWSEGMENT({COMMON});"));
    // The occurrence discriminator is lost; the authored type still expresses it.
    for (id, line) in [
        (20, "#20=IFCDUCTSEGMENTTYPE('2WSwGyLsrFNA9TLOq_ifyd',#209,'Rigid duct',$,$,(#30),(#31),'T-1','Duct',.RIGIDSEGMENT.);"),
        (40, "#40=IFCRELDEFINESBYTYPE('2WSwGyLsrFNA9TLOq_ifye',#209,$,$,(#10),#20);"),
        (41, "#41=IFCRELCONTAINEDINSPATIALSTRUCTURE('2WSwGyLsrFNA9TLOq_ifyf',#209,$,$,(#10),#50);"),
        (42, "#42=IFCRELCONNECTSPORTTOELEMENT('2WSwGyLsrFNA9TLOq_ifyg',#209,$,$,#60,#10);"),
    ] {
        assert_eq!(convert_step_line(line, "IFC4", "IFC2X3", id, &mut slots, None).unwrap(), line);
    }
    for name in ["IFCDUCTSEGMENTTYPE", "IFCFLOWSEGMENT", "IFCDISTRIBUTIONCONTROLELEMENT", "IFCUNRECOGNIZED"] {
        assert_eq!(convert_entity_type(name, "IFC4", "IFC2X3"), name);
    }
}
