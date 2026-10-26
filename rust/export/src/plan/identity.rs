// SPDX-License-Identifier: MPL-2.0
//! Who an export's records are attributed to: the person, organization,
//! user and application chain, and the histories that name it.
//!
//! buildingSMART's `IfcChangeActionEnum` guidance: an application that adds
//! an object is its `OwningApplication` and the action is `ADDED`; one that
//! modifies an object (re)defines `LastModifiedDate`, `LastModifyingUser`
//! and `LastModifyingApplication` and leaves the owner alone. This module
//! builds those records; [`super::attribution`] decides which objects get
//! them.
//!
//! The chain is built in one place, [`chain`], for the exporting
//! application and for the placeholder history [`super::owner_history`]
//! synthesizes when a plan names no application.

use std::collections::HashSet;

use crate::step_ids::IdAllocator;

use super::attrs::{attribute_index, build_record};
use super::index::FileIndex;
use super::props_lookup::scalar_attr;
use super::owner_history::{epoch_seconds, quoted};
use super::types::ExportingApplication;

/// What the person, organization, user and application records say.
pub(crate) struct ChainSpec<'s> {
    /// `IfcPerson.Identification` (`Id` in IFC2X3).
    pub(crate) identification: &'s str,
    /// `IfcPerson.FamilyName`.
    pub(crate) family_name: &'s str,
    /// `IfcOrganization.Name`, the application's developer.
    pub(crate) developer: &'s str,
    pub(crate) version: &'s str,
    pub(crate) full_name: &'s str,
    /// `IfcApplication.ApplicationIdentifier`, UNIQUE in a file.
    pub(crate) identifier: &'s str,
}

/// The ids of the user and application records a history names.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Chain {
    pub(crate) user: u32,
    pub(crate) application: u32,
}

/// The source a chain may reuse records of: the file, and the records the
/// plan takes out of it, which are not reused.
pub(crate) type Reusable<'s> = Option<(&'s FileIndex<'s>, &'s HashSet<u32>)>;

/// The chain `spec` describes, as `(records to write, ids)`. From a
/// `source`, an application it already names by `spec.identifier` is reused
/// (UR1/UR2 make the identifier unique), with its developer, and so is a
/// user of that developer whose person matches `spec`, each only if it
/// stays in the output; only what is missing is written.
pub(crate) fn chain(schema: &str, ids: &mut IdAllocator, spec: &ChainSpec, source: Reusable) -> Option<(Vec<(u32, String)>, Chain)> {
    let existing_app = source.and_then(|(index, removed)| existing_application(index, removed, schema, spec.identifier));
    let mut org = existing_app.map(|(_, developer)| developer);
    let existing_user = source.zip(org).and_then(|((index, removed), org)| existing_user(index, removed, schema, org, spec));
    let mut records = Vec::new();
    let user = match existing_user {
        Some(user) => user,
        None => {
            let person = ids.allocate()?;
            records.push((
                person,
                build_record(
                    schema,
                    person,
                    "IFCPERSON",
                    // `Identification` in IFC4, `Id` in IFC2X3.
                    &[("Identification", quoted(spec.identification)), ("Id", quoted(spec.identification)), ("FamilyName", quoted(spec.family_name))],
                ),
            ));
            let org_id = match org {
                Some(org) => org,
                None => {
                    let id = ids.allocate()?;
                    records.push((id, build_record(schema, id, "IFCORGANIZATION", &[("Name", quoted(spec.developer))])));
                    org = Some(id);
                    id
                }
            };
            let user = ids.allocate()?;
            records.push((
                user,
                build_record(schema, user, "IFCPERSONANDORGANIZATION", &[("ThePerson", format!("#{person}")), ("TheOrganization", format!("#{org_id}"))]),
            ));
            user
        }
    };
    let application = match existing_app {
        Some((application, _)) => application,
        None => {
            let application = ids.allocate()?;
            records.push((
                application,
                build_record(
                    schema,
                    application,
                    "IFCAPPLICATION",
                    &[
                        ("ApplicationDeveloper", format!("#{}", org?)),
                        ("Version", quoted(spec.version)),
                        ("ApplicationFullName", quoted(spec.full_name)),
                        ("ApplicationIdentifier", quoted(spec.identifier)),
                    ],
                ),
            ));
            application
        }
    };
    Some((records, Chain { user, application }))
}

