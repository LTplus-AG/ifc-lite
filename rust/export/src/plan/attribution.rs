// SPDX-License-Identifier: MPL-2.0
//! Which records an export attributes to the exporting application, and the
//! histories it writes for them: one `ADDED` history for everything the plan
//! adds, made on first use, and one `MODIFIED` history per distinct original
//! history (not per object) for everything it rewrites.
//!
//! What counts as modified is derived once, from what the plan actually
//! rewrites ([`rewritten_roots`]), not tracked at the sites that rewrite.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use ifc_lite_core::SchemaFamily;

use crate::step_ids::IdAllocator;
use crate::step_text::attribute_of;

use super::attrs::attribute_index;
use super::identity::{Identity, Made, Original};
use super::index::FileIndex;
use super::types::{ExportPlan, PlanContext, ValidationFinding};

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
        match Identity::new(plan.context.application.as_ref()?) {
            Ok(identity) => Some(Self { identity, made: Made::default(), modified: HashMap::new() }),
            Err(message) => {
                findings.push(ValidationFinding { express_id: None, message });
                None
            }
        }
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

/// Where the owner history of a record the plan adds comes from, shared by
/// the patches and the Adds: the exporting application's `ADDED` history,
/// else the file's (or one settled earlier) if the plan keeps it, else one
/// synthesized (see [`super::owner_history::synthesize`]). Taking one is not
/// yet using it: only a write that succeeds [`Self::commit`]s what it took,
/// so a refused write leaves nothing behind and a plan that adds nothing
/// writes none. A batch of writes that fails as a whole [`Self::rollback`]s.
pub(crate) struct Histories<'l> {
    index: &'l FileIndex<'l>,
    schema: &'l str,
    source: HistorySource<'l>,
}

enum HistorySource<'l> {
    Attributed { identity: &'l Identity, made: &'l mut Made, initial: Made },
    Source { id: Option<u32>, initial: Option<u32>, context: &'l PlanContext },
}

/// A history taken for one write: the records to write with the write if
/// the history has none yet, and what committing it settles.
pub(crate) struct Taken {
    pub(crate) records: Vec<(u32, String)>,
    pub(crate) settles: Settles,
}

/// What a committed [`Taken`] settles, by the source it was taken from.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Settles {
    /// The exporting application's records then written.
    Attributed(Made),
    /// The file's history, or one synthesized.
    Source(u32),
}

impl Settles {
    /// The history the write names.
    pub(crate) fn id(&self) -> u32 {
        match self {
            Self::Attributed(made) => made.added().expect("a taken attributed history is written"),
            Self::Source(id) => *id,
        }
    }
}

impl Taken {
    /// A history that already exists: nothing to write.
    #[cfg(test)]
    pub(crate) fn existing(id: u32) -> Self {
        Self { records: Vec::new(), settles: Settles::Source(id) }
    }
}

impl<'l> Histories<'l> {
    /// With `ledger`, the exporting application's; else `existing` (the
    /// file's or one settled earlier), or one synthesized from `context`.
    pub(crate) fn new(index: &'l FileIndex<'l>, schema: &'l str, ledger: Option<&'l mut Ledger>, existing: Option<u32>, context: &'l PlanContext) -> Self {
        let source = match ledger {
            Some(ledger) => HistorySource::Attributed { identity: &ledger.identity, initial: ledger.made, made: &mut ledger.made },
            None => HistorySource::Source { id: existing, initial: existing, context },
        };
        Self { index, schema, source }
    }

    /// The history one write names, and the records it must write with it.
    /// Records `removed` holds are neither named nor reused.
    pub(crate) fn take(&self, ids: &mut IdAllocator, removed: &HashSet<u32>) -> Option<Taken> {
        match &self.source {
            HistorySource::Attributed { identity, made, .. } => {
                let (mut made, mut records) = (**made, Vec::new());
                identity.added_in(self.schema, ids, Some((self.index, removed)), &mut made, &mut records)?;
                Some(Taken { records, settles: Settles::Attributed(made) })
            }
            HistorySource::Source { id: Some(id), .. } if !removed.contains(id) => Some(Taken { records: Vec::new(), settles: Settles::Source(*id) }),
            HistorySource::Source { context, .. } => {
                let (records, id) = super::owner_history::synthesize(self.schema, ids, context)?;
                Some(Taken { records, settles: Settles::Source(id) })
            }
        }
    }

    /// A write that took `settles` succeeded: what it took is the plan's.
    pub(crate) fn commit(&mut self, settles: Settles) {
        match (&mut self.source, settles) {
            (HistorySource::Attributed { made, .. }, Settles::Attributed(now)) => **made = now,
            (HistorySource::Source { id: slot, .. }, Settles::Source(id)) => *slot = Some(id),
            _ => unreachable!("a history is committed to the source it was taken from"),
        }
    }

    /// Writes committed since [`Self::new`] were discarded together: forget
    /// what they settled.
    pub(crate) fn rollback(&mut self) {
        match &mut self.source {
            HistorySource::Attributed { made, initial, .. } => **made = *initial,
            HistorySource::Source { id, initial, .. } => *id = *initial,
        }
    }

