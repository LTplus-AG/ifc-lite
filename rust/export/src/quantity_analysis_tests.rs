// SPDX-License-Identifier: MPL-2.0
use super::*;

const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#3=IFCUNITASSIGNMENT((#1,#2));
#4=IFCPROJECT('0PROJECT',$,'P',$,$,$,$,$,#3);
#5=IFCWALL('0WALL',$,'W',$,$,$,$,$,$);
#6=IFCWALL('0WALL2',$,'W2',$,$,$,$,$,$);
#10=IFCQUANTITYLENGTH('NetLength',$,#30,3.,$);
#11=IFCQUANTITYAREA('NetArea',$,$,8.,$);
#12=IFCQUANTITYCOUNT('Count',$,$,2.,$);
#13=IFCQUANTITYLENGTH('BadUnit',$,#31,5.,$);
#14=IFCELEMENTQUANTITY('0QTO',$,'Qto_WallBaseQuantities',$,$,(#10,#11,#12,#13));
#15=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#5),#14);
#20=IFCQUANTITYLENGTH('NetLength',$,$,4000.,$);
#21=IFCELEMENTQUANTITY('0TQTO',$,'Qto_WallBaseQuantities',$,$,(#20));
#22=IFCWALLTYPE('0WTYPE',$,'WT',$,$,(#21),$,$,$,.NOTDEFINED.);
#23=IFCRELDEFINESBYTYPE('0TREL',$,$,$,(#5),#22);
#30=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#31=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
ENDSEC;
END-ISO-10303-21;"#;

#[test]
fn issue_5787_authored_quantities_keep_source_units_and_conflicts() {
    let result = analyze_authored_quantities(IFC.as_bytes(), None);
    assert_eq!(result.product_count, 2);
    let wall = &result.products[&5];
    assert_eq!(wall.authored.len(), 5);
    let explicit = &wall.authored[0];
    assert_eq!((explicit.set_id, explicit.quantity_id, explicit.origin), (14, 10, "occurrence"));
    assert_eq!(explicit.kind, "IfcQuantityLength");
    assert_eq!((explicit.set_name.as_str(), explicit.quantity_name.as_str()),
        ("Qto_WallBaseQuantities", "NetLength"));
    assert_eq!(explicit.unit.as_ref().unwrap().symbol, "m");
    assert_eq!(explicit.unit.as_ref().unwrap().unit_id, Some(30));
    assert_eq!(wall.authored[1].unit.as_ref().unwrap().symbol, "m²");
    assert_eq!(wall.authored[2].unit.as_ref().unwrap().symbol, "1");
    assert!(wall.authored[3].unit.is_none());
    assert!(wall.authored[3].unit_diagnostic.as_deref().unwrap().contains("mismatched"));
    let inherited = &wall.authored[4];
    assert_eq!((inherited.quantity_id, inherited.origin, inherited.type_id), (20, "type", Some(22)));
    assert_eq!(inherited.unit.as_ref().unwrap().symbol, "mm");
    assert_eq!(wall.conflicts.len(), 1);
    assert_eq!(wall.conflicts[0].occurrence_quantity_ids, vec![10]);
    assert_eq!(wall.conflicts[0].type_quantity_ids, vec![20]);
    assert!(result.products[&6].authored.is_empty());
    assert!(result.products[&6].conflicts.is_empty());
}

#[test]
fn issue_5787_empty_filter_and_bounded_relationship() {
    let empty = analyze_authored_quantities(IFC.as_bytes(), Some(&HashSet::new()));
    assert_eq!(empty.product_count, 0);
    assert!(empty.products.is_empty());

    let members = std::iter::repeat_n("#5", MAX_REL_MEMBERS + 1)
        .collect::<Vec<_>>().join(",");
    let oversized = IFC.replace("(#5),#14", &format!("({members}),#14"));
    let result = analyze_authored_quantities(oversized.as_bytes(), Some(&HashSet::from([5])));
    assert!(result.products[&5].authored.iter().all(|q| q.origin == "type"));
    assert!(result.diagnostics.iter().any(|message| message.contains("exceeds work budget")));

    let duplicate = IFC.replace("(#5),#14", "(#5,#5),#14");
    let result = analyze_authored_quantities(duplicate.as_bytes(), Some(&HashSet::from([5])));
    assert_eq!(result.products[&5].authored.len(), 5,
        "one IFC quantity set linked twice to a product is one authored source");
}

