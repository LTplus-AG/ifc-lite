// SPDX-License-Identifier: MPL-2.0
//! Which records an export attributes to the exporting application, and the
//! histories it writes for them: one `ADDED` history for everything the plan
//! adds, made on first use, and one `MODIFIED` history per distinct original
//! history (not per object) for everything it rewrites.
//!
//! What counts as modified is the plan's own scope, read once after every
//! rewrite has settled ([`modified_records`]): the objects it patches, the
//! rewritten records that carry an owner history, and the set of a value
//! edited in place.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use ifc_lite_core::SchemaFamily;

use crate::step_ids::IdAllocator;
use crate::step_text::attribute_of;

use super::attrs::attribute_index;
use super::identity::{Identity, Made, Original};
use super::index::FileIndex;
use super::props_lookup::container_names;
use super::props_synth;
use super::types::{ExportPlan, PlanContext, PsetKind, ValidationFinding};

/// The exporting application and the records the plan has written for it.
pub(crate) struct Ledger {
    pub(crate) identity: Identity,
    pub(crate) made: Made,
    modified: HashMap<u32, u32>,
}

impl Ledger {
    /// The plan's ledger, or none when it names no application or an
    /// unusable one (reported in `findings`; the source's attribution stays).
    pub(crate) fn for_plan(plan: &ExportPlan, findings: &mut Vec<ValidationFinding>) -> Option<Self> {
        let identity = match Identity::resolve(plan.context.application.as_ref()?, findings) {
            Ok(identity) => identity,
            Err(message) => {
                findings.push(ValidationFinding::new(None, message));
                return None;
            }
        };
        Some(Self { identity, made: Made::default(), modified: HashMap::new() })
    }

    /// The `MODIFIED` history standing in for `original`, one per original.
    fn modified(&mut self, source: (&FileIndex, &HashSet<u32>), schema: &str, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>, original_id: u32, original: &Original) -> Option<u32> {
        if let Some(&id) = self.modified.get(&original_id) {
            return Some(id);
        }
        let chain = self.identity.chain_in(schema, ids, Some(source), &mut self.made, appended)?;
        let id = ids.allocate()?;
        appended.push((id, self.identity.modified_history(schema, id, chain, original)));
        self.modified.insert(original_id, id);
        Some(id)
    }
}

/// Where the owner history of a record the plan adds comes from, one for
/// the patches and the Adds alike: the exporting application's `ADDED`
/// history, else the file's (or one settled earlier) if the plan keeps it,
/// else one synthesized (see [`super::owner_history::synthesize`]). Taking
/// one is not yet using it: only a write that succeeds [`Self::commit`]s
/// what it took, so a refused write leaves nothing behind and a plan that
/// adds nothing writes none. A batch of writes discarded together goes
/// back to a [`Self::snapshot`].
pub(crate) struct Histories<'l> {
    index: &'l FileIndex<'l>,
    schema: &'l str,
    kind: HistoryKind<'l>,
    /// The history committed so far.
    id: Option<u32>,
}

enum HistoryKind<'l> {
    /// Commits land in the ledger's [`Made`].
    Attributed(&'l mut Ledger),
    Source(&'l PlanContext),
}

/// A history taken for one write: the records to write with the write if
/// the history has none yet, and what committing it settles.
pub(crate) struct Taken {
    pub(crate) records: Vec<(u32, String)>,
    pub(crate) settles: Settles,
}

/// What a committed [`Taken`] settles: the history the write names, and
/// the exporting application's records then written.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Settles {
    pub(crate) id: u32,
    made: Made,
}

/// What [`Histories`] had committed at one point, to go back to.
#[derive(Clone, Copy)]
pub(crate) struct Snapshot {
    id: Option<u32>,
    made: Option<Made>,
}

impl Taken {
    /// A history that already exists: nothing to write.
    #[cfg(test)]
    pub(crate) fn existing(id: u32) -> Self {
        Self { records: Vec::new(), settles: Settles { id, made: Made::default() } }
    }
}

impl<'l> Histories<'l> {
    /// With `ledger`, the exporting application's; else the file's first
    /// owner history, or one synthesized from `context`.
    pub(crate) fn new(index: &'l FileIndex<'l>, schema: &'l str, ledger: Option<&'l mut Ledger>, context: &'l PlanContext) -> Self {
        let (kind, id) = match ledger {
            Some(ledger) => {
                let id = ledger.made.added();
                (HistoryKind::Attributed(ledger), id)
            }
            None => (HistoryKind::Source(context), index.first_owner_history),
        };
        Self { index, schema, kind, id }
    }

