// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn row(id: u32, type_name: &str, name: Option<&str>) -> EntityMetadata {
    EntityMetadata {
        entity_id: id,
        type_name: type_name.to_owned(),
        global_id: None,
        name: name.map(str::to_owned),
        description: None,
        object_type: None,
        tag: None,
        predefined_type: None,
        // The data model's class guess, which `row_facts` must not echo.
        has_geometry: true,
    }
}

fn sorted(ids: &HashSet<u32>) -> Vec<u32> {
    let mut ids: Vec<u32> = ids.iter().copied().collect();
    ids.sort_unstable();
    ids
}

#[test]
fn issue_4930_only_a_quoted_empty_name_is_explicit() {
    let source = b"DATA;\n\
        #1=IFCWALL('a',$,'',$,$,$,$,$,$);\n\
        #2=IFCWALL('b',$,$,$,$,$,$,$,$);\n\
        #3=IFCMATERIAL('',$,$);\n\
        #4=IFCNOTACLASS('c',$,'');\n\
        #5=IFCCARTESIANPOINT((0.,0.,''));\n\
        ENDSEC;\n";
    let rows: Vec<EntityMetadata> =
        [(1, "IFCWALL"), (2, "IFCWALL"), (3, "IFCMATERIAL"), (4, "IFCNOTACLASS"), (5, "IFCCARTESIANPOINT")]
            .into_iter()
            .map(|(id, ty)| row(id, ty, None))
            .collect();
    // #1: `''` at IfcRoot's Name. #2: `$`. #3: IfcMaterial's Name is slot 0.
    // #4: a type IFC4 does not declare reads slot 2. #5 declares no Name.
    assert_eq!(sorted(&row_facts(source, &rows).empty_names), [1, 3, 4]);
}

#[test]
fn a_row_the_data_model_named_is_never_re_read() {
    let source = b"DATA;\n#1=IFCWALL('a',$,'',$);\nENDSEC;\n";
    assert!(row_facts(source, &[row(1, "IFCWALL", Some("W"))]).empty_names.is_empty());
}

#[test]
fn issue_4666_own_representation_reads_attribute_6_of_a_product_only() {
    let source = b"DATA;\n\
        #1=IFCWALL('a',$,$,$,$,#9,#8,$,$);\n\
        #2=IFCBUILDING('b',$,$,$,$,#9,$,$,.ELEMENT.,$,$,$);\n\
        #3=IFCSITE('c',$,$,$,$,#9,*,$,.ELEMENT.,$,$,$,$,$);\n\
        #4=IFCPROJECT('d',$,$,$,$,$,#7,$,$);\n\
        ENDSEC;\n";
    let rows: Vec<EntityMetadata> = [(1, "IFCWALL"), (2, "IFCBUILDING"), (3, "IFCSITE"), (4, "IFCPROJECT")]
        .into_iter()
        .map(|(id, ty)| row(id, ty, Some("n")))
        .collect();
    // #2 has no body although its class can carry one; IfcProject's attribute
    // 6 is not a Representation; a derived `*` is a value, as on the TS side.
    assert_eq!(sorted(&row_facts(source, &rows).own_representation), [1, 3]);
}