#[test]
fn issue_5787_oversized_quantity_leaf_is_reported_before_decode() {
    let oversized = IFC.replace(
        "#10=IFCQUANTITYLENGTH('NetLength',$,#30,3.,$);",
        &format!("#10=IFCQUANTITYLENGTH('NetLength','{}',#30,3.,$);",
            "x".repeat(MAX_REF_RECORD_BYTES)),
    );
    let result = analyze_authored_quantities(oversized.as_bytes(), Some(&HashSet::from([5])));
    assert!(result.products[&5].authored.iter().all(|quantity| quantity.origin == "type"));
    assert!(result.diagnostics.iter().any(|message|
        message.contains("quantity set #14") && message.contains("record exceeds work budget")));
    let refused = analyze_with_limits(oversized.as_bytes(), Some(&HashSet::from([5])),
        AnalysisLimits { leaves: 0, ..Default::default() });
    assert!(refused.diagnostics.iter().any(|message|
        message.contains("quantity leaf visits exceed work budget")));
    assert!(refused.diagnostics.iter().all(|message|
        !message.contains("record exceeds work budget")),
        "leaf inspection must stop when its aggregate budget is exhausted");
}

#[test]
fn issue_5787_archicad_authored_quantity_is_an_independent_ifc_value() {
    // AC20-FZK-Haus.ifc is an Archicad 20 export. The STEP text itself has
    // #14963=IFCQUANTITYLENGTH('Höhe',$,$,2.,$) in set #14971, attached
    // to product #14502 by relationship #14973. The 2.0 is authored input,
    // not an estimate inferred from ifc-lite geometry.
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let selected = HashSet::from([14502]);
    let result = analyze_authored_quantities(&bytes, Some(&selected));
    assert_eq!(result.product_count, 1);
    let observed = result.products[&14502].authored.iter()
        .find(|quantity| quantity.quantity_id == 14963).expect("Archicad quantity #14963");
    assert_eq!(observed.set_id, 14971);
    assert_eq!(observed.set_name, "AC_Equantity_Treppe_FZK-Haus");
    assert_eq!(observed.quantity_name, "Höhe");
    assert_eq!(observed.value, 2.0);
    assert_eq!(observed.origin, "occurrence");
}

#[test]
fn issue_5787_ifc4x3_number_and_explicit_count_units_are_not_dropped() {
    let ifc = IFC.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3_ADD2'))")
        .replace("#14=IFCELEMENTQUANTITY", concat!(
            "#16=IFCQUANTITYCOUNT('ExplicitCount',$,#30,7,$);\n",
            "#17=IFCQUANTITYNUMBER('FractionalNumber',$,#31,2.5,$);\n",
            "#18=IFCQUANTITYNUMBER('BareNumber',$,$,1.25,$);\n",
            "#14=IFCELEMENTQUANTITY"
        ))
        .replace("(#10,#11,#12,#13)", "(#10,#11,#12,#13,#16,#17,#18)");
    let result = analyze_authored_quantities(ifc.as_bytes(), Some(&HashSet::from([5])));
    let authored = &result.products[&5].authored;
    let count = authored.iter().find(|q| q.quantity_id == 16).unwrap();
    assert_eq!((count.kind, count.value), ("IfcQuantityCount", 7.0));
    assert_eq!(count.unit.as_ref().unwrap().symbol, "m");
    assert_eq!(count.unit.as_ref().unwrap().source, "explicit");
    let number = authored.iter().find(|q| q.quantity_id == 17).unwrap();
    assert_eq!((number.kind, number.value), ("IfcQuantityNumber", 2.5));
    assert_eq!(number.unit.as_ref().unwrap().symbol, "m²");
    let bare = authored.iter().find(|q| q.quantity_id == 18).unwrap();
    assert_eq!(bare.kind, "IfcQuantityNumber");
    assert_eq!(bare.unit.as_ref().unwrap().source, "dimensionless");
    assert_eq!(bare.unit_diagnostic, None);
}

