// SPDX-License-Identifier: MPL-2.0
//! IFC2X3 ProfileOrientation -> IFC4 member Axis (#9668).
//! ProfileOrientation as IfcDirection is the section z-axis in the analysis
//! model frame (IFC2x3 FINAL IfcRelAssociatesProfileProperties). It can be reused
//! directly only when the member is in that same frame (no ObjectPlacement).
use std::collections::{HashMap, HashSet};
use crate::step_slot::split_top_level_args;

#[derive(Default)]
pub(crate) struct StructuralAxes {
    axes: HashMap<u32, Option<u32>>,
    directions: HashSet<u32>,
}

fn reference(token: &str) -> Option<u32> { token.trim().strip_prefix('#')?.trim().parse().ok() }

impl StructuralAxes {
    pub(crate) fn scan(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let mut result = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if (!ty.eq_ignore_ascii_case("IFCRELASSOCIATESPROFILEPROPERTIES") && !ty.eq_ignore_ascii_case("IFCDIRECTION")) || !kept(id, start) { continue; }
            let text = String::from_utf8_lossy(&content[start..end]);
            let (Some(open), Some(close)) = (text.find('('), text.rfind(')')) else { continue };
            if close <= open { continue; }
            let Some(args) = split_top_level_args(&text[open + 1..close]) else { continue };
            if ty.eq_ignore_ascii_case("IFCDIRECTION") {
                let inner = args.first().and_then(|s| s.trim().strip_prefix('(')?.strip_suffix(')'));
                let values = inner.and_then(split_top_level_args).and_then(|v| v.iter().map(|s| s.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>());
                if values.is_some_and(|v| v.len() == 3 && v.iter().all(|x| x.is_finite()) && v.iter().any(|x| *x != 0.0)) {
                    result.directions.insert(id);
                }
            } else if args.len() == 8 {
                let axis = reference(&args[7]);
                let members = args[4].trim().strip_prefix('(').and_then(|s| s.strip_suffix(')')).and_then(split_top_level_args);
                for member in members.unwrap_or_default().iter().filter_map(|s| reference(s)) {
                    result.axes.entry(member).and_modify(|old| { if *old != axis { *old = None; } }).or_insert(axis);
                }
            }
        }
        result
    }

    pub(crate) fn axis(&self, id: u32, entity: &str, args: &[String]) -> Option<String> {
        // Angles, placed members, conflicting section orientations, missing
        // direction records and inferred defaults need a frame/geometry pass.
        // They remain unknown here, with a diagnostic; never invent a z-axis.
        if !matches!(entity, "IFCSTRUCTURALCURVEMEMBER" | "IFCSTRUCTURALCURVEMEMBERVARYING")
            || args.len() != 8 || args[5].trim() != "$" { return None; }
        let axis = self.axes.get(&id).copied().flatten()?;
        self.directions.contains(&axis).then(|| format!("#{axis}"))
    }
}

#[cfg(test)]
mod tests {
    use crate::step::{export_step_with_stats, StepOptions};

    const SOURCE: &[u8] = b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n#50=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.);\n#80=IFCDIRECTION((0.,1.,0.));\n#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);\nENDSEC;END-ISO-10303-21;";

    #[test]
    fn explicit_profile_z_axis_is_carried_through_full_export_9668() {
        let source = SOURCE;
        let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
        let (out, stats) = export_step_with_stats(source, &options).unwrap();
        assert!(out.contains(".RIGID_JOINED_MEMBER.,#80)"), "{out}");
        assert_eq!(stats.ifc4_required_slots_unfilled, 0);
        let log = crate::step_log::MutationLog::from_json("{}").unwrap();
        let (logged, stats) = crate::step_log::export_step_with_log(source, &options, &log).unwrap();
        assert!(logged.contains(".RIGID_JOINED_MEMBER.,#80)"));
        assert!(!stats.warnings.iter().any(|w| w.contains("Axis is required")));
        // A subset cannot gain a reference outside its forward closure.
        let subset = StepOptions { included: Some(vec![50]), ..options };
        let (out, stats) = export_step_with_stats(source, &subset).unwrap();
        assert!(!out.contains("#80)"));
        assert_eq!(stats.ifc4_required_slots_unfilled, 1);
    }
    #[test]
    fn axes_follow_schema_aliases_case_and_retained_record_selection_9668() {
        let source = std::str::from_utf8(SOURCE).unwrap();
        let mixed = source.replace("IFCDIRECTION", "IfcDirection").replace("IFCRELASSOCIATESPROFILEPROPERTIES", "IfcRelAssociatesProfileProperties");
        for (text, target) in [(source, "IFC4_ADD2"), (mixed.as_str(), "IFC4")] {
            let opts = StepOptions { schema: Some(target.into()), ..StepOptions::default() };
            let (out, stats) = export_step_with_stats(text.as_bytes(), &opts).unwrap();
            assert!(out.contains(".RIGID_JOINED_MEMBER.,#80)"), "{out}");
            assert_eq!(stats.ifc4_required_slots_unfilled, 0);
            let log = crate::step_log::MutationLog::from_json("{}").unwrap();
            let (out, _) = crate::step_log::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
            assert!(out.contains(".RIGID_JOINED_MEMBER.,#80)"));
        }
        let replaced = source.replace("\nENDSEC;", "\n#80=IFCCARTESIANPOINT((1.,0.,0.));\nENDSEC;");
        let opts = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
        let (out, stats) = export_step_with_stats(replaced.as_bytes(), &opts).unwrap();
        assert!(!out.contains(".RIGID_JOINED_MEMBER.,#80)"));
        assert_eq!(stats.ifc4_required_slots_unfilled, 1);
        assert_eq!(stats.duplicate_records_dropped, 1);
        let log = crate::step_log::MutationLog::from_json("{}").unwrap();
        let (out, stats) = crate::step_log::export_step_with_log(replaced.as_bytes(), &opts, &log).unwrap();
        assert!(!out.contains(".RIGID_JOINED_MEMBER.,#80)"));
        assert!(stats.warnings.iter().any(|w| w.contains("Axis is required")));
    }

}