    /// The history one write names, and the records it must write with it.
    /// Records `removed` holds are neither named nor reused.
    pub(crate) fn take(&self, ids: &mut IdAllocator, removed: &HashSet<u32>) -> Option<Taken> {
        let source = Some((self.index, removed));
        match &self.kind {
            HistoryKind::Attributed(ledger) => {
                let (mut made, mut records) = (ledger.made, Vec::new());
                let id = ledger.identity.added_in(self.schema, ids, source, &mut made, &mut records)?;
                Some(Taken { records, settles: Settles { id, made } })
            }
            HistoryKind::Source(context) => {
                let (records, id) = match self.settled(removed) {
                    Some(id) => (Vec::new(), id),
                    None => super::owner_history::synthesize(self.schema, ids, context, source)?,
                };
                Some(Taken { records, settles: Settles { id, made: Made::default() } })
            }
        }
    }

    /// A write that took `settles` succeeded: what it took is the plan's.
    pub(crate) fn commit(&mut self, settles: Settles) {
        if let HistoryKind::Attributed(ledger) = &mut self.kind {
            ledger.made = settles.made;
        }
        self.id = Some(settles.id);
    }

    /// What is committed now.
    pub(crate) fn snapshot(&self) -> Snapshot {
        let made = match &self.kind {
            HistoryKind::Attributed(ledger) => Some(ledger.made),
            HistoryKind::Source(_) => None,
        };
        Snapshot { id: self.id, made }
    }

    /// Forget what was committed since `snapshot`.
    pub(crate) fn restore(&mut self, snapshot: Snapshot) {
        if let (HistoryKind::Attributed(ledger), Some(made)) = (&mut self.kind, snapshot.made) {
            ledger.made = made;
        }
        self.id = snapshot.id;
    }

    /// The history committed so far, unless the plan removes it.
    pub(crate) fn settled(&self, removed: &HashSet<u32>) -> Option<u32> {
        self.id.filter(|id| !removed.contains(id))
    }
}

/// Attribute the plan's settled rewrites: to the exporting application when
/// there is one ([`mark_modified`]); without one, a plan that patched or
/// added objects, or modified records an application would attribute
/// ([`modified_records`], which includes a relationship a delete rewrites),
/// is reported, since the file then credits those changes to their previous
/// author. A removed record itself is attributed to no one either way. A plan that named
/// an application `Ledger::for_plan` could not use has been reported already.
pub(crate) fn attribute_changes(index: &FileIndex, schema: &str, plan: &ExportPlan, ledger: Option<&mut Ledger>, (patched, removed): (&[u32], &HashSet<u32>), changed: bool, mut out: Rewrites) {
    match ledger {
        Some(ledger) => {
            mark_modified(index, schema, ledger, patched, removed, &mut out);
            let reused = ledger.made.application().filter(|&app| index.contains(app));
            if let Some(message) = reused.and_then(|app| super::identity::reuse_note(index, schema, app, &ledger.identity)) {
                out.findings.push(ValidationFinding { express_id: reused, message });
            }
        }
        None => {
            let unattributed = || changed || !modified_records(index, schema, patched, out.edits_by_id, removed).is_empty();
            if plan.context.application.is_none() && unattributed() {
                out.findings.push(ValidationFinding {
                    express_id: None,
                    message: "no ExportingApplication supplied: added objects are attributed to the source's first owner history (or a placeholder one), and modified objects keep their original owner history, so the file credits this export's changes to their previous author".into(),
                });
            }
        }
    }
}