#[test]
fn issue_5787_equal_metres_and_millimetres_are_not_authored_conflicts() {
    let equal = IFC.replace("'NetLength',$,$,4000.", "'NetLength',$,$,3000.");
    let result = analyze_authored_quantities(equal.as_bytes(), Some(&HashSet::from([5])));
    let product = &result.products[&5];
    assert_eq!(product.authored.len(), 5);
    assert_eq!(product.authored[0].value, 3.0);
    assert_eq!(product.authored[4].value, 3000.0);
    assert!(product.conflicts.is_empty(), "equal SI lengths must not conflict");

    let unequal = equal.replace("'NetLength',$,$,3000.", "'NetLength',$,$,3000.01");
    let result = analyze_authored_quantities(unequal.as_bytes(), Some(&HashSet::from([5])));
    assert_eq!(result.products[&5].conflicts.len(), 1);
}

#[test]
fn issue_5787_equal_numeric_count_with_incompatible_explicit_units_conflicts() {
    let with_count = IFC.replace("#21=IFCELEMENTQUANTITY", concat!(
        "#40=IFCQUANTITYCOUNT('Count',$,#30,2,$);\n",
        "#41=IFCQUANTITYCOUNT('Count',$,#31,2,$);\n",
        "#21=IFCELEMENTQUANTITY"
    )).replace("(#20));", "(#20,#41));")
      .replace("(#10,#11,#12,#13));", "(#10,#11,#40,#13));");
    let result = analyze_authored_quantities(with_count.as_bytes(), Some(&HashSet::from([5])));
    let conflict = result.products[&5].conflicts.iter()
        .find(|conflict| conflict.quantity_name == "Count").expect("m versus m² cannot be equal");
    assert_eq!(conflict.occurrence_quantity_ids, vec![40]);
    assert_eq!(conflict.type_quantity_ids, vec![41]);
}

#[test]
fn issue_5787_count_same_display_name_cannot_hide_different_unit_dimensions() {
    let ifc = IFC.replace("#21=IFCELEMENTQUANTITY", concat!(
        "#40=IFCQUANTITYCOUNT('Count',$,#74,2,$);\n",
        "#41=IFCQUANTITYCOUNT('Count',$,#75,2,$);\n",
        "#70=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n",
        "#71=IFCDIMENSIONALEXPONENTS(2,0,0,0,0,0,0);\n",
        "#72=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#30);\n",
        "#73=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#31);\n",
        "#74=IFCCONVERSIONBASEDUNIT(#70,.LENGTHUNIT.,'same',#72);\n",
        "#75=IFCCONVERSIONBASEDUNIT(#71,.AREAUNIT.,'same',#73);\n",
        "#76=IFCCONVERSIONBASEDUNIT(#70,.LENGTHUNIT.,'same',#72);\n",
        "#21=IFCELEMENTQUANTITY"
    )).replace("(#20));", "(#20,#41));")
      .replace("(#10,#11,#12,#13));", "(#10,#11,#40,#13));");
    let result = analyze_authored_quantities(ifc.as_bytes(), Some(&HashSet::from([5])));
    let product = &result.products[&5];
    let count: Vec<_> = product.authored.iter().filter(|q| q.quantity_name == "Count").collect();
    assert_eq!(count.len(), 2);
    assert_eq!(count[0].unit.as_ref().unwrap().symbol, "same");
    assert_eq!(count[1].unit.as_ref().unwrap().symbol, "same");
    assert_eq!(count[0].unit.as_ref().unwrap().UnitType.as_deref(), Some("LENGTHUNIT"));
    assert_eq!(count[1].unit.as_ref().unwrap().UnitType.as_deref(), Some("AREAUNIT"));
    assert!(product.conflicts.iter().any(|conflict| conflict.quantity_name == "Count"));
    let shared_unit = ifc.replace("'Count',$,#75,2", "'Count',$,#74,2");
    let shared = analyze_authored_quantities(shared_unit.as_bytes(), Some(&HashSet::from([5])));
    assert!(shared.products[&5].conflicts.iter().all(|conflict| conflict.quantity_name != "Count"));
    let distinct_same_type = ifc.replace("'Count',$,#75,2", "'Count',$,#76,2");
    let distinct = analyze_authored_quantities(distinct_same_type.as_bytes(), Some(&HashSet::from([5])));
    assert!(distinct.products[&5].conflicts.iter().any(|conflict| conflict.quantity_name == "Count"),
        "matching names and UnitType do not certify distinct unit entities' dimensions");
}

