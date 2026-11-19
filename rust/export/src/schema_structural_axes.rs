// SPDX-License-Identifier: MPL-2.0
//! IFC2X3 ProfileOrientation -> IFC4 member Axis (#9668).
//! ProfileOrientation as IfcDirection is the section z-axis in the analysis
//! model frame (IFC2x3 FINAL IfcRelAssociatesProfileProperties). It can be reused
//! directly only when the member's ObjectPlacement leaves that frame unturned.
use std::collections::{HashMap, HashSet};
use crate::step_slot::split_top_level_args;
use nalgebra::{Matrix3, Vector3};
use crate::schema_structural_axis_carriers::{AxisCarrierRecords, AxisPlan};

#[derive(Default)]
pub(crate) struct StructuralAxes {
    axes: HashMap<u32, Option<u32>>,
    directions: HashMap<u32, Vector3<f64>>,
    placed_axes: HashMap<u32, u32>,
    added: Vec<String>,
    pub(crate) carriers: AxisCarrierRecords,
}

pub(super) use crate::schema_structural_links::{slot_ref as reference, slot_unset as unset};

pub(crate) fn list_items(token: &str) -> Option<Vec<String>> {
    let start = ifc_lite_core::parser::skip_step_trivia(token.as_bytes(), 0)?;
    if token.as_bytes().get(start) != Some(&b'(') { return None; }
    // Reuse the shared frame's trailing-comment handling; this parsing
    // envelope is never exported and does not assign an IFC entity type.
    let text = format!("#0=IFCDIRECTION{token};");
    let frame = crate::step_record_frame::record_frame(&text)?;
    split_top_level_args(frame.args(&text))
}

impl StructuralAxes {
    #[inline(never)]
    pub(crate) fn scan(content: &[u8], kept: &dyn Fn(u32, usize) -> bool, downgrade: bool, allocate: &mut dyn FnMut() -> Option<u32>) -> Self {
        if !has_members(content) { return Self::default(); }
        let mut result = Self::default();
        let mut members = Vec::new();
        let mut associations = Vec::new();
        let mut properties = HashSet::new();
        let mut placements = HashMap::new();
        let mut frames = HashMap::new();
        let mut planar = HashMap::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            const KINDS: [&str; 8] = [
                "IFCRELASSOCIATESPROFILEPROPERTIES", "IFCDIRECTION", "IFCSTRUCTURALCURVEMEMBER",
                "IFCSTRUCTURALCURVEMEMBERVARYING", "IFCLOCALPLACEMENT",
                "IFCAXIS2PLACEMENT3D", "IFCAXIS2PLACEMENT2D", "IFCGENERALPROFILEPROPERTIES",
            ];
            let Some(kind) = KINDS.into_iter().find(|kind| ty.eq_ignore_ascii_case(kind)) else { continue; };
            if !kept(id, start) { continue; }
            let text = String::from_utf8_lossy(&content[start..end]);
            let Some(frame) = crate::step_record_frame::record_frame(&text) else { continue; };
            let Some(args) = split_top_level_args(frame.args(&text)) else { continue; };
            match (kind, args.as_slice()) {
                ("IFCDIRECTION", [ratios]) => {
                    let dimensions = list_items(ratios).map(|values| values.len());
                    let Some((x, y, z)) = ifc_lite_core::parser::StepRecord::parse(&content[start..end])
                        .and_then(|record| record.point_at(0)) else { continue; };
                    if ![x, y, z].into_iter().all(f64::is_finite) { continue; }
                    match dimensions {
                        Some(3) if x != 0. || y != 0. || z != 0. => { result.directions.insert(id, Vector3::new(x, y, z)); }
                        Some(2) => { planar.insert(id, Vector3::new(x, y, 0.)); }
                        _ => {}
                    }
                }
                ("IFCRELASSOCIATESPROFILEPROPERTIES", [_, _, _, _, related, _, _, orientation]) => {
                    let axis = reference(orientation);
                    for member in list_items(related).unwrap_or_default().iter().filter_map(|s| reference(s)) {
                        result.axes.entry(member).and_modify(|old| { if *old != axis { *old = None; } }).or_insert(axis);
                    }
                    associations.push((id, args));
                }
                ("IFCGENERALPROFILEPROPERTIES", values) if values.len() == 7 && values.iter().all(|v| unset(v)) => {
                    properties.insert(id);
                }
                ("IFCSTRUCTURALCURVEMEMBER" | "IFCSTRUCTURALCURVEMEMBERVARYING", _) if args.len() == if downgrade { 9 } else { 8 } => {
                    members.push((id, args));
                }
                ("IFCLOCALPLACEMENT", [parent, frame]) => { placements.insert(id, (parent.clone(), reference(frame))); }
                ("IFCAXIS2PLACEMENT3D", [_, z, x]) => { frames.insert(id, (Some(z.clone()), x.clone())); }
                ("IFCAXIS2PLACEMENT2D", [_, x]) => { frames.insert(id, (None, x.clone())); }
                _ => {}
            }
        }

