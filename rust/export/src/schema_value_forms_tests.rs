// SPDX-License-Identifier: MPL-2.0
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

/// The output, the values counted dropped, and the warnings.
fn convert(line: &str, from: &str, to: &str) -> (String, usize, Vec<String>) {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line(line, from, to, 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    (out, checks.attribute_values_dropped, checks.forms.warnings())
}

/// The issue's examples: a date reference in an IFC4 date string slot, a time
/// measure in a duration string slot, a real in an IfcLagTime reference slot,
/// and a date string in an IFC2X3 date reference slot.
#[test]
fn a_value_the_target_slot_cannot_hold_is_dropped_and_named_10847() {
    let (out, dropped, warnings) = convert("#5=IFCCLASSIFICATION('src','1',#9,'name');", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCCLASSIFICATION('src','1',$,'name',$,$,$);", 1));
    assert_eq!(warnings, ["1 value(s) of a type the target slot does not accept were written as $: IFCCLASSIFICATION.EditionDate (#10847)."]);
    let (out, dropped, _) = convert("#5=IFCWORKPLAN('g',$,'n',$,$,'id',#9,$,$,10.,2.,#10,$,.ACTUAL.);", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,$,$,$,$,.ACTUAL.);", 4));
    let (out, _, _) = convert("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,2.,.START_START.);", "IFC2X3", "IFC4");
    assert_eq!(out, "#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,$,.START_START.,$);");
    let (out, _, _) = convert("#5=IFCCLASSIFICATION('src','1','2020-01-01','name',$,$,$);", "IFC4", "IFC2X3");
    assert_eq!(out, "#5=IFCCLASSIFICATION('src','1',$,'name');");
}

/// A typed value IFC2X3 has no type for is dropped, and only that member of a list.
#[test]
fn a_typed_value_the_target_lacks_is_dropped_member_by_member_10847() {
    let (out, dropped, _) = convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCDATE('2020-01-01'),$);", "IFC4X3", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);", 1));
    let (out, dropped, _) = convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCDATE('2020-01-01')),$);", "IFC4X3", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a')),$);", 1));
    // A value the target accepts is left as written, comments and all.
    let kept = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCLABEL('a') /* c */,$);";
    assert_eq!(convert(kept, "IFC4X3", "IFC2X3").0, kept);
}

/// What converts without loss is converted: a parameter wrapped for IFC4X3's
/// select and unwrapped back, an integral count written as an integer.
#[test]
fn a_value_that_converts_without_loss_is_converted_10847() {
    let (out, dropped, _) = convert("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,1.,#6);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(1.),#6);", 0));
    let (out, dropped, _) = convert("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCLENGTHMEASURE(1.),#6);", "IFC4X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,$,#6);", 1));
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,3.,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,3,$);");
    let (out, dropped, _) = convert("#5=IFCQUANTITYCOUNT('n',$,$,2.5,$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCQUANTITYCOUNT('n',$,$,$,$);", 1));
}

/// Without the export's checks, nothing is reconciled, as for enum members.
#[test]
fn convert_step_line_without_checks_is_unchanged_10847() {
    let out = convert_step_line("#5=IFCCLASSIFICATION('src','1',#9,'name');", "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), None).unwrap();
    assert_eq!(out, "#5=IFCCLASSIFICATION('src','1',#9,'name',$,$,$);");
}

/// The lookup binary-searches the generated table, so it must be sorted by
/// the tuple, each type once (the generator once sorted by a joined string).
#[test]
fn the_table_is_sorted_for_the_lookup_10847() {
    let keys: Vec<_> = crate::generated::value_forms::VALUE_FORM_SLOTS.iter().map(|(f, t, ty, _)| (*f, *t, *ty)).collect();
    assert!(keys.len() > 50, "anti-vacuity: {}", keys.len());
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "not strictly sorted");
}
