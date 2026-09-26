// SPDX-License-Identifier: MPL-2.0
//! The state one export shares across its phases (`ExportPass`), and the
//! predicates the phases must agree on (`willBeEmitted`,
//! `hasEmittableHostBytes`, `isOverlayCreated`).
//!
//! Everything the header's modification count depends on is decided here,
//! BEFORE a byte is written: the TypeScript exporter assembles the file in
//! memory and writes the header last, and a streaming writer cannot. So the
//! lines the log changes (a handful, proportional to the edits) are computed
//! up front and held; every other record streams through untouched.

use std::collections::{HashMap, HashSet};

use super::ledger::{Delivery, Ledger, Nominees};
use super::overlay::Overlay;
use super::source::Source;

pub(crate) struct Pass<'s, 'a> {
    pub(crate) src: &'s Source<'a>,
    /// Source schema family (`IFC2X3` / `IFC4` / `IFC4X3` / `IFC5`).
    pub(crate) schema: &'static str,
    pub(crate) overlay: Overlay,
    pub(crate) ledger: Ledger,
    pub(crate) nominees: Nominees,
    /// Named attribute edits per entity, in the overlay's order.
    pub(crate) modified_attributes: Vec<(u32, Vec<(String, String)>)>,
    attribute_slot: HashMap<u32, usize>,
    pub(crate) skip: HashSet<u32>,
    /// Type objects whose line is written after the generated sets.
    pub(crate) rewritten: HashSet<u32>,
    pub(crate) rewritten_lines: Vec<(u32, String)>,
    pub(crate) type_owned_names: Vec<(u32, Vec<String>)>,
    pub(crate) type_owned_ids: HashMap<u32, Vec<u32>>,
    pub(crate) generated: Vec<String>,
    pub(crate) new_entity_count: usize,
    /// Source lines the log rewrites, with what each carries.
    pub(crate) mutated_lines: HashMap<u32, (String, Delivery)>,
    pub(crate) warnings: Vec<String>,
    pub(crate) next_id: u32,
    owner_history_of: HashMap<u32, Option<u32>>,
    owner_history_fallback: Option<Option<u32>>,
}

impl<'s, 'a> Pass<'s, 'a> {
    pub(crate) fn new(src: &'s Source<'a>, schema: &'static str, overlay: Overlay) -> Self {
        Pass {
            src,
            schema,
            overlay,
            ledger: Ledger::default(),
            nominees: Nominees::default(),
            modified_attributes: Vec::new(),
            attribute_slot: HashMap::new(),
            skip: HashSet::new(),
            rewritten: HashSet::new(),
            rewritten_lines: Vec::new(),
            type_owned_names: Vec::new(),
            type_owned_ids: HashMap::new(),
            generated: Vec::new(),
            new_entity_count: 0,
            mutated_lines: HashMap::new(),
            warnings: Vec::new(),
            next_id: src.max_id.saturating_add(1),
            owner_history_of: HashMap::new(),
            owner_history_fallback: None,
        }
    }

    /// `allocateExpressId`.
    pub(crate) fn allocate(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    pub(crate) fn is_overlay_created(&self, _id: u32) -> bool {
        false
    }

    pub(crate) fn is_deleted(&self, _id: u32) -> bool {
        false
    }

    /// The effective UPPERCASE type (`effective.typeOf`).
    pub(crate) fn type_of(&self, id: u32) -> Option<String> {
        if self.is_deleted(id) {
            return None;
        }
        self.src.type_of(id)
    }

    /// `willBeEmitted` for a full export.
    pub(crate) fn will_be_emitted(&self, id: u32) -> bool {
        !self.is_deleted(id) && (self.is_overlay_created(id) || self.src.has(id))
    }

    /// `hasEmittableHostBytes` for a full export.
    pub(crate) fn has_emittable_host_bytes(&self, id: u32) -> bool {
        !self.is_deleted(id) && self.src.has(id)
    }

    fn is_written_owner_history(&self, id: u32) -> bool {
        self.will_be_emitted(id) && self.type_of(id).as_deref() == Some("IFCOWNERHISTORY")
    }

    /// `resolveFallbackOwnerHistoryRef`.
    pub(crate) fn fallback_owner_history(&mut self) -> Option<u32> {
        if let Some(cached) = self.owner_history_fallback {
            return cached;
        }
        let found = self
            .src
            .of_type("IFCOWNERHISTORY")
            .iter()
            .copied()
            .find(|&id| self.is_written_owner_history(id));
        self.owner_history_fallback = Some(found);
        found
    }

    /// `resolveOwnerHistoryRef`: the host's own owner history when this export
    /// writes it, else the fallback, else `$`.
    pub(crate) fn owner_history_token(&mut self, host: u32) -> String {
        let own = match self.owner_history_of.get(&host) {
            Some(cached) => *cached,
            None => {
                let found = self.src.line(host).and_then(|l| super::readers::owner_history_ref(&l));
                self.owner_history_of.insert(host, found);
                found
            }
        };
        if let Some(id) = own.filter(|&id| self.is_written_owner_history(id)) {
            return format!("#{id}");
        }
        self.fallback_owner_history().map_or_else(|| "$".to_string(), |id| format!("#{id}"))
    }

    /// Queue named attribute edits for `id` (`pass.modifiedAttributes`).
    pub(crate) fn queue_attributes(&mut self, id: u32, edits: &[(String, String)]) {
        let slot = match self.attribute_slot.get(&id) {
            Some(&slot) => slot,
            None => {
                self.modified_attributes.push((id, Vec::new()));
                self.attribute_slot.insert(id, self.modified_attributes.len() - 1);
                self.modified_attributes.len() - 1
            }
        };
        let target = &mut self.modified_attributes[slot].1;
        for (name, value) in edits {
            match target.iter_mut().find(|(n, _)| n == name) {
                Some(entry) => entry.1 = value.clone(),
                None => target.push((name.clone(), value.clone())),
            }
        }
    }

    /// Named attribute edits queued for `id`.
    pub(crate) fn attribute_edits(&self, id: u32) -> Option<&[(String, String)]> {
        self.attribute_slot.get(&id).map(|&slot| self.modified_attributes[slot].1.as_slice())
    }

    /// `applySourceLineMutations` over the record's own text, reporting a
    /// REAL-slot refusal the way `applySourceLineMutationsReported` does.
    pub(crate) fn mutate_line(&mut self, id: u32, text: &str) -> (String, Delivery) {
        let Some(edits) = self.attribute_edits(id).map(<[_]>::to_vec) else {
            return (text.to_string(), Delivery::default());
        };
        let upper = self.src.type_of(id).unwrap_or_default();
        let (out, rejected) = super::attrs::apply_named(text, &upper, &edits, self.schema);
        for (attr, value) in rejected {
            self.warnings.push(format!(
                "entity #{id}: attribute {attr} not written - {} is not a number and the slot is REAL-typed",
                serde_json::Value::String(value)
            ));
        }
        let attributed = out != text;
        if !attributed && !super::attrs::argument_list_scans(text) {
            self.warnings.push(unreadable_warning(id, &upper));
        }
        (out, Delivery { attributed, ..Delivery::default() })
    }
}

/// `unreadableRecordEditsDroppedWarning`.
fn unreadable_warning(id: u32, upper: &str) -> String {
    format!(
        "Entity #{id} ({upper}): its argument list could not be read as a list of attributes, so every edit queued for it (attribute, retype and positional alike) was dropped rather than applied to a slot that may not be the one meant. The usual cause is an apostrophe inside a string attribute that was not doubled."
    )
}