/// `(application, its developer)` for the source's application named
/// `identifier`, the first in file order that the output keeps, with its
/// developer only if that is kept too.
fn existing_application(index: &FileIndex, removed: &HashSet<u32>, schema: &str, identifier: &str) -> Option<(u32, u32)> {
    let id = index
        .applications
        .iter()
        .copied()
        .filter(|id| !removed.contains(id))
        .find(|&id| index.string_attr(schema, id, "IFCAPPLICATION", "ApplicationIdentifier").as_deref() == Some(identifier))?;
    // An application whose developer goes cannot be reused.
    let developer = scalar_attr(index, schema, id, "IFCAPPLICATION", "ApplicationDeveloper").filter(|d| !removed.contains(d))?;
    Some((id, developer))
}

/// A source user of `org`, kept by the output, whose person (kept too) is
/// the one `spec` names.
fn existing_user(index: &FileIndex, removed: &HashSet<u32>, schema: &str, org: u32, spec: &ChainSpec) -> Option<u32> {
    let slot = attribute_index(schema, "IFCPERSONANDORGANIZATION", "TheOrganization")?;
    let person_matches = |person: u32| {
        !removed.contains(&person)
            && index.type_of(person).as_deref() == Some("IFCPERSON")
            && ["Identification", "Id"].iter().any(|a| index.string_attr(schema, person, "IFCPERSON", a).as_deref() == Some(spec.identification))
            && index.string_attr(schema, person, "IFCPERSON", "FamilyName").as_deref() == Some(spec.family_name)
    };
    index.referrers(org).iter().find_map(|&(user, i)| {
        (i == slot && !removed.contains(&user) && index.type_of(user).as_deref() == Some("IFCPERSONANDORGANIZATION"))
            .then(|| scalar_attr(index, schema, user, "IFCPERSONANDORGANIZATION", "ThePerson"))
            .flatten()
            .filter(|&p| person_matches(p))
            .map(|_| user)
    })
}

/// A finding when `application`, a source record reused for the exporting
/// application, names another version or full name than it does: reused
/// all the same, since UR1 allows one application per identifier.
pub(crate) fn reuse_note(index: &FileIndex, schema: &str, application: u32, identity: &Identity) -> Option<String> {
    let read = |attr: &str| index.string_attr(schema, application, "IFCAPPLICATION", attr).unwrap_or_default();
    let (version, full_name) = (read("Version"), read("ApplicationFullName"));
    (version != identity.app.version || full_name != identity.app.full_name).then(|| {
        format!(
            "the file already has application #{application} with identifier '{}' ('{full_name}' version '{version}'); it is reused for '{}' version '{}', since an identifier names one application",
            identity.app.identifier, identity.app.full_name, identity.app.version
        )
    })
}

/// A validated [`ExportingApplication`]: its change time read as seconds.
/// Owned rather than borrowed from the plan, so the ledger that holds it
/// carries no lifetime of the plan's.
pub(crate) struct Identity {
    app: ExportingApplication,
    seconds: i64,
}

impl Identity {
    pub(crate) fn new(app: &ExportingApplication) -> Result<Self, String> {
        let stamp = &app.changed_at;
        let keeps = "the export keeps the source's attribution";
        let seconds = epoch_seconds(stamp)
            .ok_or_else(|| format!("ExportingApplication.changed_at {stamp:?} is neither Unix seconds nor an ISO 8601 timestamp; {keeps}"))?;
        // IfcTimeStamp is a 32-bit count of seconds since the epoch.
        if i32::try_from(seconds).is_err() {
            let milliseconds = stamp.trim().parse::<i64>().is_ok_and(|v| i32::try_from(v / 1000).is_ok());
            let hint = if milliseconds { " (it looks like milliseconds; give seconds)" } else { "" };
            return Err(format!("ExportingApplication.changed_at {stamp:?} is outside the IfcTimeStamp range{hint}; {keeps}"));
        }
        Ok(Self { app: app.clone(), seconds })
    }

