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
    assert_eq!((count.kind, count.value), ("Count", 7.0));
    assert_eq!(count.unit.as_ref().unwrap().symbol, "m");
    assert_eq!(count.unit.as_ref().unwrap().source, "explicit");
    let number = authored.iter().find(|q| q.quantity_id == 17).unwrap();
    assert_eq!((number.kind, number.value), ("Number", 2.5));
    assert_eq!(number.unit.as_ref().unwrap().symbol, "m²");
    let bare = authored.iter().find(|q| q.quantity_id == 18).unwrap();
    assert_eq!(bare.kind, "Number");
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