#[test]
fn issue_5787_repeated_unsupported_leaves_consume_aggregate_visit_budget() {
    let ifc = IFC.replace("(#5),#14", "(#5,#6),#14")
        .replace("#14=IFCELEMENTQUANTITY", concat!(
            "#40=IFCPROPERTYSINGLEVALUE('Other',$,IFCLABEL('A'),$);\n",
            "#14=IFCELEMENTQUANTITY"
        ))
        .replace("(#10,#11,#12,#13));", "(#40,#40,#40));");
    let result = analyze_with_limits(ifc.as_bytes(), None, AnalysisLimits { leaves: 3, ..Default::default() });
    assert!(result.products.values().all(|product| product.authored.is_empty()));
    assert_eq!(result.diagnostics.iter().filter(|message|
        message.contains("quantity leaf visits exceed work budget")).count(), 1);
}

#[test]
fn issue_5787_shared_set_decode_bytes_have_an_aggregate_budget() {
    let index = ifc_lite_processing::build_entity_index_parallel(IFC.as_bytes());
    let (start, end) = index[&14];
    let result = analyze_with_limits(IFC.as_bytes(), Some(&HashSet::from([5])),
        AnalysisLimits { set_bytes: end - start, ..Default::default() });
    assert!(result.products[&5].authored.iter().any(|q| q.origin == "occurrence"));
    assert!(result.products[&5].authored.iter().all(|q| q.origin != "type"));
    assert!(result.diagnostics.iter().any(|message|
        message.contains("quantity set decode bytes exceed work budget")));
}

#[test]
fn issue_5787_repeated_leaf_clones_charge_record_bytes_each_time() {
    let ifc = IFC.replace("(#10,#11,#12,#13));", "(#10,#10,#10));");
    let index = ifc_lite_processing::build_entity_index_parallel(ifc.as_bytes());
    let (start, end) = index[&10];
    let result = analyze_with_limits(ifc.as_bytes(), Some(&HashSet::from([5])),
        AnalysisLimits { leaf_bytes: (end - start) * 2, ..Default::default() });
    assert!(result.products[&5].authored.iter().all(|q| q.origin != "occurrence"));
    assert!(result.diagnostics.iter().any(|message|
        message.contains("quantity leaf decode bytes exceed work budget")));
}

#[test]
fn issue_5787_type_links_share_aggregate_relationship_budget() {
    let ifc = IFC.replace("(#5),#22", "(#5,#6),#22");
    let result = analyze_with_limits(ifc.as_bytes(), None, AnalysisLimits { links: 2, ..Default::default() });
    assert!(result.products[&5].authored.iter().any(|q| q.origin == "type"));
    assert!(result.products[&6].authored.is_empty());
    assert!(result.diagnostics.iter().any(|message|
        message.contains("expanded quantity links exceed work budget")));
}

