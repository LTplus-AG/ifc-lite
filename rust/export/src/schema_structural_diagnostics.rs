// SPDX-License-Identifier: MPL-2.0
//! Explicit losses where the other structural schema has no semantic slot (#9668).
use crate::step_slot::slot_is;
use std::collections::{BTreeMap, BTreeSet};
use crate::schema_convert::{rename_type, schema_attribute_names};

#[path = "schema_structural_varying_effective.rs"]
mod varying_effective;

const LINK: &str = "IfcRelAssignsToProduct linking one structural member to its element is written as IfcRelConnectsStructuralElement, the IFC2X3 physical-to-analytical link";

#[derive(Default)]
pub(crate) struct StructuralDiagnostics {
    losses: BTreeMap<String, usize>,
    pub(crate) defer_varying: bool,
    pub(crate) values: crate::schema_structural_values::StructuralValues,
    pub(crate) axes: crate::schema_structural_axes::StructuralAxes,
    pub(crate) links: crate::schema_structural_links::StructuralLinks,
    pub(crate) varying: crate::schema_structural_varying::StructuralVarying,
    pub(crate) carriers: crate::schema_structural_carriers::StructuralCarriers,
}

impl StructuralDiagnostics {
    pub(crate) fn inspect(&mut self, id: u32, entity: &str, args: &[String], from: &str, to: &str, axis_known: bool) {
        if self.defer_varying && crate::schema_structural_varying::StructuralVarying::is_varying(entity) {
            return;
        }
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
            if *name == "PredefinedType" && slot_is(value, ".CONST.")
                && matches!(entity, "IFCSTRUCTURALCURVEACTION" | "IFCSTRUCTURALSURFACEACTION" | "IFCSTRUCTURALLINEARACTION" | "IFCSTRUCTURALPLANARACTION") { continue; }
            if *name == "DestabilizingLoad" && slot_is(value, "$") && to == "IFC2X3" {
                self.record(crate::schema_structural::destabilizing_unknown(entity));
            }
            if *name == "CausedBy" && cause_carried { continue; }
            // The dropped count's own test (#10779): a comment-only slot is no value.
            if !tgt.contains(name) && crate::schema_convert::holds_value(value) {
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

    /// Clear one omission once the writer has emitted a replacement property.
    pub(crate) fn restore_omitted_value(&mut self, entity: &str, attribute: &str, to: &str) {
        let message = format!("{entity}.{attribute} has no slot in {to}; its value is omitted");
        if let Some(count) = self.losses.get_mut(&message) {
            *count -= 1;
            if *count == 0 {
                self.losses.remove(&message);
            }
        }
    }

    pub(crate) fn buffers_varying(&self, content: &[u8]) -> bool {
        self.defer_varying && varying_effective::contains_varying(content)
    }

    pub(crate) fn finish_effective_varying(&mut self, text: &str, dropped: &mut usize) -> Option<(String, Vec<u32>)> {
        if !self.defer_varying {
            return None;
        }
        let output = varying_effective::finish(text)?;
        *dropped += output.dropped;
        output.warnings.into_iter().for_each(|warning| self.record(warning));
        Some((output.body, output.added))
    }

    fn record(&mut self, message: String) { *self.losses.entry(message).or_default() += 1; }

    /// A record written as another entity from source-derived facts
    /// (`StructuralLinks`, `StructuralVarying`, each armed only for its schema
    /// pair): the target body and the attribute values the rewrite dropped.
    pub(crate) fn rewrite(&mut self, id: u32, entity: &str, args: &[String]) -> Option<(String, usize)> {
        if let Some((body, message)) = self.values.rewrite(id) {
            self.record(message.into());
            return Some((body, 0));
        }
        if let Some((body, axis_carried)) = self.axes.carriers.rewrite(id, entity, args) {
            if axis_carried {
                self.record("IFC4 Axis is written as IfcRelAssociatesProfileProperties.ProfileOrientation in the analysis model frame".into());
            }
            return Some((body, 0));
        }
        let cause = self.cause(id, entity);
        let rewritten = match self.links.link(entity, args) {
            Some(attrs) => Some((format!("IFCRELCONNECTSSTRUCTURALELEMENT({attrs})"), vec![LINK.to_string()], 0)),
            None => self.varying.rewrite(id, entity, args, cause.is_some()),
        };
        // Queue the relationship only once the varying rewrite has produced an IFC4 action.
        if crate::schema_structural_varying::StructuralVarying::is_varying(entity) && rewritten.is_none() {
            if self.carriers.names_reaction(id) {
                self.record(crate::schema_structural_carriers::CAUSED_BY_UNCONVERTED.into());
            }
        } else if let Some(message) = cause {
            self.record(message.into());
            self.carriers.write(id);
        }
        let (body, losses, dropped) = rewritten?;
        losses.into_iter().for_each(|loss| self.record(loss));
        Some((body, dropped))
    }

    /// The message for an action whose CausedBy a 'Causes' relationship holds, or None.
    pub(crate) fn cause(&self, id: u32, entity: &str) -> Option<&'static str> {
        if self.varying.stays_unconverted(id, entity) { None } else { self.carriers.cause(id) }
    }

    /// IFC2X3 -> IFC4: ids for the records the prepasses add, in the order the
    /// TypeScript twin allocates them while writing: per action in id order,
    /// its 'Causes' relationship, then its load configuration.
    pub(crate) fn allocate(&mut self, mut allocate: impl FnMut() -> Option<u32>) {
        let actions: BTreeSet<u32> = self.carriers.needs_ids().chain(self.varying.needs_ids()).collect();
        for action in actions {
            let configured = self.varying.plans(action);
            // A varying action that stays unconverted gets no relationship; a constant one does (#11354).
            let caused = self.carriers.needs_id(action, self.varying.converts(action));
            let relationship = if caused { let Some(id) = allocate() else { return }; Some(id) } else { None };
            // When only one id fits, converting the action takes priority over carrying CausedBy.
            let configuration = if configured { let Some(id) = allocate().or(relationship) else { return }; Some(id) } else { None };
            if let Some(id) = relationship.filter(|id| Some(*id) != configuration) { self.carriers.assign(action, id); }
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
