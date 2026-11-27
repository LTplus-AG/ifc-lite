// SPDX-License-Identifier: MPL-2.0
//! Enum-member reconciliation on schema conversion (#5365), the Rust twin of
//! `packages/export/src/schema-converter-enums.ts`.
//!
//! `convert_step_line` renamed entities and reconciled attribute counts, but
//! never read an enum VALUE, so a member the target schema does not define
//! (`.TURNSTILE.` into IFC4, `.LOUVRE.` into IFC2X3) rode into a file whose
//! header declares that schema. This reads every enum-typed slot the generated
//! table lists for the target and resolves a missing member by the policy in
//! `schema-enum-policy.ts` (the table carries its decision):
//! `.USERDEFINED.` with the member name in the label slot, else `.NOTDEFINED.`,
//! else `$` for an optional attribute, else refused (kept, reported). It never
//! invents a member, and it counts every outcome that loses information.
//!
//! [`ConversionChecks`] bundles this with the IFC4 required-slot count, so an
//! exporter threads one object through `convert_step_line`.

use crate::generated::enum_reconciliation::{
    EnumEntityRow, EnumOutcome, IFC2X3_ENUM_SLOTS, IFC4X3_ENUM_SLOTS, IFC4_ENUM_SLOTS,
};
use crate::schema_ifc4_slots::Ifc4SlotCheck;
use crate::schema_userdefined_label::is_unset;
use crate::step_slot::split_top_level_args;
use std::collections::BTreeMap;

/// Outcomes that lose the source's meaning, or keep an invalid value.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Loss {
    LabelOccupied,
    NotDefined,
    Omit,
    Refuse,
}

impl Loss {
    fn text(self) -> &'static str {
        match self {
            Loss::LabelOccupied => "written as .USERDEFINED. but the label slot already held a value, so the member name was not kept",
            Loss::NotDefined => "written as .NOTDEFINED.",
            Loss::Omit => "written as $ (the attribute is optional in the target)",
            Loss::Refuse => "KEPT as written, so the file is not valid against its header; the target schema offers no value for it",
        }
    }
}

/// Enum reconciliation for one export: rewrites, and counts what it lost.
#[derive(Default)]
pub(crate) struct EnumReconciliation {
    losses: BTreeMap<Loss, BTreeMap<String, usize>>,
    /// Records written `.USERDEFINED.` with the label their rule needs unset, per type (#10780).
    unlabelled: BTreeMap<String, usize>,
}

impl EnumReconciliation {
    /// Reconcile `line`, already converted to the canonical schema `to`.
    pub(crate) fn apply(&mut self, line: String, to: &str) -> String {
        let line = self.reconcile(&line, to).unwrap_or(line);
        self.check_user_defined(&line, to);
        line
    }

    /// Values that lost information (label occupied, `.NOTDEFINED.`, `$`).
    pub(crate) fn lost(&self) -> usize {
        [Loss::LabelOccupied, Loss::NotDefined, Loss::Omit].iter().map(|l| self.count(*l)).sum()
    }

    /// Values kept as written because the target offers nothing valid,
    /// including a `.USERDEFINED.` with no label (#10780).
    pub(crate) fn refused(&self) -> usize {
        self.count(Loss::Refuse) + self.unlabelled.values().sum::<usize>()
    }

    /// Count `line` when it says `.USERDEFINED.` without the label its type's
    /// rule requires in `to` (#10780). Nothing is written: no label is invented.
    fn check_user_defined(&mut self, line: &str, to: &str) {
        // Only a record that says USERDEFINED can break the rule; the rest stop here.
        if !line.as_bytes().windows(13).any(|w| w.eq_ignore_ascii_case(b".USERDEFINED.")) { return; }
        let Some((ty, args)) = crate::step_log::read_slots(line) else { return };
        if crate::schema_userdefined::rule(to, &ty).is_some_and(|rule| crate::schema_userdefined::breaks(&args, rule)) {
            *self.unlabelled.entry(ty).or_insert(0) += 1;
        }
    }

