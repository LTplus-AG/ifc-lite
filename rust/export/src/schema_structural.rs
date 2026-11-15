// SPDX-License-Identifier: MPL-2.0
//! Structural value conversion (#9668). EXPRESS IFC2X3_TC1 / IFC4_ADD2_TC1.

use ifc_lite_core::parser::{skip_step_trivia, read_step_number, StepNumber, StepRecord};

fn scalar_equals(token: &str, value: &str) -> bool {
    let bytes = token.as_bytes();
    let Some(start) = skip_step_trivia(bytes, 0) else { return false };
    bytes.get(start..start + value.len()).is_some_and(|v| v.eq_ignore_ascii_case(value.as_bytes()))
        && skip_step_trivia(bytes, start + value.len()) == Some(bytes.len())
}

fn stiffness_number(token: &str) -> Option<f64> {
    let bytes = token.as_bytes();
    let start = skip_step_trivia(bytes, 0)?;
    let (number, len) = read_step_number(&bytes[start..])?;
    if skip_step_trivia(bytes, start + len)? != bytes.len() { return None; }
    match number { StepNumber::Integer(n) => Some(n as f64), StepNumber::Real(n) => Some(n), StepNumber::Unrepresentable(_) => None }
}

fn downgrade_stiffness(token: &str, measure: &str) -> Option<String> {
    let wrapper = format!("#0={token};");
    let record = StepRecord::parse(wrapper.as_bytes())?;
    // A typed SELECT wrapper has one value argument, not a named entity slot.
    let mut values = record.attrs();
    let inner = std::str::from_utf8(values.next()?).ok()?;
    if values.next().is_some() { return None; }
    if record.keyword_is(b"IFCBOOLEAN") {
        if scalar_equals(inner, ".T.") { Some("-1.".into()) }
        else if scalar_equals(inner, ".F.") { Some("0.".into()) } else { None }
    } else if record.keyword().is_some_and(|head| head.eq_ignore_ascii_case(measure)) { Some(inner.into()) }
    else { None }
}

/// The boundary attributes changed names, but retain their order and units.
fn stiffness_type(entity: &str, index: usize) -> Option<&'static str> {
    Some(match (entity, index) {
        ("IFCBOUNDARYNODECONDITIONWARPING", 7) => "IFCWARPINGMOMENTMEASURE",
        ("IFCBOUNDARYNODECONDITION" | "IFCBOUNDARYNODECONDITIONWARPING", 1..=3) => "IFCLINEARSTIFFNESSMEASURE",
        ("IFCBOUNDARYNODECONDITION" | "IFCBOUNDARYNODECONDITIONWARPING", 4..=6) => "IFCROTATIONALSTIFFNESSMEASURE",
        ("IFCBOUNDARYEDGECONDITION", 1..=3) => "IFCMODULUSOFLINEARSUBGRADEREACTIONMEASURE",
        ("IFCBOUNDARYEDGECONDITION", 4..=6) => "IFCMODULUSOFROTATIONALSUBGRADEREACTIONMEASURE",
        ("IFCBOUNDARYFACECONDITION", 1..=3) => "IFCMODULUSOFSUBGRADEREACTIONMEASURE",
        _ => return None,
    })
}

/// Only the two constant action types share an exact semantic counterpart.
/// Varying actions need load locations, not merely a type rename.
pub(crate) fn constant_action(entity: &str) -> bool {
    matches!(entity, "IFCSTRUCTURALLINEARACTION" | "IFCSTRUCTURALPLANARACTION")
}

pub(crate) fn is_assignment_conversion(entity: &str, from: &str, to: &str) -> bool {
    entity == "IFCRELCONNECTSSTRUCTURALELEMENT" && from == "IFC2X3" && matches!(to, "IFC4" | "IFC4X3" | "IFC5")
}

/// The loss reported when IFC2X3's required DestabilizingLoad is written as .F. for an unknown value.
pub(crate) fn destabilizing_unknown(entity: &str) -> String {
    format!("{entity}.DestabilizingLoad is unknown; IFC2X3 requires a boolean, so the writer substitutes .F.")
}

