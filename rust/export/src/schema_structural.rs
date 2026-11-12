// SPDX-License-Identifier: MPL-2.0
//! Structural value conversion (#9668). EXPRESS IFC2X3_TC1 / IFC4_ADD2_TC1.

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

pub(crate) fn attributes(entity: &str, args: &[String], from: &str, to: &str) -> Option<String> {
    if !matches!((from, to), ("IFC2X3", "IFC4") | ("IFC4", "IFC2X3")) { return None; }
    if stiffness_type(entity, 1).is_some() {
        let mut values = args.to_vec();
        for (index, value) in values.iter_mut().enumerate().skip(1) {
            let Some(measure) = stiffness_type(entity, index) else { continue };
            let token = value.trim();
            if token == "$" { continue; }
            if to == "IFC4" {
                // IFC2X3 uses -1 for an infinitely stiff restraint. Zero is a
                // finite measure too; keeping that encoding avoids rounding.
                *value = if token.parse::<f64>().ok() == Some(-1.0) {
                    "IFCBOOLEAN(.T.)".into()
                } else { format!("{measure}({token})") };
            } else if let Some(open) = token.find('(') {
                let head = &token[..open];
                let inner = token[open + 1..].strip_suffix(')')?;
                *value = if head.eq_ignore_ascii_case("IFCBOOLEAN") {
                    match inner.trim() { ".T." => "-1.".into(), ".F." => "0.".into(), _ => return None }
                } else if head.eq_ignore_ascii_case(measure) { inner.into() } else { return None };
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