    /// One warning per loss kind, naming what it happened to. Same text as
    /// the TypeScript twin's.
    pub(crate) fn warnings(&self) -> Vec<String> {
        let unlabelled = (!self.unlabelled.is_empty()).then(|| {
            let total: usize = self.unlabelled.values().sum();
            let names: Vec<&str> = self.unlabelled.keys().map(String::as_str).collect();
            format!(
                "{total} record(s) say .USERDEFINED. without the label their rule needs; none is invented: {} (#10780).",
                names.join(", ")
            )
        });
        self.losses
            .iter()
            .map(|(loss, where_)| {
                // Every site is named: distinct sites are bounded by the ledger.
                let total: usize = where_.values().sum();
                let names: Vec<&str> = where_.keys().map(String::as_str).collect();
                format!(
                    "{total} enum value(s) the target schema does not define were {}: {} (#5365).",
                    loss.text(),
                    names.join(", ")
                )
            })
            .chain(unlabelled)
            .collect()
    }

    fn count(&self, loss: Loss) -> usize {
        self.losses.get(&loss).map_or(0, |m| m.values().sum())
    }

    fn record(&mut self, loss: Loss, where_: String) {
        *self.losses.entry(loss).or_default().entry(where_).or_insert(0) += 1;
    }

    /// `None` when the line is left exactly as it is.
    fn reconcile(&mut self, line: &str, to: &str) -> Option<String> {
        let table: &[EnumEntityRow] = match to {
            "IFC2X3" => IFC2X3_ENUM_SLOTS,
            "IFC4" => IFC4_ENUM_SLOTS,
            "IFC4X3" => IFC4X3_ENUM_SLOTS,
            _ => return None,
        };
        let open = line.find('(')?;
        let close = line.rfind(')').filter(|&c| c > open)?;
        let eq = line.find('=').filter(|&e| e < open)?;
        let entity_type = line[eq + 1..open].trim().to_ascii_uppercase();
        let row = table.binary_search_by(|row| row.0.cmp(entity_type.as_str())).ok()?;
        let (_, arity, slots) = table[row];
        let mut values = split_top_level_args(&line[open + 1..close])?;
        if values.len() != usize::from(arity) {
            return None;
        }
        let mut changed = false;
        for &(index, attribute, members, outcome) in slots {
            let index = usize::from(index);
            let Some(member) = enum_member(&values[index]) else { continue };
            if members.iter().any(|m| m.eq_ignore_ascii_case(&member)) {
                continue;
            }
            let where_ = format!("{entity_type}.{attribute} .{member}.");
            match outcome {
                EnumOutcome::UserDefined(label) => {
                    values[index] = ".USERDEFINED.".to_string();
                    let label = &mut values[usize::from(label)];
                    if is_unset(label) {
                        *label = crate::step_text::quoted(&member);
                    } else {
                        self.record(Loss::LabelOccupied, where_);
                    }
                    changed = true;
                }
                EnumOutcome::NotDefined => {
                    values[index] = ".NOTDEFINED.".to_string();
                    self.record(Loss::NotDefined, where_);
                    changed = true;
                }
                EnumOutcome::Omit => {
                    values[index] = "$".to_string();
                    self.record(Loss::Omit, where_);
                    changed = true;
                }
                EnumOutcome::Refuse => self.record(Loss::Refuse, where_),
            }
        }
        changed.then(|| format!("{}{}{}", &line[..=open], values.join(","), &line[close..]))
    }
}