pub(crate) fn attributes(entity: &str, args: &[String], from: &str, to: &str) -> Option<String> {
    if is_assignment_conversion(entity, from, to) && args.len() == 6 {
        // IFC4 expresses the physical product's analytical assignment as an
        // IfcRelAssignsToProduct. The inverse is `schema_structural_links`.
        return Some(format!("{},({}),$,{}", args[..4].join(","), args[5], args[4]));
    }
    if !matches!((from, to), ("IFC2X3", "IFC4") | ("IFC4", "IFC2X3")) { return None; }
    if stiffness_type(entity, 1).is_some() {
        let mut values = args.to_vec();
        for (index, value) in values.iter_mut().enumerate().skip(1) {
            let Some(measure) = stiffness_type(entity, index) else { continue };
            let token = value.trim();
            if scalar_equals(token, "$") { continue; }
            if to == "IFC4" {
                // IFC2X3 uses -1 for an infinitely stiff restraint. Zero is a
                // finite measure too; keeping that encoding avoids rounding.
                *value = if stiffness_number(token) == Some(-1.0) {
                    "IFCBOOLEAN(.T.)".into()
                } else { format!("{measure}({token})") };
            } else {
                *value = downgrade_stiffness(token, measure)?;
            }
        }
        return Some(values.join(","));
    }
    if constant_action(entity) {
        let src = crate::schema_convert::schema_attribute_names(from, entity)?;
        let tgt = crate::schema_convert::schema_attribute_names(to, entity)?;
        return Some(tgt.iter().map(|name| {
            src.iter().position(|s| s == name).and_then(|i| args.get(i)).map(String::as_str)
                .unwrap_or(if *name == "PredefinedType" { ".CONST." } else { "$" })
        }).collect::<Vec<_>>().join(","));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema_convert::convert_step_line;
    use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

    #[test]
    fn boundary_measures_round_trip_and_rigid_sentinel_9668() {
        for entity in ["IFCBOUNDARYNODECONDITION", "IFCBOUNDARYNODECONDITIONWARPING",
            "IFCBOUNDARYEDGECONDITION", "IFCBOUNDARYFACECONDITION"] {
            let count = if entity.ends_with("WARPING") { 7 } else if entity.contains("FACE") { 3 } else { 6 };
            let mut args = vec!["'Support'".to_string()];
            args.extend((0..count).map(|i| format!("{i}.")));
            let source = format!("#23={entity}({});", args.join(","));
            let mut slots = Ifc2x3SlotFill::new(None);
            let there = convert_step_line(&source, "IFC2X3", "IFC4", 23, &mut slots, None).unwrap();
            assert!(there.contains("MEASURE(0.)"));
            assert_eq!(convert_step_line(&there, "IFC4", "IFC2X3", 23, &mut slots, None).unwrap(), source);
        }
        let args = vec!["$".into(), "-1.".into(), "0.".into()];
        assert_eq!(attributes("IFCBOUNDARYNODECONDITION", &args, "IFC2X3", "IFC4").unwrap(),
            "$,IFCBOOLEAN(.T.),IFCLINEARSTIFFNESSMEASURE(0.)");
    }

    #[test]
    fn constant_actions_keep_projected_or_true_in_its_named_slot_9668() {
        for entity in ["IFCSTRUCTURALLINEARACTION", "IFCSTRUCTURALPLANARACTION"] {
            let source = format!("#50={entity}('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);");
            let mut slots = Ifc2x3SlotFill::new(None);
            let there = convert_step_line(&source, "IFC2X3", "IFC4", 50, &mut slots, None).unwrap();
            assert!(there.ends_with(".F.,.TRUE_LENGTH.,.CONST.);"), "{there}");
            assert_eq!(convert_step_line(&there, "IFC4", "IFC2X3", 50, &mut slots, None).unwrap(), source);
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use crate::schema_convert::convert_step_line;
    use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
    use crate::schema_enum::ConversionChecks;

    #[test]
    fn missing_point_fields_are_explicit_losses_not_hidden_metadata_9668() {
        for (source, from, to, field) in [
            ("#50=IFCSTRUCTURALPOINTACTION('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,#77);", "IFC2X3", "IFC4", "CausedBy"),
            ("#50=IFCSTRUCTURALPOINTCONNECTION('id',#1,$,$,$,$,$,#22,#77);", "IFC4", "IFC2X3", "ConditionCoordinateSystem"),
        ] {
            let mut checks = ConversionChecks::new();
            let out = convert_step_line(source, from, to, 50, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
            assert!(!out.contains("#77"));
            assert!(checks.warnings().iter().any(|w| w.contains(field) && w.contains("omitted")), "{:?}", checks.warnings());
            assert_eq!(checks.attribute_values_dropped, 1);
        }
    }

    #[test]
    fn physical_analytical_link_retains_both_objects_in_ifc4_9668() {
        let source = "#50=IFCRELCONNECTSSTRUCTURALELEMENT('id',#1,$,$,#22,#77);";
        for target in ["IFC4", "IFC4X3", "IFC5"] {
            let mut checks = ConversionChecks::new();
            let out = convert_step_line(source, "IFC2X3", target, 50, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
            assert_eq!(out, "#50=IFCRELASSIGNSTOPRODUCT('id',#1,$,$,(#77),$,#22);");
            assert!(checks.warnings().iter().any(|w| w.contains("the relationship kind is not kept in the target file")));
        }
    }
}

#[cfg(test)]
mod review_regressions {
    use crate::step::{export_step_with_diagnostics, export_step_to_writer_with_diagnostics, StepOptions};
    use crate::schema_convert::convert_step_line;
    use crate::schema_enum::ConversionChecks;
    use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

    #[test]
    fn plain_native_diagnostics_forward_named_structural_losses_9668() {
        for (schema, target, record, field) in [
            ("IFC4", "IFC2X3", "#50=IFCSTRUCTURALPOINTCONNECTION('id',#1,$,$,$,$,$,#22,#77);", "ConditionCoordinateSystem"),
            ("IFC2X3", "IFC4", "#50=IFCSTRUCTURALPOINTACTION('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,#77);", "CausedBy"),
        ] {
            let source = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{record}\nENDSEC;END-ISO-10303-21;");
            let options = StepOptions { schema: Some(target.into()), ..StepOptions::default() };
            let (out, stats, warnings) = export_step_with_diagnostics(source.as_bytes(), &options).unwrap();
            assert!(!out.contains("#77"));
            assert!(warnings.iter().any(|w| w.contains(field) && w.contains("omitted")), "{warnings:?}");
            assert_eq!(stats.attribute_values_dropped, 1);
            let mut bytes = Vec::new();
            let (_, streamed_warnings) = export_step_to_writer_with_diagnostics(source.as_bytes(), &options, &mut bytes).unwrap();
            assert_eq!(bytes, out.as_bytes());
            assert_eq!(streamed_warnings, warnings);
            if field == "ConditionCoordinateSystem" {
                assert!(warnings.iter().any(|w| w.contains("restraint directions")));
            }
        }
    }

    #[test]
    fn native_ifc2x3_varying_action_is_unconverted_and_warned_9668() {
        let source = "#50=IFCSTRUCTURALPLANARACTIONVARYING('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,#88,(#23));";
        let mut checks = ConversionChecks::new();
        let out = convert_step_line(source, "IFC2X3", "IFC4", 50, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        assert_eq!(out, source);
        assert!(checks.warnings().iter().any(|w| w.contains("record remains unconverted; output does not conform to IFC4")));
    }
}

#[cfg(test)]
mod trivia_regressions {
    use crate::schema_convert::convert_step_line;
    use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

    #[test]
    fn stiffness_select_wrapper_requires_one_value_9668() {
        for token in ["IFCBOOLEAN()", "IFCBOOLEAN(.T.,.F.)", "IFCLINEARSTIFFNESSMEASURE(1.,2.)"] {
            assert!(super::downgrade_stiffness(token, "IFCLINEARSTIFFNESSMEASURE").is_none());
        }
        assert_eq!(super::downgrade_stiffness("IFCBOOLEAN(.F.)", "IFCLINEARSTIFFNESSMEASURE"), Some("0.".into()));
    }

    #[test]
    fn stiffness_uses_step_trivia_for_sentinels_and_typed_values_9668() {
        let source = "#23=IFCBOUNDARYNODECONDITION($,-1./* rigid */,12./* finite */,$,$,$,$);";
        let out = convert_step_line(source, "IFC2X3", "IFC4", 23, &mut Ifc2x3SlotFill::new(None), None).unwrap();
        assert!(out.contains("IFCBOOLEAN(.T.)"));
        assert!(out.contains("IFCLINEARSTIFFNESSMEASURE(12./* finite */)"));
        for typed in ["IFCBOOLEAN (.T.)", "IFCBOOLEAN/*type*/( /*value*/ .T. /*tail*/ )", "ifcboolean ( .t. )"] {
            let source = format!("#23=IFCBOUNDARYNODECONDITION($,{typed},$,$,$,$,$);");
            let out = convert_step_line(&source, "IFC4", "IFC2X3", 23, &mut Ifc2x3SlotFill::new(None), None).unwrap();
            assert_eq!(out, "#23=IFCBOUNDARYNODECONDITION($,-1.,$,$,$,$,$);");
        }
    }
}