#[test]
fn issue_5787_malformed_relationship_diagnostics_have_a_fixed_output_bound() {
    let malformed = (1000..2100).map(|id| format!(
        "#{id}=IFCRELDEFINESBYPROPERTIES('BAD',$,$,$,(#5),$);\n"))
        .collect::<String>();
    let ifc = IFC.replace("ENDSEC;\nEND-ISO-10303-21;",
        &format!("{malformed}ENDSEC;\nEND-ISO-10303-21;"));
    let result = analyze_authored_quantities(ifc.as_bytes(), Some(&HashSet::from([5])));
    assert_eq!(result.diagnostics.len(), 1_025);
    assert_eq!(result.diagnostics.last().unwrap(),
        "authored quantity diagnostics exceed work budget");
    assert!(result.products[&5].authored.iter().any(|q| q.quantity_id == 10),
        "valid observations preceding malformed records must remain available");

    let no_early_links = IFC.replace(
        "#15=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#5),#14);\n", "")
        .replace("#23=IFCRELDEFINESBYTYPE('0TREL',$,$,$,(#5),#22);\n", "");
    let late = no_early_links.replace("ENDSEC;\nEND-ISO-10303-21;", &format!(
        "{malformed}#9999=IFCRELDEFINESBYPROPERTIES('LATE',$,$,$,(#5,#6),#14);\nENDSEC;\nEND-ISO-10303-21;"));
    let limited = analyze_with_limits(late.as_bytes(), None, AnalysisLimits { links: 1, ..Default::default() });
    assert!(limited.diagnostics.iter().any(|message|
        message == "authored quantity diagnostics exceed work budget"));
    assert!(limited.diagnostics.iter().any(|message|
        message == "expanded quantity links exceed work budget"),
        "a work-budget refusal must remain visible after record diagnostics saturate");
}

#[test]
fn issue_5787_property_definition_set_keeps_both_quantities() {
    let extra = concat!(
        "#40=IFCQUANTITYAREA('GrossArea',$,$,12.,$);\n",
        "#41=IFCELEMENTQUANTITY('Q2',$,'Qto_Second',$,$,(#40));\n",
        "#42=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('A'),$);\n",
        "#43=IFCPROPERTYSET('P1',$,'Pset_Example',$,(#42));\n",
    );
    for definition in ["(#14,#41,#43)", "IFCPROPERTYSETDEFINITIONSET((#14,#41,#43))"] {
        let ifc = IFC.replace("#15=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#5),#14);",
            &format!("{extra}#15=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#5),{definition});"));
        let result = analyze_authored_quantities(ifc.as_bytes(), Some(&HashSet::from([5])));
        let authored = &result.products[&5].authored;
        assert_eq!(authored.iter().map(|q| q.quantity_id).collect::<Vec<_>>(),
            vec![10, 11, 12, 13, 40, 20], "{definition}");
        assert_eq!(authored[4].set_name, "Qto_Second");
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }

    let malformed = IFC.replace("(#5),#14", "(#5),IFCPROPERTYSETDEFINITIONSET((#14,$))");
    let result = analyze_authored_quantities(malformed.as_bytes(), Some(&HashSet::from([5])));
    assert!(result.products[&5].authored.iter().all(|q| q.origin == "type"));
    assert!(result.diagnostics.iter().any(|message| message.contains("malformed RelatingPropertyDefinition")));

    let too_many = std::iter::repeat_n("#14", MAX_REL_MEMBERS + 1)
        .collect::<Vec<_>>().join(",");
    let oversized = IFC.replace("(#5),#14", &format!("(#5),({too_many})"));
    let result = analyze_authored_quantities(oversized.as_bytes(), Some(&HashSet::from([5])));
    assert!(result.products[&5].authored.iter().all(|q| q.origin == "type"));
    assert!(result.diagnostics.iter().any(|message| message.contains("RelatingPropertyDefinition exceeds work budget")));
}