/// The member of an enum token `.X.`, uppercased; `None` for anything else.
fn enum_member(slot: &str) -> Option<String> {
    let inner = slot.trim().strip_prefix('.')?.strip_suffix('.')?;
    (!inner.is_empty() && inner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .then(|| inner.to_ascii_uppercase())
}

/// The per-export checks `convert_step_line` reports into: the IFC4
/// required-slot count (#5307) and enum reconciliation (#5365); plus the
/// per-type conversion plans and the values a conversion had no target slot
/// for (#7683).
///
/// Built only by [`ConversionChecks::new`], which takes the export's material
/// referents (#10763), so no converter holds checks that cannot resolve them.
#[cfg_attr(test, derive(Default))]
pub(crate) struct ConversionChecks {
    pub(crate) structural: crate::schema_structural_diagnostics::StructuralDiagnostics,
    pub(crate) ifc4_slots: Ifc4SlotCheck,
    pub(crate) enums: EnumReconciliation,
    /// The IfcDocumentInformation <-> IfcDocumentReference link (#10846).
    pub(crate) documents: crate::schema_document_links::DocumentLinks,
    /// Values a target slot's type cannot hold (#10847).
    pub(crate) forms: crate::schema_value_forms::ValueForms,
    /// The IfcMaterial a downgraded IfcMaterialProperties names (#10763).
    pub(crate) materials: crate::schema_material_referent::MaterialReferents,
    pub(crate) typed_properties: crate::schema_typed_properties::TypedPropertyUpgrade,
    /// `convert_record`'s per-type decisions, resolved once per distinct type.
    pub(crate) plans: crate::schema_plan::PlanCache,
    pub(crate) merged: bool,
    /// Non-`$` source values the converted record has no slot for (#7683):
    /// a trimmed tail, an alignment proxy's attributes past IfcProduct's, and
    /// by-name remap sources with no same-named target attribute.
    pub(crate) attribute_values_dropped: usize,
    upgrade_omissions: Vec<String>,
}

// One implementation of the deferred conversion pass for plain and mutation-log writers.
type DeferredHeader<'a> = dyn FnMut(&mut dyn std::io::Write, usize, &std::collections::HashSet<u32>) -> std::io::Result<()> + 'a;

impl ConversionChecks {
    /// The checks for one export, with the material records it writes.
    pub(crate) fn new(materials: crate::schema_material_referent::MaterialReferents) -> Self {
        Self {
            structural: Default::default(),
            ifc4_slots: Default::default(),
            enums: Default::default(),
            documents: Default::default(),
            forms: Default::default(),
            materials,
            upgrade_omissions: Vec::new(),
            typed_properties: Default::default(),
            plans: Default::default(),
            merged: false,
            attribute_values_dropped: 0,
        }
    }

    /// Source-derived orientations, link types and varying actions are safe only
    /// for an unedited full export. `allocate` is the writer's express-id allocator.
    #[inline(never)]
    pub(crate) fn for_source(content: &[u8], from: &str, to: &str, opts: &crate::step_api::StepOptions, unchanged: bool, kept: &dyn Fn(u32, usize) -> bool, allocate: &mut dyn FnMut() -> Option<u32>) -> Self {
        let (from, to) = (crate::schema_convert::canon(from), crate::schema_convert::canon(to));
        // Read from the source's types alone, so it runs for every export (#10763).
        let mut checks = Self::new(crate::schema_material_referent::MaterialReferents::scan(content, from, to, !unchanged, kept));
        if !(unchanged && opts.included.is_none() && opts.attribute_mutations.is_empty() && opts.copy_on_write.is_empty()) {
            checks.structural.defer_varying = from == "IFC2X3" && to == "IFC4";
            return checks;
        }
        checks.documents = crate::schema_document_links::DocumentLinks::scan(content, from, to, kept);
        match (from, to) {
            ("IFC2X3", "IFC4") => {
                checks.structural.varying = crate::schema_structural_varying::StructuralVarying::scan_ifc2x3(content, kept);
                checks.structural.carriers = crate::schema_structural_carriers::StructuralCarriers::scan_ifc2x3(content, kept);
                checks.structural.allocate(&mut *allocate);
                checks.structural.axes = crate::schema_structural_axes::StructuralAxes::scan(content, kept, false, allocate);
                checks.structural.values = crate::schema_structural_values::StructuralValues::scan(content, kept, false, allocate);
            }
            ("IFC4", "IFC2X3") => {
                checks.structural.links = crate::schema_structural_links::StructuralLinks::scan(content, kept);
                checks.structural.varying = crate::schema_structural_varying::StructuralVarying::scan_ifc4(content, kept);
                checks.structural.carriers = crate::schema_structural_carriers::StructuralCarriers::scan_ifc4(content, kept);
                checks.structural.axes = crate::schema_structural_axes::StructuralAxes::scan(content, kept, true, allocate);
                checks.structural.values = crate::schema_structural_values::StructuralValues::scan(content, kept, true, allocate);
            }
            _ => {}
        }
        checks
    }

    /// Whether the writer leaves out this source record: a conversion consumed it.
    pub(crate) fn drops(&self, id: u32) -> bool {
        self.structural.varying.drops(id) || self.structural.axes.carriers.drops(id) || self.structural.values.drops(id)
    }

    /// Append the records a conversion created, then finish `body`; the change in record count.
    pub(crate) fn finish(
        &mut self,
        body: crate::schema_ifc2x3_body::Body<'_>,
        slots: Option<&mut crate::schema_ifc2x3_slots::Ifc2x3SlotFill>,
        ids: crate::step_ids::IdAllocator,
    ) -> std::io::Result<isize> {
        self.finish_with_header(body, slots, ids, &mut |_, _, _| Ok(())).map(|(delta, _)| delta)
    }

    /// Return the DATA record delta and the number of records minted by the deferred passes.
    pub(crate) fn finish_with_header(
        &mut self,
        mut body: crate::schema_ifc2x3_body::Body<'_>,
        mut slots: Option<&mut crate::schema_ifc2x3_slots::Ifc2x3SlotFill>,
        ids: crate::step_ids::IdAllocator,
        header: &mut DeferredHeader<'_>,
    ) -> std::io::Result<(isize, usize)> {
        use std::io::Write as _;
        let mut added = self.structural.added();
        added.extend(self.structural.values.added());
        added.extend(self.structural.axes.added());
        let count = added.len() as isize;
        for record in added {
            let record = match slots.as_deref_mut() {
                Some(slots) => slots.apply(record),
                None => record,
            };
            writeln!(body, "{record}")?;
        }
        // Varying actions mint ids above the final DATA ids, including typed properties.
        let typed_added = body.rewrite_held(|text| self.finish_typed_properties(text, || ids));
        let varying_ids = std::cell::RefCell::new(Vec::new());
        let surviving_deferred = std::cell::Cell::new(typed_added);
        let body_delta = body.finish_with_header(&mut |text| {
            let varying = self.structural.finish_effective_varying(text, &mut self.attribute_values_dropped)
                .map(|(text, ids)| { varying_ids.replace(ids); text });
            let added = varying_ids.borrow().len() as isize;
            let source = varying.as_deref().unwrap_or(text);
            match self.forms.finish_temporal_values(source, &mut self.attribute_values_dropped, &mut |ty| self.plans.forget_verbatim(ty)) {
                Some((body, delta)) => Some((body, added + delta)),
                None => varying.map(|body| (body, added)),
            }
        }, &mut |out, omitted| {
            let varying = varying_ids.borrow().iter().filter(|id| !omitted.contains(id)).count();
            // Typed properties reserve a contiguous range starting at the supplied allocator.
            let typed_removed = ids.peek().map_or(0, |first| omitted.iter()
                .filter(|id| id.checked_sub(first).is_some_and(|offset| (offset as usize) < typed_added)).count());
            surviving_deferred.set(typed_added - typed_removed + varying);
            header(out, varying, omitted)
        }, &mut self.upgrade_omissions)?;
        Ok((count + typed_added as isize + body_delta, surviving_deferred.get()))
    }

    pub(crate) fn finish_typed_properties(&mut self, text: &[u8], ids: impl FnOnce() -> crate::step_ids::IdAllocator) -> Option<(Vec<u8>, usize)> {
        self.typed_properties.finish(text, ids, &mut self.ifc4_slots, &mut self.attribute_values_dropped, &mut self.structural)
    }

    pub(crate) fn finish_temporal_values(&mut self, text: &mut String) -> isize {
        if let Some((rewritten, delta)) = self.forms.finish_temporal_values(text, &mut self.attribute_values_dropped, &mut |ty| self.plans.forget_verbatim(ty)) {
            *text = rewritten;
            delta
        } else {
            0
        }
    }

    /// Both checks' warnings, IFC4 slots first.
    pub(crate) fn warnings(&self) -> Vec<String> {
        let mut out = self.ifc4_slots.warnings();
        out.extend(self.enums.warnings());
        out.extend(self.documents.warnings());
        out.extend(self.forms.warnings());
        out.extend(self.materials.warnings());
        out.extend(self.structural.warnings());
        out.extend(self.plans.warnings());
        out.extend(self.upgrade_omissions.iter().cloned());
        out.extend(self.typed_properties.warning());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::enum_member;

    #[test]
    fn enum_member_reads_only_enum_tokens() {
        assert_eq!(enum_member(" .turnstile. ").as_deref(), Some("TURNSTILE"));
        assert_eq!(enum_member("$"), None);
        assert_eq!(enum_member("'.X.'"), None);
        assert_eq!(enum_member(".."), None);
    }
}