        if members.is_empty() { return result; }
        members.sort_unstable_by_key(|(id, _)| *id);
        let mut rotations = HashMap::new();
        let mut plans = Vec::new();
        for (member, args) in members {
            let axis = if downgrade { reference(&args[8]) } else { result.axes.get(&member).copied().flatten() };
            let Some(axis) = axis else { continue; };
            let Some(values) = result.directions.get(&axis) else { continue; };
            let rotation = if unset(&args[5]) { Some(Matrix3::identity()) }
            else if let Some(placement) = reference(&args[5]) {
                rotation_at(placement, &placements, &mut rotations, |id| {
                    let (z, x) = frames.get(&id)?;
                    let z_axis = match z.as_deref() {
                        Some(token) if !unset(token) => result.directions.get(&reference(token)?)?.try_normalize(1e-9)?,
                        _ => Vector3::z(),
                    };
                    let x_axis = if unset(x) {
                        let x = Vector3::x() - z_axis * z_axis.x;
                        if x.norm() > 1e-9 { x } else { Vector3::z().cross(&z_axis) }
                    } else {
                        let authored = if z.is_some() { &result.directions } else { &planar }.get(&reference(x)?)?;
                        authored - z_axis * authored.dot(&z_axis)
                    }.try_normalize(1e-9)?;
                    Some(Matrix3::from_columns(&[x_axis, z_axis.cross(&x_axis), z_axis]))
                })
            } else { None };
            let Some(rotation) = rotation else { continue; };
            let turned = rotation != Matrix3::identity();
            let ratios = if downgrade { rotation * values } else { rotation.transpose() * values };
            if !ratios.iter().all(|v| v.is_finite()) { continue; }
            plans.push(AxisPlan { member, axis, turned, ratios, args });
        }
        if downgrade {
            result.carriers = AxisCarrierRecords::downgrade(plans, associations, &result.directions, allocate);
        } else {
            result.restore_axes(plans, &associations, &properties, content, kept, allocate);
        }
        result
    }

    #[inline(never)]
    fn restore_axes(
        &mut self,
        plans: Vec<AxisPlan>,
        associations: &[(u32, Vec<String>)],
        properties: &HashSet<u32>,
        content: &[u8],
        kept: &dyn Fn(u32, usize) -> bool,
        allocate: &mut dyn FnMut() -> Option<u32>,
    ) {
        let candidates = AxisCarrierRecords::removable_associations(associations, properties, &plans, content, kept);
        let mut reusable = HashMap::new();
        if plans.iter().any(|plan| plan.turned) {
            let consumed_directions: HashSet<_> = candidates.iter().filter_map(|(_, carrier)| carrier.direction).collect();
            for (&id, &values) in &self.directions {
                if consumed_directions.contains(&id) { continue; }
                let key = direction_tuple(values, 12);
                reusable.entry(key).and_modify(|old: &mut u32| *old = (*old).min(id)).or_insert(id);
            }
        }
        for plan in plans {
            let axis = if !plan.turned { plan.axis }
            else if let Some(&existing) = reusable.get(&direction_tuple(plan.ratios, 12)) { existing }
            else if let Some(new_id) = allocate() {
                self.added.push(format!("#{new_id}=IFCDIRECTION({});", direction_tuple(plan.ratios, 15)));
                new_id
            } else { continue; };
            self.placed_axes.insert(plan.member, axis);
        }
        // Several independent carriers can agree on the same restored Axis.
        for (member, carrier) in &candidates {
            if self.placed_axes.contains_key(member) {
                self.carriers.consume(carrier);
            }
        }
    }

    pub(crate) fn added(&mut self) -> Vec<String> {
        let mut added = std::mem::take(&mut self.added);
        added.extend(self.carriers.added());
        added
    }

    pub(crate) fn axis(&self, id: u32, entity: &str, args: &[String]) -> Option<String> {
        if !matches!(entity, "IFCSTRUCTURALCURVEMEMBER" | "IFCSTRUCTURALCURVEMEMBERVARYING")
            || args.len() != 8 { return None; }
        let axis = if unset(&args[5]) { self.axes.get(&id).copied().flatten()? }
            else { *self.placed_axes.get(&id)? };
        (self.directions.contains_key(&axis) || self.placed_axes.contains_key(&id)).then(|| format!("#{axis}"))
    }
}