#[test]
fn issue_5787_shared_sets_stop_at_aggregate_row_budget() {
    let ifc = IFC.replace("(#5),#14", "(#5,#6),(#14,#41)")
        .replace("#30=IFCSIUNIT", concat!(
            "#40=IFCQUANTITYAREA('SecondArea',$,$,2.,$);\n",
            "#41=IFCELEMENTQUANTITY('Q2',$,'Qto_Second',$,$,(#40));\n",
            "#30=IFCSIUNIT"
        ));
    let result = analyze_with_budgets(ifc.as_bytes(), None, 3, MAX_SET_VISITS, MAX_CONFLICT_COMPARISONS);
    assert_eq!(result.product_count, 2);
    assert_eq!(result.products.values().map(|p| p.authored.len()).sum::<usize>(), 3);
    assert_eq!(result.products[&5].authored.iter().map(|q| q.quantity_id).collect::<Vec<_>>(),
        vec![10, 11, 12]);
    assert!(result.products[&6].authored.is_empty());
    assert_eq!(result.diagnostics.iter().filter(|message|
        message.contains("authored quantity rows exceed work budget")).count(), 1);

    let exact = analyze_with_budgets(IFC.as_bytes(), Some(&HashSet::from([5])), 5, MAX_SET_VISITS,
        MAX_CONFLICT_COMPARISONS);
    assert_eq!(exact.products[&5].authored.len(), 5);
    assert!(exact.diagnostics.iter().all(|message| !message.contains("work budget")));
}

#[test]
fn issue_5787_conflict_budget_preserves_nontransitive_pairwise_tolerance() {
    let ifc = IFC.replace("'NetLength',$,#30,3.", "'NetLength',$,#30,0.")
        .replace("'NetLength',$,$,4000.", "'NetLength',$,#30,0.00000000000075")
        .replace("(#10,#11,#12,#13)", "(#10,#52,#11,#12,#13)")
        .replace("(#20));", "(#20,#53));")
        .replace("#30=IFCSIUNIT", concat!(
            "#52=IFCQUANTITYLENGTH('NetLength',$,#30,0.0000000000015,$);\n",
            "#53=IFCQUANTITYLENGTH('NetLength',$,#30,0.,$);\n",
            "#30=IFCSIUNIT"
        ));
    let selected = HashSet::from([5]);
    let full = analyze_authored_quantities(ifc.as_bytes(), Some(&selected));
    assert_eq!(full.products[&5].conflicts.len(), 1,
        "the fourth cross-origin pair disagrees although the first three agree");
    assert_eq!(full.products[&5].conflicts[0].occurrence_quantity_ids, vec![10, 52]);
    assert_eq!(full.products[&5].conflicts[0].type_quantity_ids, vec![20, 53]);

    let bounded = analyze_with_budgets(ifc.as_bytes(), Some(&selected), MAX_AUTHORED_ROWS, MAX_SET_VISITS, 3);
    assert!(bounded.products[&5].conflicts.is_empty());
    assert!(bounded.diagnostics.iter().any(|message| message.contains("conflict comparisons exceed work budget")));
}

#[test]
fn issue_5787_reused_non_quantity_type_sets_have_aggregate_visit_budget() {
    let ifc = IFC.replace("#15=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#5),#14);", "")
        .replace("(#21),$,$,$,.NOTDEFINED.", "(#60,#61,#62),$,$,$,.NOTDEFINED.")
        .replace("(#5),#22", "(#5,#6),#22")
        .replace("#30=IFCSIUNIT", concat!(
            "#42=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('A'),$);\n",
            "#60=IFCPROPERTYSET('P0',$,'Pset_Zero',$,(#42));\n",
            "#61=IFCPROPERTYSET('P1',$,'Pset_One',$,(#42));\n",
            "#62=IFCPROPERTYSET('P2',$,'Pset_Two',$,(#42));\n",
            "#30=IFCSIUNIT"
        ));
    let result = analyze_with_budgets(ifc.as_bytes(), None, MAX_AUTHORED_ROWS, 3,
        MAX_CONFLICT_COMPARISONS);
    assert_eq!(result.product_count, 2);
    assert!(result.products.values().all(|product| product.authored.is_empty()));
    assert_eq!(result.diagnostics.iter().filter(|message|
        message.contains("set visits exceed work budget")).count(), 1);
    assert!(result.diagnostics.iter().all(|message| !message.contains("rows exceed work budget")));

    let exact = analyze_with_budgets(ifc.as_bytes(), Some(&HashSet::from([5])),
        MAX_AUTHORED_ROWS, 3, MAX_CONFLICT_COMPARISONS);
    assert!(exact.diagnostics.is_empty());
}
