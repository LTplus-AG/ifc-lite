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
    fn modified(&mut self, index: &FileIndex, schema: &str, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>, original_id: u32, original: &Original) -> Option<u32> {
        if let Some(&id) = self.modified.get(&original_id) {
            return Some(id);
        }
        let chain = self.identity.chain_in(schema, ids, Some(index), &mut self.made, appended)?;
        let id = ids.allocate()?;
        appended.push((id, self.identity.modified_history(schema, id, chain, original)));
        self.modified.insert(original_id, id);
        Some(id)
    }
}

/// Where a patch's new records' owner history comes from, made on first use
/// so a plan whose patches add no record writes none: the exporting
/// application's `ADDED` history, else the file's first, else one
/// synthesized (see [`super::owner_history::synthesize`]).
pub(crate) struct PatchHistory<'l> {
    index: &'l FileIndex<'l>,
    schema: &'l str,
    source: HistorySource<'l>,
}

enum HistorySource<'l> {
    Attributed(&'l mut Ledger),
    Source { existing: Option<u32>, context: &'l PlanContext },
}

impl<'l> PatchHistory<'l> {
    pub(crate) fn new(index: &'l FileIndex<'l>, schema: &'l str, ledger: Option<&'l mut Ledger>, context: &'l PlanContext) -> Self {
        let source = match ledger {
            Some(ledger) => HistorySource::Attributed(ledger),
            None => HistorySource::Source { existing: index.first_owner_history, context },
        };
        Self { index, schema, source }
    }

    /// The history, written to `appended` the first time it is asked for.
    pub(crate) fn get(&mut self, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>) -> Option<u32> {
        match &mut self.source {
            HistorySource::Attributed(ledger) => ledger.identity.added_in(self.schema, ids, Some(self.index), &mut ledger.made, appended),
            HistorySource::Source { existing: Some(id), .. } => Some(*id),
            HistorySource::Source { existing, context } => {
                let (records, id) = super::owner_history::synthesize(self.schema, ids, context)?;
                appended.extend(records);
                *existing = Some(id);
                Some(id)
            }
        }
    }

    /// Without an application, the history the patches settled on (the
    /// file's, or one they synthesized), for the Adds to name.
    pub(crate) fn settled(&self) -> Option<u32> {
        match &self.source {
            HistorySource::Attributed(_) => None,
            HistorySource::Source { existing, .. } => *existing,
        }
    }
}

/// Attribute the plan's settled rewrites: to the exporting application when
/// there is one ([`mark_modified`]); without one, a plan that `changed`
/// something is reported, since the file then credits its changes to their
/// previous author.
pub(crate) fn attribute_changes(index: &FileIndex, schema: &str, ledger: Option<&mut Ledger>, removed: &HashSet<u32>, changed: bool, out: Rewrites) {
    match ledger {
        Some(ledger) => mark_modified(index, schema, ledger, removed, out),
        None if changed => out.findings.push(ValidationFinding {
            express_id: None,
            message: "no ExportingApplication supplied: added objects are attributed to the source's first owner history (or a placeholder one), and modified objects keep their original owner history, so the file credits this export's changes to their previous author".into(),
        }),
        None => {}
    }
}

/// The records whose owner history records what the plan rewrote: every
/// source record it rewrites that carries an `OwnerHistory`, and for one
/// that carries none (a property or quantity value edited in place) the
/// sets that list it. Records going away are not among them.
fn rewritten_roots(index: &FileIndex, schema: &str, edits_by_id: &HashMap<u32, BTreeMap<usize, String>>, removed: &HashSet<u32>) -> BTreeSet<u32> {
    let live = |id: &u32| index.contains(*id) && !removed.contains(id);
    let carries = |id: u32| index.type_of(id).is_some_and(|ty| attribute_index(schema, &ty, "OwnerHistory").is_some());
    let mut roots = BTreeSet::new();
    for &id in edits_by_id.keys().filter(|id| live(id)) {
        if carries(id) {
            roots.insert(id);
            continue;
        }
        for &(set, _) in index.referrers(id) {
            let is_set = index.type_of(set).is_some_and(|ty| ty == "IFCPROPERTYSET" || ty == "IFCELEMENTQUANTITY");
            if is_set && live(&set) {
                roots.insert(set);
            }
        }
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
fn mark_modified(index: &FileIndex, schema: &str, ledger: &mut Ledger, removed: &HashSet<u32>, out: Rewrites) {
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
        let Some(new) = ledger.modified(index, schema, out.ids, out.appended, original_id, &original) else {
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