    /// `FILE_NAME.preprocessor_version`: this toolkit, which wrote the file.
    pub(crate) fn preprocessor() -> String {
        concat!("ifc-lite ", env!("CARGO_PKG_VERSION")).to_string()
    }

    /// `FILE_NAME.originating_system`: the application and its version.
    pub(crate) fn originating_system(&self) -> String {
        if self.app.version.is_empty() {
            self.app.full_name.clone()
        } else {
            format!("{} {}", self.app.full_name, self.app.version)
        }
    }

    /// `FILE_NAME.time_stamp`: the change time as UTC ISO 8601, marked `Z`.
    pub(crate) fn header_time_stamp(&self) -> String {
        format!("{}Z", iso_from_epoch(self.seconds))
    }

    /// The chain this application's histories name.
    pub(crate) fn spec(&self) -> ChainSpec<'_> {
        let app = &self.app;
        let (identification, family_name) = match &app.person {
            Some(p) => (p.identification.as_str(), p.name.as_str()),
            None => (app.identifier.as_str(), app.full_name.as_str()),
        };
        ChainSpec {
            identification,
            family_name,
            developer: &app.developer,
            version: &app.version,
            full_name: &app.full_name,
            identifier: &app.identifier,
        }
    }

    /// The history of an object this application adds. `LastModifiedDate` is
    /// set too, so `ChangeAction` is asserted with a modification date in
    /// every schema's reading of `CorrectChangeAction`.
    pub(crate) fn added_history(&self, schema: &str, id: u32, chain: Chain) -> String {
        let time = self.seconds.to_string();
        build_record(
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
        )
    }

    /// The history of an object this application modifies: the original's
    /// owner, state and creation date, this application as last modifier.
    pub(crate) fn modified_history(&self, schema: &str, id: u32, chain: Chain, original: &Original) -> String {
        build_record(
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
        )
    }

    /// The `ADDED` history, made on first use: whatever `made` lacks is
    /// written to `out` and recorded in `made`.
    pub(crate) fn added_in(&self, schema: &str, ids: &mut IdAllocator, source: Reusable, made: &mut Made, out: &mut Vec<(u32, String)>) -> Option<u32> {
        if let Some(id) = made.added {
            return Some(id);
        }
        let chain = self.chain_in(schema, ids, source, made, out)?;
        let id = ids.allocate()?;
        out.push((id, self.added_history(schema, id, chain)));
        made.added = Some(id);
        Some(id)
    }

    /// The chain, made on first use as [`Self::added_in`] makes its history.
    pub(crate) fn chain_in(&self, schema: &str, ids: &mut IdAllocator, source: Reusable, made: &mut Made, out: &mut Vec<(u32, String)>) -> Option<Chain> {
        if made.chain.is_none() {
            let (records, made_chain) = chain(schema, ids, &self.spec(), source)?;
            out.extend(records);
            made.chain = Some(made_chain);
        }
        made.chain
    }
}

/// The exporting application's records written so far.
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Made {
    chain: Option<Chain>,
    added: Option<u32>,
}

impl Made {
    /// The `ADDED` history, once written.
    pub(crate) fn added(&self) -> Option<u32> {
        self.added
    }

    /// The application record the histories name, once settled.
    pub(crate) fn application(&self) -> Option<u32> {
        self.chain.map(|c| c.application)
    }
}

/// What a `MODIFIED` history keeps of the history it replaces.
pub(crate) struct Original {
    pub(crate) user: String,
    pub(crate) application: String,
    pub(crate) state: String,
    pub(crate) creation_date: String,
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
