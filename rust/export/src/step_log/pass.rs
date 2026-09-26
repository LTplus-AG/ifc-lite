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
    /// A created type object's repointed `HasPropertySets`, applied as a slot
    /// override when the created entity is written (`overlayTypeOwnedPsets`).
    pub(crate) overlay_type_owned: Vec<(u32, serde_json::Value)>,
    /// The created entities' lines, in `newEntities` order.
    pub(crate) created_lines: Vec<(u32, String)>,
    pub(crate) new_entity_count: usize,
    /// Source lines the log rewrites, with what each carries.
    pub(crate) mutated_lines: HashMap<u32, (Option<String>, Delivery)>,
    pub(crate) warnings: Vec<String>,
    pub(crate) next_id: u32,
    owner_history_of: HashMap<u32, Option<u32>>,
    owner_history_fallback: Option<Option<u32>>,
}

impl<'s, 'a> Pass<'s, 'a> {
    pub(crate) fn new(src: &'s Source<'a>, schema: &'static str, overlay: Overlay) -> Self {
        let next_allocated = overlay.next_allocated;
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
            overlay_type_owned: Vec::new(),
            created_lines: Vec::new(),
            new_entity_count: 0,
            mutated_lines: HashMap::new(),
            warnings: Vec::new(),
            next_id: src.max_id.max(next_allocated).saturating_add(1),
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

    pub(crate) fn is_overlay_created(&self, id: u32) -> bool {
        self.overlay.is_created(id)
    }

    pub(crate) fn is_deleted(&self, id: u32) -> bool {
        self.overlay.tombstones.contains(&id)
    }

    /// `effective.has`: a live record, source or created.
    pub(crate) fn has(&self, id: u32) -> bool {
        !self.is_deleted(id) && (self.is_overlay_created(id) || self.src.has(id))
    }

    /// The record's own class before any retype: the created payload's, or
    /// the source line's.
    pub(crate) fn record_type(&self, id: u32) -> Option<String> {
        match self.overlay.created(id) {
            Some(e) => Some(e.entity_type.to_uppercase()),
            None => self.src.type_of(id),
        }
    }

    /// The effective UPPERCASE type (`effective.typeOf`).
    pub(crate) fn type_of(&self, id: u32) -> Option<String> {
        if !self.has(id) {
            return None;
        }
        match self.overlay.retypes.get(&id) {
            Some((t, _)) => Some(t.to_uppercase()),
            None => self.record_type(id),
        }
    }

    /// `willBeEmitted` for a full export.
    pub(crate) fn will_be_emitted(&self, id: u32) -> bool {
        self.has(id)
    }

    /// `hasEmittableHostBytes` for a full export.
    pub(crate) fn has_emittable_host_bytes(&self, id: u32) -> bool {
        self.has(id) && !self.is_overlay_created(id)
    }

    /// `isOmittedFromOutput`: a record the effective index knows (or deleted)
    /// that this export does not write.
    pub(crate) fn is_omitted(&self, id: u32) -> bool {
        (self.has(id) || self.is_deleted(id)) && !self.will_be_emitted(id)
    }

    /// `effective.byType.get(type)`: source ids of a tracked type without the
    /// deleted and retyped-away ones, then created ids of that effective type,
    /// then source ids retyped into it.
    pub(crate) fn of_type(&self, upper: &str) -> Vec<u32> {
        let mut out: Vec<u32> = self
            .src
            .of_type(upper)
            .iter()
            .copied()
            .filter(|&id| {
                !self.is_deleted(id)
                    && self.overlay.retypes.get(&id).is_none_or(|(t, _)| t.to_uppercase() == upper)
            })
            .collect();
        for e in &self.overlay.new_entities {
            if self.type_of(e.express_id).as_deref() == Some(upper) {
                out.push(e.express_id);
            }
        }
        for &id in &self.overlay.retype_order {
            let target = self.overlay.retypes[&id].0.to_uppercase();
            if !self.is_overlay_created(id)
                && !self.is_deleted(id)
                && self.src.has(id)
                && target == upper
                && self.src.type_of(id).as_deref() != Some(upper)
            {
                out.push(id);
            }
        }
        out
    }

    fn is_written_owner_history(&self, id: u32) -> bool {
        self.will_be_emitted(id) && self.type_of(id).as_deref() == Some("IFCOWNERHISTORY")
    }

    /// `resolveFallbackOwnerHistoryRef`.
    pub(crate) fn fallback_owner_history(&mut self) -> Option<u32> {
        if let Some(cached) = self.owner_history_fallback {
            return cached;
        }
        let found = self.of_type("IFCOWNERHISTORY").into_iter().find(|&id| self.is_written_owner_history(id));
        self.owner_history_fallback = Some(found);
        found
    }

    /// `resolveOwnerHistoryRef`: the host's own owner history when this export
    /// writes it, else the fallback, else `$`.
    pub(crate) fn owner_history_token(&mut self, host: u32) -> String {
        let own = match self.owner_history_of.get(&host) {
            Some(cached) => *cached,
            None => {
                let found = match self.overlay.created(host) {
                    Some(created) => {
                        let authored = created.attributes.get(1).cloned().unwrap_or(serde_json::Value::Null);
                        let value = self.overlay_slot(host, 1, authored);
                        super::refs::authored_refs(&value).first().copied()
                    }
                    None => self.src.line(host).and_then(|l| super::readers::owner_history_ref(&l)),
                };
                self.owner_history_of.insert(host, found);
                found
            }
        };
        if let Some(id) = own.filter(|&id| self.is_written_owner_history(id)) {
            return format!("#{id}");
        }
        self.fallback_owner_history().map_or_else(|| "$".to_string(), |id| format!("#{id}"))
    }

    /// `overlaySlotValue`: a created entity's authored slot, unless a
    /// positional edit replaced it.
    pub(crate) fn overlay_slot(&self, id: u32, slot: usize, authored: serde_json::Value) -> serde_json::Value {
        match self.overlay.positionals(id).iter().find(|(i, _)| *i == slot) {
            Some((_, v)) => v.clone(),
            None => authored,
        }
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

    /// `applySourceLineMutations` over a source record's text: retype, then
    /// named edits against the (new) class, then positional edits. Reports a
    /// REAL-slot refusal and an unreadable argument list the way
    /// `applySourceLineMutationsReported` does. `Err` is a positional value no
    /// STEP spelling exists for, which fails the TypeScript export too.
    pub(crate) fn mutate_line(&mut self, id: u32, text: &str) -> Result<(String, Delivery), super::values::Unwritable> {
        let record_type = self.src.type_of(id).unwrap_or_default();
        let retype = self.overlay.retypes.get(&id).cloned();
        let edits = self.attribute_edits(id).map(<[_]>::to_vec);
        let positionals = self.overlay.positionals(id).to_vec();
        let mut out = text.to_string();
        let mut delivery = Delivery::default();
        let mut working = record_type.clone();
        if let Some((new_type, predefined)) = &retype {
            let retyped = super::retype::retype_line(&out, &record_type, new_type, predefined.as_deref(), self.schema);
            delivery.retyped = retyped != out;
            out = retyped;
            working = new_type.to_uppercase();
        }
        if let Some(edits) = edits.as_ref().filter(|e| !e.is_empty()) {
            let (named, rejected) = super::attrs::apply_named(&out, &working, edits, self.schema);
            for (attr, value) in rejected {
                self.warnings.push(format!(
                    "entity #{id}: attribute {attr} not written - {} is not a number and the slot is REAL-typed",
                    serde_json::Value::String(value)
                ));
            }
            delivery.attributed = named != out;
            out = named;
        }
        if !positionals.is_empty() {
            let edited = super::attrs::apply_positional(&out, &working, &positionals, self.schema)?;
            delivery.positional = edited != out;
            out = edited;
        }
        let requested = retype.is_some() || edits.is_some_and(|e| !e.is_empty()) || !positionals.is_empty();
        if requested
            && !delivery.attributed
            && !delivery.retyped
            && !delivery.positional
            && !super::attrs::argument_list_scans(text)
        {
            self.warnings.push(unreadable_warning(id, &record_type));
        }
        Ok((out, delivery))
    }
}

/// `unreadableRecordEditsDroppedWarning`.
fn unreadable_warning(id: u32, upper: &str) -> String {
    format!(
        "Entity #{id} ({upper}): its argument list could not be read as a list of attributes, so every edit queued for it (attribute, retype and positional alike) was dropped rather than applied to a slot that may not be the one meant. The usual cause is an apostrophe inside a string attribute that was not doubled."
    )
}
