// SPDX-License-Identifier: MPL-2.0
//! Explicit losses where the other structural schema has no semantic slot (#9668).
use std::collections::BTreeMap;
use crate::schema_convert::{rename_type, schema_attribute_names};

#[derive(Default)]
pub(crate) struct StructuralDiagnostics {
    losses: BTreeMap<String, usize>,
    pub(crate) axes: crate::schema_structural_axes::StructuralAxes,
}

impl StructuralDiagnostics {
    pub(crate) fn inspect(&mut self, entity: &str, args: &[String], from: &str, to: &str, axis_known: bool) {
        if crate::schema_structural::is_assignment_conversion(entity, from, to) {
            self.record("IfcRelConnectsStructuralElement is mapped to IfcRelAssignsToProduct; the original relationship kind cannot round trip".into());
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
                self.record(format!("{entity}.DestabilizingLoad is unknown; IFC2X3 requires a boolean, so the writer substitutes .F."));
            }
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

    pub(crate) fn warnings(&self) -> Vec<String> {
        self.losses.iter().map(|(message, count)| format!("{count} structural conversion record(s): {message} (#9668).")).collect()
    }
}
