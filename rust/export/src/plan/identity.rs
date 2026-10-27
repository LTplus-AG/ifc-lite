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
use crate::step_text::quoted;

use super::attrs::{attribute_index, build_record};
use super::index::FileIndex;
use super::props_lookup::scalar_attr;
use super::owner_history::epoch_seconds;
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
    let existing_app = source.and_then(|(index, removed)| existing_application(index, removed, schema, spec));
    let mut org = existing_app.and_then(|(_, developer)| developer);
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

/// `(application, its developer)` for the source's application the chain
/// reuses: one the output keeps that `spec` names by `ApplicationIdentifier`
/// (UR1), else by `ApplicationFullName` and `Version` (UR2), since a second
/// application repeating either would break the rule. Among several, one
/// whose developer the output keeps is preferred. An application is reused
/// even when its developer is unset or does not resolve; the user then gets
/// an organization of its own. A developer the plan removes takes its
/// application with it (the cascade), which is then not kept.
fn existing_application(index: &FileIndex, removed: &HashSet<u32>, schema: &str, spec: &ChainSpec) -> Option<(u32, Option<u32>)> {
    let read = |id: u32, attr: &str| index.string_attr(schema, id, "IFCAPPLICATION", attr);
    let developer = |id: u32| scalar_attr(index, schema, id, "IFCAPPLICATION", "ApplicationDeveloper").filter(|d| index.contains(*d) && !removed.contains(d));
    let kept = || index.applications.iter().copied().filter(|id| !removed.contains(id));
    let by_identifier = |id: &u32| read(*id, "ApplicationIdentifier").as_deref() == Some(spec.identifier);
    let by_name = |id: &u32| read(*id, "ApplicationFullName").as_deref() == Some(spec.full_name) && read(*id, "Version").as_deref() == Some(spec.version);
    let pick = |matches: &dyn Fn(&u32) -> bool| {
        let candidates: Vec<(u32, Option<u32>)> = kept().filter(|id| matches(id)).map(|id| (id, developer(id))).collect();
        candidates.iter().copied().find(|(_, d)| d.is_some()).or_else(|| candidates.first().copied())
    };
    pick(&by_identifier).or_else(|| pick(&by_name))
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
    let read = |attr: &str| index.string_attr(schema, application, "IFCAPPLICATION", attr);
    let (version, full_name) = (read("Version").unwrap_or_default(), read("ApplicationFullName").unwrap_or_default());
    let identifier = read("ApplicationIdentifier");
    let app = &identity.app;
    if identifier.as_deref() != Some(app.identifier.as_str()) {
        // Reused by name and version (UR2): consumers look the exporter up by
        // identifier, and the file names it by another, or by none.
        let unset = attribute_index(schema, "IFCAPPLICATION", "ApplicationIdentifier")
            .and_then(|i| crate::step_text::attribute_of(&index.raw_line(application)?, i))
            .is_some_and(|slot| slot.trim() == "$");
        let named = match identifier {
            Some(id) => format!("identifier '{id}'"),
            None if unset => "no identifier".to_string(),
            None => "an unreadable identifier".to_string(),
        };
        return Some(format!(
            "the file already has application #{application} '{full_name}' version '{version}' with {named}; it is reused (an application's name and version are unique) though the exporting application's identifier is '{}'",
            app.identifier
        ));
    }
    let identifier = identifier.unwrap_or_default();
    (version != app.version || full_name != app.full_name).then(|| {
        format!(
            "the file already has application #{application} with identifier '{identifier}' ('{full_name}' version '{version}'); it is reused for '{}' version '{}', since an identifier names one application",
            app.full_name, app.version
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
    fn new(app: &ExportingApplication) -> Result<Self, String> {
        let stamp = &app.changed_at;
        let keeps = "the export keeps the source's attribution";
        let seconds = epoch_seconds(stamp)
            .ok_or_else(|| format!("ExportingApplication.changed_at {stamp:?} is neither Unix seconds nor an ISO 8601 timestamp; {keeps}"))?;
        // IfcTimeStamp is an EXPRESS INTEGER, which 32-bit readers
        // (IfcOpenShell among them) hold as an int: attribute only within it.
        if !(0..=i64::from(i32::MAX)).contains(&seconds) {
            let bare = stamp.trim().parse::<i64>().is_ok_and(|v| v > 100_000_000_000);
            let hint = if bare { " (it looks like milliseconds since the epoch, not seconds)" } else { "" };
            return Err(format!(
                "ExportingApplication.changed_at {stamp:?} is {seconds} seconds, outside the 0..=2147483647 an IfcTimeStamp holds for 32-bit readers{hint}; {keeps}"
            ));
        }
        Ok(Self { app: app.clone(), seconds })
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

mod header;