/// The records a plan modified, by its own scope: every object it patches,
/// every source record it rewrites that carries an `OwnerHistory` (a
/// relationship, a property or quantity set, a type), and the property or
/// quantity set listing a value it edits in place, one level up and no
/// further. Nothing else is attributed: a rewrite of a record that is
/// neither (a material, a shape, a placement record) is the patched
/// object's change or nobody's. Records going away are not among them.
fn modified_records(index: &FileIndex, schema: &str, patched: &[u32], edits_by_id: &HashMap<u32, BTreeMap<usize, String>>, removed: &HashSet<u32>) -> BTreeSet<u32> {
    let live = |id: &u32| index.contains(*id) && !removed.contains(id);
    let carries = |id: &u32| index.type_of(*id).is_some_and(|ty| attribute_index(schema, &ty, "OwnerHistory").is_some());
    let mut modified: BTreeSet<u32> = patched.iter().copied().filter(|id| live(id) && carries(id)).collect();
    // The set or element quantity whose member list names a value.
    let lists = |set: u32, slot: usize| {
        [PsetKind::Property, PsetKind::Quantity].into_iter().any(|kind| {
            let (container, members) = container_names(kind);
            index.type_of(set).as_deref() == Some(container) && attribute_index(schema, container, members) == Some(slot)
        })
    };
    // Only a property or quantity value is looked up: its referrers are
    // collected already (an in-place edit checks the value is not shared), so
    // this costs no pass over the file.
    let is_value = |id: &u32| index.type_of(*id).is_some_and(|ty| props_synth::is_value_entity(&ty));
    for id in edits_by_id.keys().filter(|id| live(id)) {
        if carries(id) {
            modified.insert(*id);
        } else if is_value(id) {
            modified.extend(index.referrers(*id).iter().filter(|&&(set, slot)| live(&set) && lists(set, slot)).map(|&(set, _)| set));
        }
    }
    modified
}

/// The edits and records resolution has produced, which marking adds to.
pub(crate) struct Rewrites<'a> {
    pub(crate) ids: &'a mut IdAllocator,
    pub(crate) appended: &'a mut Vec<(u32, String)>,
    pub(crate) edits_by_id: &'a mut HashMap<u32, BTreeMap<usize, String>>,
    pub(crate) findings: &'a mut Vec<ValidationFinding>,
}

/// Point every record the plan modified ([`modified_records`]) at a `MODIFIED`
/// history keeping its original owner, state and creation date. Run once,
/// after every patch, delete and Add has settled its edits.
fn mark_modified(index: &FileIndex, schema: &str, ledger: &mut Ledger, patched: &[u32], removed: &HashSet<u32>, out: &mut Rewrites) {
    let required = SchemaFamily::of_file_schema(schema) == Some(SchemaFamily::Ifc2x3);
    let mut originals: HashMap<u32, Option<Original>> = HashMap::new();
    for id in modified_records(index, schema, patched, out.edits_by_id, removed) {
        let Some(ty) = index.type_of(id) else { continue };
        let Some(slot_idx) = attribute_index(schema, &ty, "OwnerHistory") else { continue };
        let Some(line) = index.raw_line(id) else { continue };
        let slot = attribute_of(&line, slot_idx).unwrap_or_default();
        let report = |message: String| ValidationFinding { express_id: Some(id), message };
        let Some(original_id) = ifc_lite_core::parser::parse_ref(slot.trim().as_bytes()) else {
            // Optional in IFC4: the file never recorded an author for this
            // object, and none is invented. IFC2X3 requires one.
            if slot.trim() != "$" || required {
                out.findings.push(report(format!("modified {ty} has no owner history{}; the modification is not recorded on it", if required { ", which IFC2X3 requires" } else { "" })));
            }
            continue;
        };
        // One parse per original history, however many records name it.
        let Some(original) = originals.entry(original_id).or_insert_with(|| original_of(index, schema, original_id)) else {
            out.findings.push(report(format!("modified {ty} names #{original_id}, which is not an IfcOwnerHistory; the modification is not recorded on it")));
            continue;
        };
        if matches!(original.state.as_str(), ".READONLY." | ".READONLYLOCKED." | ".LOCKED." | ".READWRITELOCKED.") {
            out.findings.push(report(format!(
                "modified {ty} is marked {} by its owner history; it is written as edited and keeps that state",
                original.state
            )));
        }
        let Some(new) = ledger.modified((index, removed), schema, out.ids, out.appended, original_id, original) else {
            out.findings.push(report("id space exhausted: the modification is not recorded".into()));
            continue;
        };
        out.edits_by_id.entry(id).or_default().insert(slot_idx, format!("#{new}"));
    }
}

fn original_of(index: &FileIndex, schema: &str, id: u32) -> Option<Original> {
    if index.type_of(id)? != "IFCOWNERHISTORY" {
        return None;
    }
    let line = index.raw_line(id)?;
    let attr = |name: &str| -> String {
        attribute_index(schema, "IFCOWNERHISTORY", name)
            .and_then(|i| attribute_of(&line, i))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "$".into())
    };
    Some(Original {
        user: attr("OwningUser"),
        application: attr("OwningApplication"),
        state: attr("State"),
        creation_date: attr("CreationDate"),
    })
}
