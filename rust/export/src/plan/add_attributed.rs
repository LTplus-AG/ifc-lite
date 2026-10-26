// SPDX-License-Identifier: MPL-2.0
//! Running a plan's Adds under the owner history they name.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;

use super::add::AddState;
use super::add_types::AddItem;
use super::attribution::{Histories, Ledger};
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

/// Build the Adds and return how many were written. With an exporting
/// application every Add names its one `ADDED` history, made by the first
/// Add that builds; a relationship an Add extends is a rewrite like any
/// other, which [`super::attribution::mark_modified`] finds afterwards.
pub(super) fn run(setting: &AddSetting, adds: &[(&ObjectRef, AddItem)], ledger: Option<&mut Ledger>, produced: &mut Produced) -> usize {
    if adds.is_empty() {
        return 0;
    }
    let history = Histories::new(setting.index, setting.schema, ledger, setting.owner_history, setting.context);
    let state = AddState::new(setting.index, setting.schema, setting.removed, history, setting.body_context);
    state.build_all(adds, produced.ids, produced.edits_by_id, produced.appended, produced.refusals, produced.findings)
}