fn has_members(content: &[u8]) -> bool {
    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    while let Some((_, kind, _, _)) = scanner.next_entity() {
        if kind.eq_ignore_ascii_case("IFCSTRUCTURALCURVEMEMBER")
            || kind.eq_ignore_ascii_case("IFCSTRUCTURALCURVEMEMBERVARYING") {
            return true;
        }
    }
    false
}

pub(super) fn direction_tuple(values: Vector3<f64>, digits: usize) -> String {
    let ratios = values.map(|value| {
        let rounded = if value.abs() < 1e-9 { 0. }
            else { format!("{value:.precision$e}", precision = digits - 1).parse().unwrap_or(value) };
        crate::step_log::format_step_real(rounded)
    });
    format!("({},{},{})", ratios.x, ratios.y, ratios.z)
}

/// Resolve a retained IfcLocalPlacement chain from the root and cache both
/// valid and refused chains. Repeated ids stop cycles before any multiplication.
fn rotation_at(
    start: u32,
    placements: &HashMap<u32, (String, Option<u32>)>,
    cache: &mut HashMap<u32, Option<Matrix3<f64>>>,
    frame: impl Fn(u32) -> Option<Matrix3<f64>>,
) -> Option<Matrix3<f64>> {
    let mut cursor = start;
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut rotation = loop {
        if let Some(value) = cache.get(&cursor) { break *value; }
        if !seen.insert(cursor) { break None; }
        let Some((parent, Some(axis))) = placements.get(&cursor) else { break None; };
        path.push((cursor, *axis));
        if unset(parent) { break Some(Matrix3::identity()); }
        let Some(parent) = reference(parent) else { break None; };
        cursor = parent;
    };
    for (id, axis) in path.into_iter().rev() {
        rotation = rotation.zip(frame(axis)).map(|(parent, local)| parent * local);
        cache.insert(id, rotation);
    }
    cache.insert(start, rotation);
    rotation
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
        let commented = source.replace("((0.,1.,0.))", "((0.,1./* axis */,0.))");
        // #9845: trivia before the direction tuple must not hide its dimension.
        let prefixed = source.replace("((0.,1.,0.))", "(/* axis */(0.,1.,0.))");
        let related = source.replace("(#50),#81", "/* related */(#50),#81");
        let trailing = source.replace("((0.,1.,0.))", "((0.,1.,0.)/* trailing ) axis */)");
        let related_trailing = source.replace("(#50),#81", "/* related */(#50)/* trailing ) members */,#81");
        for (text, target) in [(source, "IFC4_ADD2"), (mixed.as_str(), "IFC4"), (commented.as_str(), "IFC4"), (prefixed.as_str(), "IFC4"), (related.as_str(), "IFC4"), (trailing.as_str(), "IFC4"), (related_trailing.as_str(), "IFC4")] {
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
