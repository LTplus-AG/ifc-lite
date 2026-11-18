// SPDX-License-Identifier: MPL-2.0
//! Explicit losses where the other structural schema has no semantic slot (#9668).
use std::collections::{BTreeMap, HashSet};
use crate::schema_convert::{rename_type, schema_attribute_names};

const LINK: &str = "IfcRelAssignsToProduct linking one structural member to its element is written as IfcRelConnectsStructuralElement, the IFC2X3 physical-to-analytical link";

#[derive(Default)]
pub(crate) struct StructuralDiagnostics {
    losses: BTreeMap<String, usize>,
    pub(crate) axes: crate::schema_structural_axes::StructuralAxes,
    pub(crate) links: crate::schema_structural_links::StructuralLinks,
    pub(crate) varying: crate::schema_structural_varying::StructuralVarying,
    pub(crate) carriers: crate::schema_structural_carriers::StructuralCarriers,
    /// Actions whose CausedBy a 'Causes' relationship holds, which `inspect` does not report lost.
    cause_carried: HashSet<u32>,
}

impl StructuralDiagnostics {
    pub(crate) fn inspect(&mut self, id: u32, entity: &str, args: &[String], from: &str, to: &str, axis_known: bool) {
        let cause_carried = self.cause_carried.remove(&id);
        if crate::schema_structural::is_assignment_conversion(entity, from, to) {
            self.record("IfcRelConnectsStructuralElement is mapped to IfcRelAssignsToProduct; the relationship kind is not kept in the target file".into());
            return;
        }
        if !matches!((from, to), ("IFC2X3", "IFC4") | ("IFC4", "IFC2X3"))
            || !(entity.starts_with("IFCSTRUCTURAL") || entity.starts_with("IFCRELCONNECTSSTRUCTURAL") || entity == "IFCRELASSOCIATESPROFILEPROPERTIES") { return; }
        let Some(src) = schema_attribute_names(from, entity) else { return };
        let target = rename_type(entity, from, to).unwrap_or(entity);
        let Some(tgt) = schema_attribute_names(to, target) else {
            let outcome = if to == "IFC4" { "record remains unconverted; output does not conform to IFC4" } else { "the original entity semantics cannot be retained" };
            self.record(format!("{entity} has no representation in {to}; {outcome}"));
            return;
        };
        for (name, value) in src.iter().zip(args) {
            // CONST is intrinsic to IFC2X3 linear/planar actions, not lost data.
            if *name == "PredefinedType" && value.trim() == ".CONST."
                && matches!(entity, "IFCSTRUCTURALCURVEACTION" | "IFCSTRUCTURALSURFACEACTION" | "IFCSTRUCTURALLINEARACTION" | "IFCSTRUCTURALPLANARACTION") { continue; }
            if *name == "DestabilizingLoad" && value.trim() == "$" && to == "IFC2X3" {
                self.record(crate::schema_structural::destabilizing_unknown(entity));
            }
            if *name == "CausedBy" && cause_carried { continue; }
            if !tgt.contains(name) && !matches!(value.trim(), "$" | "*" | "") {
                let effect = if *name == "ConditionCoordinateSystem" { "; restraint directions in that coordinate system are not preserved" } else { "" };
                self.record(format!("{entity}.{name} has no slot in {to}; its value is omitted{effect}"));
            }
        }
        if to == "IFC4" && tgt.contains(&"Axis") && !src.contains(&"Axis") && !axis_known {
            // A record-local converter cannot infer a section's local z-axis
            // from a curve tangent. ProfileOrientation must be resolved from
            // model relationships; absent that evidence, report the missing axis.
            self.record(format!("{entity}.Axis is required by IFC4 but unknown; output does not conform until the model's section orientation is resolved"));
        }
    }

    fn record(&mut self, message: String) { *self.losses.entry(message).or_default() += 1; }

    /// A record written as another entity from source-derived facts
    /// (`StructuralLinks`, `StructuralVarying`, each armed only for its schema
    /// pair): the target record body, reported because the class changes.
    pub(crate) fn rewrite(&mut self, id: u32, entity: &str, args: &[String]) -> Option<String> {
        if self.carriers.stays_unconverted(id) { self.record(crate::schema_structural_carriers::CAUSED_BY_UNCONVERTED.into()); }
        let cause = self.carriers.cause(id);
        if let Some(message) = cause {
            self.record(message.into());
            self.cause_carried.insert(id);
        }
        let (body, losses) = match self.links.link(entity, args) {
            Some(attrs) => (format!("IFCRELCONNECTSSTRUCTURALELEMENT({attrs})"), vec![LINK.to_string()]),
            None => self.varying.rewrite(id, entity, args, cause.is_some())?,
        };
        losses.into_iter().for_each(|loss| self.record(loss));
        // A rewritten record skips `inspect`, which would free this.
        self.cause_carried.remove(&id);
        Some(body)
    }

    /// An already converted line with the values carriers fill in place (`StructuralCarriers::after`).
    pub(crate) fn after(&mut self, id: u32, line: String) -> String {
        match self.carriers.after(id, &line) {
            Some(filled) => { self.record(crate::schema_structural_carriers::CAUSED_BY_READ.into()); filled }
            None => line,
        }
    }

    /// Records the conversion added: load configurations, then 'Causes' relationships, as the TypeScript twin appends them.
    pub(crate) fn added(&mut self) -> Vec<String> {
        let mut added = self.varying.added();
        added.extend(self.carriers.added());
        added
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        self.losses.iter().map(|(message, count)| format!("{count} structural conversion record(s): {message} (#9668).")).collect()
    }
}
