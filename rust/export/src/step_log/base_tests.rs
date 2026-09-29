// SPDX-License-Identifier: MPL-2.0
use super::*;

/// #5475: a reference property's base value is the referenced object's Name,
/// else its Identification, else `#<id>`, read from slot 3
/// (`PropertyReference`), never slot 2 (`UsageName`). Top level and inside a
/// complex property alike, as `parsePropertyValueWithComplex` reads them.
#[test]
fn a_reference_property_reads_the_referenced_name() {
    let text = "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n\
#5=IFCMATERIAL('Oak',$,$);\n\
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25',$,$,$,$);\n\
#7=IFCCLASSIFICATIONREFERENCE($,$,$,$,$,$);\n\
#10=IFCWALL('0WallA0000000000000010A',$,'Wall',$,$,$,$,$,$);\n\
#11=IFCPROPERTYREFERENCEVALUE('Finish',$,'finish usage',#5);\n\
#12=IFCPROPERTYREFERENCEVALUE('Spec',$,$,#6);\n\
#13=IFCPROPERTYREFERENCEVALUE('Bare',$,$,#7);\n\
#14=IFCCOMPLEXPROPERTY('Layer',$,'usage',(#11));\n\
#15=IFCPROPERTYSET('0Pset00000000000000015A',$,'Pset_Ref',$,(#11,#12,#13,#14));\n\
#16=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000016A',$,$,$,(#10),#15);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let src = Source::index(text.as_bytes());
    let mut base = BaseSets::new(&src, &HashSet::from([10]));
    let sets = base.psets(10);
    let values: Vec<(String, Value)> = sets[0].properties.iter().map(|p| (p.name.clone(), p.value.clone())).collect();
    assert_eq!(
        values,
        vec![
            ("Finish".to_string(), Value::String("Oak".into())),
            ("Spec".to_string(), Value::String("Ss_25".into())),
            ("Bare".to_string(), Value::String("#7".into())),
            ("Layer".to_string(), Value::String("Finish: Oak".into())),
        ]
    );
}
