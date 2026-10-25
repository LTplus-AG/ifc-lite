// SPDX-License-Identifier: MPL-2.0
//! Attributing an export's changes to the application that made them.
//!
//! buildingSMART's `IfcChangeActionEnum` guidance: an application that adds
//! an object is its `OwningApplication` and the action is `ADDED`; one that
//! modifies an object (re)defines `LastModifiedDate`, `LastModifyingUser`
//! and `LastModifyingApplication` and leaves the owner alone. This module is
//! the one place that turns an [`ExportingApplication`] into those records:
//! the person/organization/application chain, one `ADDED` history for
//! everything the plan adds, and one `MODIFIED` history per distinct
//! original history (not per object), which keeps the original owner and
//! creation date.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::step_ids::IdAllocator;
use crate::step_text::attribute_of;

use super::attrs::{attribute_index, build_record};
use super::index::FileIndex;
use super::owner_history::{epoch_seconds, quoted};
use super::types::{ExportingApplication, ValidationFinding};

/// A validated [`ExportingApplication`]: its change time read as seconds.
#[derive(Clone, Copy)]
pub(crate) struct Identity<'a> {
    app: &'a ExportingApplication,
    seconds: i64,
}

/// The ids of the exporting user and application records.
#[derive(Clone, Copy)]
pub(crate) struct Chain {
    user: u32,
    application: u32,
}

/// What a `MODIFIED` history keeps of the history it replaces.
struct Original {
    user: String,
    application: String,
    state: String,
    creation_date: String,
}

impl<'a> Identity<'a> {
    pub(crate) fn new(app: &'a ExportingApplication) -> Result<Self, String> {
        let seconds = epoch_seconds(&app.changed_at).ok_or_else(|| {
            format!("ExportingApplication.changed_at {:?} is neither Unix seconds nor an ISO 8601 timestamp; the export keeps the source's attribution", app.changed_at)
        })?;
        Ok(Self { app, seconds })
    }

    /// `FILE_NAME.originating_system`: the application and its version.
    pub(crate) fn originating_system(&self) -> String {
        if self.app.version.is_empty() {
            self.app.full_name.clone()
        } else {
            format!("{} {}", self.app.full_name, self.app.version)
        }
    }

    /// `FILE_NAME.time_stamp`: the change time as UTC ISO 8601.
    pub(crate) fn header_time_stamp(&self) -> String {
        iso_from_epoch(self.seconds)
    }

    /// The person, organization, person-and-organization and application
    /// records, and the ids the histories name.
    pub(crate) fn chain(&self, schema: &str, ids: &mut IdAllocator) -> Option<(Vec<(u32, String)>, Chain)> {
        let app = self.app;
        let (identification, family) = match &app.person {
            Some(p) => (p.identification.as_str(), p.name.as_str()),
            None => (app.identifier.as_str(), app.full_name.as_str()),
        };
        let person = ids.allocate()?;
        let org = ids.allocate()?;
        let user = ids.allocate()?;
        let application = ids.allocate()?;
        let records = vec![
            (
                person,
                build_record(
                    schema,
                    person,
                    "IFCPERSON",
                    // `Identification` in IFC4, `Id` in IFC2X3.
                    &[("Identification", quoted(identification)), ("Id", quoted(identification)), ("FamilyName", quoted(family))],
                ),
            ),
            (org, build_record(schema, org, "IFCORGANIZATION", &[("Name", quoted(&app.developer))])),
            (
                user,
                build_record(
                    schema,
                    user,
                    "IFCPERSONANDORGANIZATION",
                    &[("ThePerson", format!("#{person}")), ("TheOrganization", format!("#{org}"))],
                ),
            ),
            (
                application,
                build_record(
                    schema,
                    application,
                    "IFCAPPLICATION",
                    &[
                        ("ApplicationDeveloper", format!("#{org}")),
                        ("Version", quoted(&app.version)),
                        ("ApplicationFullName", quoted(&app.full_name)),
                        ("ApplicationIdentifier", quoted(&app.identifier)),
                    ],
                ),
            ),
        ];
        Some((records, Chain { user, application }))
    }

    /// The history of an object this application adds. `LastModifiedDate` is
    /// set too, so `ChangeAction` is asserted with a modification date in
    /// every schema's reading of `CorrectChangeAction`.
    pub(crate) fn added_history(&self, schema: &str, ids: &mut IdAllocator, chain: Chain) -> Option<(u32, String)> {
        let id = ids.allocate()?;
        let time = self.seconds.to_string();
        let record = build_record(
            schema,
            id,
            "IFCOWNERHISTORY",
            &[
                ("OwningUser", format!("#{}", chain.user)),
                ("OwningApplication", format!("#{}", chain.application)),
                ("ChangeAction", ".ADDED.".into()),
                ("LastModifiedDate", time.clone()),
                ("LastModifyingUser", format!("#{}", chain.user)),
                ("LastModifyingApplication", format!("#{}", chain.application)),
                ("CreationDate", time),
            ],
        );
        Some((id, record))
    }

    fn modified_history(&self, schema: &str, ids: &mut IdAllocator, chain: Chain, original: &Original) -> Option<(u32, String)> {
        let id = ids.allocate()?;
        let record = build_record(
            schema,
            id,
            "IFCOWNERHISTORY",
            &[
                ("OwningUser", original.user.clone()),
                ("OwningApplication", original.application.clone()),
                ("State", original.state.clone()),
                ("ChangeAction", ".MODIFIED.".into()),
                ("LastModifiedDate", self.seconds.to_string()),
                ("LastModifyingUser", format!("#{}", chain.user)),
                ("LastModifyingApplication", format!("#{}", chain.application)),
                ("CreationDate", original.creation_date.clone()),
            ],
        );
        Some((id, record))
    }
}

