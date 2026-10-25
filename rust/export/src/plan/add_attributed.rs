// SPDX-License-Identifier: MPL-2.0
//! Running a plan's Adds under the exporting application's identity.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;

use super::add::AddState;
use super::add_types::AddItem;
use super::identity::{mark_modified, Ledger};
use super::index::FileIndex;
use super::types::{ObjectRef, PlanContext, Refusal, ValidationFinding};

/// What resolution has produced so far, which the Adds add to.
pub(super) struct Produced<'a> {
    pub(super) ids: &'a mut IdAllocator,
    pub(super) appended: &'a mut Vec<(u32, String)>,
    pub(super) edits_by_id: &'a mut HashMap<u32, BTreeMap<usize, String>>,
    pub(super) refusals: &'a mut Vec<Refusal>,
    pub(super) findings: &'a mut Vec<ValidationFinding>,
}

/// What the Adds read: the file, the records already going away, and the
/// owner history and body context earlier steps settled.
pub(super) struct AddSetting<'a> {
    pub(super) index: &'a FileIndex<'a>,
    pub(super) schema: &'a str,
    pub(super) context: &'a PlanContext,
    pub(super) removed: &'a HashSet<u32>,
    pub(super) owner_history: Option<u32>,
    pub(super) body_context: Option<u32>,
}

/// Build the Adds and return how many were written.
///
/// With an exporting application every Add names its one `ADDED` history,
/// made before the Adds and given back when none builds. A relationship an
/// Add extends is modified, so it gets a `MODIFIED` history too.
pub(super) fn run(
    setting: &AddSetting,
    adds: &[(&ObjectRef, AddItem)],
    mut ledger: Option<&mut Ledger>,
    produced: &mut Produced,
) -> usize {
    if adds.is_empty() {
        return 0;
    }
    let appended_before = produced.appended.len();
    let owner_history = match ledger.as_deref_mut() {
        Some(ledger) => ledger.added(setting.schema, produced.ids, produced.appended),
        // An owner history the plan deletes is not one an Add can name.
        None => setting.owner_history.filter(|id| !setting.removed.contains(id)),
    };
    let edits_before = ledger.is_some().then(|| produced.edits_by_id.clone());
    let state = AddState::new(setting.index, setting.schema, setting.removed, setting.context, owner_history, setting.body_context);
    let built = state.build_all(adds, produced.ids, produced.edits_by_id, produced.appended, produced.refusals, produced.findings);
    if let (Some(ledger), Some(before)) = (ledger, edits_before) {
        if built == 0 {
            produced.appended.truncate(appended_before);
        } else {
            let extended: HashSet<u32> = produced.edits_by_id.iter().filter(|(id, e)| before.get(id) != Some(*e)).map(|(&id, _)| id).collect();
            mark_modified(setting.index, setting.schema, ledger, &extended, setting.removed, produced.ids, produced.appended, produced.edits_by_id, produced.findings);
        }
    }
    built
}
