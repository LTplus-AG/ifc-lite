// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C6-7 (#7783): one property-set decoder under both encoders.

use super::*;
use crate::data_model::{extract_data_model, tests::expand_budget_lines, DataModel};
use ifc_lite_core::{build_entity_index, EntityDecoder};
use std::sync::Arc;

fn file(data: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}\nENDSEC;\nEND-ISO-10303-21;\n")
}

/// One set holding every property kind, in the order of `Pset_AllKinds` in
/// the C6-0 synthetic export file.
const ALL_KINDS: &str = "\
#30=IFCPROPERTYSINGLEVALUE('Target',$,IFCLABEL('referenced'),$);\n\
#400=IFCPROPERTYSET('0PSET00000000000000400',$,'Pset_AllKinds',$,(#500,#501,#502,#503,#504,#505,#506,#507,#508,#509));\n\
#500=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('Fire proof'),$);\n\
#501=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);\n\
#502=IFCPROPERTYSINGLEVALUE('Unknown',$,IFCLOGICAL(.U.),$);\n\
#503=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCPOSITIVELENGTHMEASURE(0.2),$);\n\
#504=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW'),IFCLABEL('EXISTING')),$);\n\
#505=IFCPROPERTYBOUNDEDVALUE('Range',$,IFCLENGTHMEASURE(5.),IFCLENGTHMEASURE(1.),$,IFCLENGTHMEASURE(2.));\n\
#506=IFCPROPERTYLISTVALUE('Sizes',$,(IFCINTEGER(1),IFCINTEGER(2),IFCINTEGER(3)),$);\n\
#507=IFCPROPERTYTABLEVALUE('Curve',$,(IFCREAL(0.),IFCREAL(1.)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,.CONTINUOUS.);\n\
#508=IFCPROPERTYREFERENCEVALUE('Ref',$,'Usage',#30);\n\
#509=IFCCOMPLEXPROPERTY('Complex',$,'Usage',(#516,#517));\n\
#516=IFCPROPERTYSINGLEVALUE('Inner1',$,IFCLABEL('a'),$);\n\
#517=IFCPROPERTYSINGLEVALUE('Inner2',$,IFCREAL(2.5),$);";

fn decode_all(ifc: &str, scope: PropertyScope) -> (PropertyDecoder, Vec<PropertySetRow>) {
    let bytes = ifc.as_bytes();
    let index = Arc::new(build_entity_index(bytes));
    let mut decoder = EntityDecoder::with_arc_index(bytes, index.clone());
    let mut props = PropertyDecoder::for_input(bytes.len(), scope);
    let mut scanner = ifc_lite_core::EntityScanner::new(bytes);
    let mut sets = Vec::new();
    while let Some((id, ty, start, _)) = scanner.next_entity() {
        // A set is read once, at its last record (keep-last, #7682).
        if !ty.eq_ignore_ascii_case("IFCPROPERTYSET") || index.get(&id).is_none_or(|&(at, _)| at != start) {
            continue;
        }
        let def = decoder.decode_by_id(id).unwrap();
        sets.extend(props.decode_set(&mut decoder, &def));
    }
    (props, sets)
}

type Shown = (String, String, String, Option<String>, bool, Option<Vec<String>>);

fn shown(p: &Property) -> Shown {
    (
        p.property_name.clone(),
        p.property_value.clone(),
        p.property_type.clone(),
        p.data_type.clone(),
        p.data_type_mixed,
        p.values.clone(),
    )
}

fn server_sets(dm: &DataModel) -> Vec<(u32, Vec<Shown>)> {
    dm.property_sets.iter().map(|s| (s.pset_id, s.properties.iter().map(shown).collect())).collect()
}