/// The records a plan has written for its identity so far, each made on first
/// use so a plan that changes nothing writes nothing.
pub(crate) struct Ledger<'a> {
    pub(crate) identity: Identity<'a>,
    chain: Option<Chain>,
    added: Option<u32>,
    modified: HashMap<u32, u32>,
}

impl<'a> Ledger<'a> {
    pub(crate) fn new(identity: Identity<'a>) -> Self {
        Self { identity, chain: None, added: None, modified: HashMap::new() }
    }

    /// The plan's ledger, or none when it names no application or an
    /// unusable one (reported in `findings`; the source's attribution stays).
    pub(crate) fn for_plan(plan: &'a super::types::ExportPlan, findings: &mut Vec<ValidationFinding>) -> Option<Self> {
        match Identity::new(plan.context.application.as_ref()?) {
            Ok(identity) => Some(Self::new(identity)),
            Err(message) => {
                findings.push(ValidationFinding { express_id: None, message });
                None
            }
        }
    }

    fn chain(&mut self, schema: &str, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>) -> Option<Chain> {
        if self.chain.is_none() {
            let (records, chain) = self.identity.chain(schema, ids)?;
            appended.extend(records);
            self.chain = Some(chain);
        }
        self.chain
    }

    /// The one `ADDED` history every addition of the plan names.
    pub(crate) fn added(&mut self, schema: &str, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>) -> Option<u32> {
        if self.added.is_none() {
            let chain = self.chain(schema, ids, appended)?;
            let (id, record) = self.identity.added_history(schema, ids, chain)?;
            appended.push((id, record));
            self.added = Some(id);
        }
        self.added
    }

    /// The `MODIFIED` history standing in for `original`, one per original.
    fn modified(&mut self, schema: &str, ids: &mut IdAllocator, appended: &mut Vec<(u32, String)>, original_id: u32, original: &Original) -> Option<u32> {
        if let Some(&id) = self.modified.get(&original_id) {
            return Some(id);
        }
        let chain = self.chain(schema, ids, appended)?;
        let (id, record) = self.identity.modified_history(schema, ids, chain, original)?;
        appended.push((id, record));
        self.modified.insert(original_id, id);
        Some(id)
    }
}

pub(crate) fn missing_application() -> ValidationFinding {
    ValidationFinding {
        express_id: None,
        message: "no ExportingApplication supplied: added objects are attributed to the source's first owner history (or a placeholder one), and modified objects keep their original owner history, so the file credits this export's changes to their previous author".into(),
    }
}

/// Point every modified object at a `MODIFIED` history. `modified` holds the
/// records a patch touched; only those that carry an `OwnerHistory` and are
/// still in the output are repointed. The rest of the file is not touched.
#[allow(clippy::too_many_arguments)]
pub(crate) fn mark_modified(
    index: &FileIndex,
    schema: &str,
    ledger: &mut Ledger,
    modified: &HashSet<u32>,
    removed: &HashSet<u32>,
    ids: &mut IdAllocator,
    appended: &mut Vec<(u32, String)>,
    edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
    findings: &mut Vec<ValidationFinding>,
) {
    let sorted: BTreeSet<u32> = modified.iter().copied().filter(|id| !removed.contains(id)).collect();
    for id in sorted {
        let Some(ty) = index.type_of(id) else { continue };
        let Some(slot_idx) = attribute_index(schema, &ty, "OwnerHistory") else { continue };
        let Some(line) = index.raw_line(id) else { continue };
        let slot = attribute_of(&line, slot_idx).unwrap_or_default();
        let Some(original_id) = ifc_lite_core::parser::parse_ref(slot.trim().as_bytes()) else {
            // An unset history (optional in IFC4) has no author to carry
            // forward; the file never recorded one for this object.
            if slot.trim() == "$" {
                continue;
            }
            findings.push(ValidationFinding {
                express_id: Some(id),
                message: format!("modified {ty} has no owner history to carry forward; the modification is not recorded on it"),
            });
            continue;
        };
        let Some(original) = original_of(index, schema, original_id) else {
            findings.push(ValidationFinding {
                express_id: Some(id),
                message: format!("modified {ty} names #{original_id}, which is not an IfcOwnerHistory; the modification is not recorded on it"),
            });
            continue;
        };
        let Some(new) = ledger.modified(schema, ids, appended, original_id, &original) else {
            findings.push(ValidationFinding { express_id: Some(id), message: "id space exhausted: the modification is not recorded".into() });
            continue;
        };
        edits_by_id.entry(id).or_default().insert(slot_idx, format!("#{new}"));
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

/// `YYYY-MM-DDTHH:MM:SS` (UTC) for Unix seconds, the inverse of
/// `epoch_seconds` (Howard Hinnant's `civil_from_days`).
fn iso_from_epoch(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_time_round_trips_epoch_seconds() {
        for stamp in ["1970-01-01T00:00:00", "2000-02-29T23:59:59", "2026-10-23T10:00:00", "1969-12-31T23:59:59"] {
            assert_eq!(iso_from_epoch(epoch_seconds(stamp).unwrap()), stamp);
        }
    }
}
