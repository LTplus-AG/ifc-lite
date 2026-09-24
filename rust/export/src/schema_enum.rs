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
}

impl EnumReconciliation {
    /// Reconcile `line`, already converted to the canonical schema `to`.
    pub(crate) fn apply(&mut self, line: String, to: &str) -> String {
        self.reconcile(&line, to).unwrap_or(line)
    }

    /// Values that lost information (label occupied, `.NOTDEFINED.`, `$`).
    pub(crate) fn lost(&self) -> usize {
        [Loss::LabelOccupied, Loss::NotDefined, Loss::Omit].iter().map(|l| self.count(*l)).sum()
    }

    /// Values kept as written because the target offers nothing valid.
    pub(crate) fn refused(&self) -> usize {
        self.count(Loss::Refuse)
    }

    /// One warning per loss kind, naming what it happened to. Same text as
    /// the TypeScript twin's.
    pub(crate) fn warnings(&self) -> Vec<String> {
        self.losses
            .iter()
            .map(|(loss, where_)| {
                let total: usize = where_.values().sum();
                let mut names: Vec<&str> = where_.keys().map(String::as_str).take(10).collect();
                if where_.len() > 10 {
                    names.push("…");
                }
                format!(
                    "{total} enum value(s) the target schema does not define were {}: {} (#5365).",
                    loss.text(),
                    names.join(", ")
                )
            })
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
                    if label.trim() == "$" {
                        *label = format!("'{}'", crate::step_text::escape(&member));
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
/// required-slot count (#5307) and enum reconciliation (#5365).
#[derive(Default)]
pub(crate) struct ConversionChecks {
    pub(crate) ifc4_slots: Ifc4SlotCheck,
    pub(crate) enums: EnumReconciliation,
}

impl ConversionChecks {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Both checks' warnings, IFC4 slots first.
    pub(crate) fn warnings(&self) -> Vec<String> {
        let mut out = self.ifc4_slots.warnings();
        out.extend(self.enums.warnings());
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
