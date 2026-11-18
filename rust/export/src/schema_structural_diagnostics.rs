// SPDX-License-Identifier: MPL-2.0
//! Explicit losses where the other structural schema has no semantic slot (#9668).
use std::collections::{BTreeMap, BTreeSet};
use crate::schema_convert::{rename_type, schema_attribute_names};

const LINK: &str = "IfcRelAssignsToProduct linking one structural member to its element is written as IfcRelConnectsStructuralElement, the IFC2X3 physical-to-analytical link";

#[derive(Default)]
pub(crate) struct StructuralDiagnostics {
    losses: BTreeMap<String, usize>,
    pub(crate) axes: crate::schema_structural_axes::StructuralAxes,
    pub(crate) links: crate::schema_structural_links::StructuralLinks,
    pub(crate) varying: crate::schema_structural_varying::StructuralVarying,
    pub(crate) carriers: crate::schema_structural_carriers::StructuralCarriers,
}

impl StructuralDiagnostics {
    pub(crate) fn inspect(&mut self, id: u32, entity: &str, args: &[String], from: &str, to: &str, axis_known: bool) {
        let cause_carried = self.cause(id, entity).is_some();
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
        // An IFC2X3 varying action that stays unconverted is no IFC4 product a 'Causes' relationship could name.
        if self.varying.stays_unconverted(id, entity) && self.carriers.cause(id).is_some() { self.record(crate::schema_structural_carriers::CAUSED_BY_UNCONVERTED.into()); }
        let cause = self.cause(id, entity);
        if let Some(message) = cause {
            self.record(message.into());
            self.carriers.write(id);
        }
        let (body, losses) = match self.links.link(entity, args) {
            Some(attrs) => (format!("IFCRELCONNECTSSTRUCTURALELEMENT({attrs})"), vec![LINK.to_string()]),
            None => self.varying.rewrite(id, entity, args, cause.is_some())?,
        };
        losses.into_iter().for_each(|loss| self.record(loss));
        Some(body)
    }

    /// The message for an action whose CausedBy a 'Causes' relationship holds, or None.
    fn cause(&self, id: u32, entity: &str) -> Option<&'static str> {
        if self.varying.stays_unconverted(id, entity) { None } else { self.carriers.cause(id) }
    }

    /// IFC2X3 -> IFC4: ids for the records the prepasses add, in the order the
    /// TypeScript twin allocates them while writing: per action in id order,
    /// its 'Causes' relationship, then its load configuration.
    pub(crate) fn allocate(&mut self, mut allocate: impl FnMut() -> Option<u32>) {
        let causes: BTreeMap<u32, bool> = self.carriers.needs_ids().collect();
        let actions: BTreeSet<u32> = causes.keys().copied().chain(self.varying.needs_ids()).collect();
        for action in actions {
            let configured = self.varying.plans(action);
            // A varying action that stays unconverted gets no relationship.
            let caused = causes.get(&action).is_some_and(|&varying| !varying || configured);
            // All of an action's ids or none, so a relationship never names an action left unconverted.
            let relationship = if caused { let Some(id) = allocate() else { return }; Some(id) } else { None };
            let configuration = if configured { let Some(id) = allocate() else { return }; Some(id) } else { None };
            if let Some(id) = relationship { self.carriers.assign(action, id); }
            if let Some(id) = configuration { self.varying.assign(action, id); }
        }
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