#[test]
fn every_property_class_has_a_kind_and_a_keyword() {
    let ifc = file(ALL_KINDS);
    let bytes = ifc.as_bytes();
    let mut decoder = EntityDecoder::with_arc_index(bytes, Arc::new(build_entity_index(bytes)));
    let kinds: Vec<_> = (500..=509u32)
        .map(|id| PropertyKind::of(&decoder.decode_by_id(id).unwrap().ifc_type).expect("a property class"))
        .collect();
    use PropertyKind::*;
    assert_eq!(kinds[..4], [Single; 4]);
    assert_eq!(kinds[4..], [Enumerated, Bounded, List, Table, Reference, Complex]);
    for kind in kinds {
        let keyword = kind.class_keyword();
        assert_eq!(PropertyKind::of(&ifc_lite_core::ifc_type_from_keyword(keyword)), Some(kind), "{keyword}");
    }
    assert_eq!(PropertyKind::of(&decoder.decode_by_id(400).unwrap().ifc_type), None);
}

/// The invariant that makes this one decoder: under `AllKinds` the display
/// form of every property is exactly what the server's table holds.
#[test]
fn all_kinds_display_is_the_servers_table_row() {
    let ifc = file(ALL_KINDS);
    let (_, sets) = decode_all(&ifc, PropertyScope::AllKinds);
    let decoded: Vec<_> = sets
        .iter()
        .map(|s| (s.id, s.properties.iter().map(|p| shown(p.display.as_ref().unwrap())).collect::<Vec<_>>()))
        .collect();
    let server = server_sets(&extract_data_model(&ifc));
    assert_eq!(decoded, server);
    // Anti-vacuity: all ten properties arrived, the complex one resolved.
    assert_eq!(decoded[0].1.len(), 10);
    assert_eq!(decoded[0].1[9].1, "Inner1: a, Inner2: 2.5");
}

/// Out-of-scope kinds are neither decoded nor charged; a single value keeps
/// its raw nominal value and no display form.
#[test]
fn single_value_only_skips_the_other_kinds() {
    let (props, sets) = decode_all(&file(ALL_KINDS), PropertyScope::SingleValueOnly);
    let set = &sets[0];
    assert_eq!(set.name.as_deref(), Some("Pset_AllKinds"));
    let names: Vec<_> = set.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Text", "Flag", "Unknown", "Thickness"]);
    assert!(set.properties.iter().all(|p| p.kind == PropertyKind::Single && p.display.is_none()));
    assert!(set.properties.iter().all(|p| p.nominal.is_some()));
    assert_eq!(props.cuts(), 0);
}

/// A wide complex property is cut by the model's budget on this path too,
/// and `SingleValueOnly` never walks it (the k^8 class of #7675).
#[test]
fn the_complex_budget_binds_the_decoder() {
    let members = vec!["#20"; 1100].join(",");
    let ifc = file(&format!(
        "#20=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);\n\
         #22=IFCCOMPLEXPROPERTY('Wide',$,'WideUsage',({members}));\n\
         #30=IFCPROPERTYSET('Pset0000000000000007675',$,'Pset_Cut',$,(#22));"
    ));
    let (_, sets) = decode_all(&ifc, PropertyScope::AllKinds);
    let wide = sets[0].properties[0].display.as_ref().unwrap();
    assert!(wide.property_value.ends_with(ifc_lite_core::limits::COMPLEX_PROPERTY_BUDGET_MARKER));
    assert_eq!(wide.values.as_ref().unwrap().len(), 1025);
    let (props, sets) = decode_all(&ifc, PropertyScope::SingleValueOnly);
    assert!(sets[0].properties.is_empty());
    assert_eq!(props.cuts(), 0);
}

/// The shared #7675 vector, through this decoder: every case's sets, decoded
/// in file order under one budget, equal the server's, which the vector pins.
#[test]
fn the_shared_budget_vector_reads_the_same_through_the_decoder() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/parser/test/fixtures/complex-property-budget-7675.json"
    ))
    .expect("vector parses");
    for case in vector["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let ifc = file(&expand_budget_lines(&case["dataLines"]).join("\n"));
        let (_, sets) = decode_all(&ifc, PropertyScope::AllKinds);
        let decoded: Vec<_> = sets
            .iter()
            .filter(|s| s.name.is_some() || !s.properties.is_empty())
            .map(|s| (s.id, s.properties.iter().map(|p| shown(p.display.as_ref().unwrap())).collect::<Vec<_>>()))
            .collect();
        assert_eq!(decoded, server_sets(&extract_data_model(&ifc)), "{name}");
    }
}