    /// The history committed so far, if any.
    pub(crate) fn settled(&self) -> Option<u32> {
        match &self.source {
            HistorySource::Attributed { made, .. } => made.added(),
            HistorySource::Source { id, .. } => *id,
        }
    }
}

/// Attribute the plan's settled rewrites: to the exporting application when
/// there is one ([`mark_modified`]); without one, a plan that `changed`
/// something is reported, since the file then credits its changes to their
/// previous author. A plan that named an application `Ledger::for_plan`
/// could not use has been reported already.
pub(crate) fn attribute_changes(index: &FileIndex, schema: &str, plan: &ExportPlan, ledger: Option<&mut Ledger>, removed: &HashSet<u32>, changed: bool, mut out: Rewrites) {
    match ledger {
        Some(ledger) => {
            mark_modified(index, schema, ledger, removed, &mut out);
            let reused = ledger.made.application().filter(|&app| index.contains(app));
            if let Some(message) = reused.and_then(|app| super::identity::reuse_note(index, schema, app, &ledger.identity)) {
                out.findings.push(ValidationFinding { express_id: reused, message });
            }
        }
        None if changed && plan.context.application.is_none() => out.findings.push(ValidationFinding {
            express_id: None,
            message: "no ExportingApplication supplied: added objects are attributed to the source's first owner history (or a placeholder one), and modified objects keep their original owner history, so the file credits this export's changes to their previous author".into(),
        }),
        None => {}
    }
}

/// The attributes through which a record owns another for attribution: a
/// product its placement and shape, a shape its representations and their
/// items, a type its representation maps, a map its representation, a
/// mapped item the map it instances, a set its values. A rewrite of the
/// owned record is a change to the owner.
const OWNING_ATTRIBUTES: [&str; 9] = [
    "ObjectPlacement",
    "Representation",
    "Representations",
    "Items",
    "RepresentationMaps",
    "MappedRepresentation",
    "MappingSource",
    "HasProperties",
    "Quantities",
];

/// The records whose owner history records what the plan rewrote: every
/// source record it rewrites that carries an `OwnerHistory`, and for one
/// that carries none, the nearest records that own it through
/// [`OWNING_ATTRIBUTES`] and carry one (a value's set, a placement's
/// product, a mapped shape's type and every occurrence instancing the map).
/// Records going away are not among them.
fn rewritten_roots(index: &FileIndex, schema: &str, edits_by_id: &HashMap<u32, BTreeMap<usize, String>>, removed: &HashSet<u32>) -> BTreeSet<u32> {
    let live = |id: &u32| index.contains(*id) && !removed.contains(id);
    let carries = |id: u32| index.type_of(id).is_some_and(|ty| attribute_index(schema, &ty, "OwnerHistory").is_some());
    let owns = |owner: u32, slot: usize| {
        let ty = index.type_of(owner).unwrap_or_default();
        ifc_lite_core::attribute_names_for_schema(schema, &ty).and_then(|names| names.get(slot)).is_some_and(|name| OWNING_ATTRIBUTES.contains(name))
    };
    let mut roots = BTreeSet::new();
    let mut seen = HashSet::new();
    let mut pending: Vec<u32> = edits_by_id.keys().copied().filter(|id| live(id)).collect();
    while let Some(record) = pending.pop() {
        if !seen.insert(record) {
            continue;
        }
        if carries(record) {
            roots.insert(record);
            continue;
        }
        pending.extend(index.referrers(record).iter().filter(|&&(owner, slot)| live(&owner) && owns(owner, slot)).map(|&(owner, _)| owner));
    }
    roots
}

/// The edits and records resolution has produced, which marking adds to.
pub(crate) struct Rewrites<'a> {
    pub(crate) ids: &'a mut IdAllocator,
    pub(crate) appended: &'a mut Vec<(u32, String)>,
    pub(crate) edits_by_id: &'a mut HashMap<u32, BTreeMap<usize, String>>,
    pub(crate) findings: &'a mut Vec<ValidationFinding>,
}

/// Point every record the plan rewrote ([`rewritten_roots`]) at a `MODIFIED`
/// history keeping its original owner, state and creation date. Run once,
/// after every patch, delete and Add has settled its edits.
fn mark_modified(index: &FileIndex, schema: &str, ledger: &mut Ledger, removed: &HashSet<u32>, out: &mut Rewrites) {
    let required = SchemaFamily::of_file_schema(schema) == Some(SchemaFamily::Ifc2x3);
    for id in rewritten_roots(index, schema, out.edits_by_id, removed) {
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
        let Some(original) = original_of(index, schema, original_id) else {
            out.findings.push(report(format!("modified {ty} names #{original_id}, which is not an IfcOwnerHistory; the modification is not recorded on it")));
            continue;
        };
        if matches!(original.state.as_str(), ".READONLY." | ".READONLYLOCKED." | ".LOCKED.") {
            out.findings.push(report(format!(
                "modified {ty} is marked {} by its owner history; it is written as edited and keeps that state",
                original.state
            )));
        }
        let Some(new) = ledger.modified((index, removed), schema, out.ids, out.appended, original_id, &original) else {
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
