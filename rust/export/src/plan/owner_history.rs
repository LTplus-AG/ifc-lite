// SPDX-License-Identifier: MPL-2.0
//! Deterministic `IfcOwnerHistory` synthesis.
//!
//! The base STEP exporter reuses an owner history the source already wrote
//! and otherwise leaves `$` in the slot (`schema_owner_history.rs`, #4686) —
//! it never invents one, on the view that provenance should never be
//! fabricated for a record that already exists. This executor is in a
//! different position: every record here is one IT is appending, so there is
//! no existing provenance to preserve or fabricate, only a choice between
//! `$` and a minimal, deterministic chain naming the plan's own context. The
//! same source run through the same plan produces the same ids and the same
//! text, which is what "deterministic" buys: a byte-identical rerun, not a
//! real person or a real tool.
//!
//! Built only when the source carries no `IfcOwnerHistory` at all; otherwise
//! the first one the source wrote is reused (matching #4686's policy) and
//! nothing new is written.

use crate::step_text::escape;
use crate::step_ids::IdAllocator;

use super::attrs::build_record;
use super::types::PlanContext;

/// A minimal valid `IfcPerson`/`IfcOrganization`/`IfcPersonAndOrganization`/
/// `IfcApplication`/`IfcOwnerHistory` chain, generic over the schema's own
/// attribute order the same way [`super::props`] builds a property record.
pub(crate) fn synthesize(schema: &str, ids: &mut IdAllocator, context: &PlanContext) -> Option<(Vec<(u32, String)>, u32)> {
    let organization_name = context.organization.as_deref().unwrap_or("ifc-lite");
    let application_name = context.author.as_deref().unwrap_or("ifc-lite export-plan executor");
    let time_stamp = context.time_stamp.as_deref().and_then(epoch_seconds).unwrap_or(0);

    let mut records = Vec::new();
    let person_id = ids.allocate()?;
    records.push((
        person_id,
        build_record(
            schema,
            person_id,
            "IFCPERSON",
            // `Identification` in IFC4, `Id` in IFC2X3; a family name meets
            // the rule that a person carries some name in both.
            &[("Identification", quoted("ifc-lite")), ("Id", quoted("ifc-lite")), ("FamilyName", quoted("ifc-lite"))],
        ),
    ));

    let org_id = ids.allocate()?;
    records.push((org_id, build_record(schema, org_id, "IFCORGANIZATION", &[("Name", quoted(organization_name))])));

    let person_and_org_id = ids.allocate()?;
    records.push((
        person_and_org_id,
        build_record(
            schema,
            person_and_org_id,
            "IFCPERSONANDORGANIZATION",
            &[("ThePerson", format!("#{person_id}")), ("TheOrganization", format!("#{org_id}"))],
        ),
    ));

    let application_id = ids.allocate()?;
    records.push((
        application_id,
        build_record(
            schema,
            application_id,
            "IFCAPPLICATION",
            &[
                ("ApplicationDeveloper", format!("#{org_id}")),
                ("Version", quoted("1.0")),
                ("ApplicationFullName", quoted(application_name)),
                ("ApplicationIdentifier", quoted("ifc-lite-export-plan")),
            ],
        ),
    ));

    let owner_history_id = ids.allocate()?;
    records.push((
        owner_history_id,
        build_record(
            schema,
            owner_history_id,
            "IFCOWNERHISTORY",
            &[
                ("OwningUser", format!("#{person_and_org_id}")),
                ("OwningApplication", format!("#{application_id}")),
                // Mandatory in IFC2X3. NOCHANGE is the one value both
                // schemas accept without a LastModifiedDate.
                ("ChangeAction", ".NOCHANGE.".to_string()),
                ("CreationDate", time_stamp.to_string()),
            ],
        ),
    ));

    Some((records, owner_history_id))
}

fn quoted(s: &str) -> String {
    format!("'{}'", escape(s))
}

/// `IfcTimeStamp` seconds for the caller's stamp: Unix seconds as written, or
/// an ISO 8601 `YYYY-MM-DDThh:mm:ss` (the form the header's `FILE_NAME`
/// takes), read as UTC unless it ends in `Z` or a `+hh:mm`/`-hh:mm` offset.
fn epoch_seconds(stamp: &str) -> Option<i64> {
    let stamp = stamp.trim();
    if let Ok(seconds) = stamp.parse::<i64>() {
        return Some(seconds);
    }
    let num = |s: &str| -> Option<i64> { s.bytes().all(|b| b.is_ascii_digit()).then(|| s.parse().ok()).flatten() };
    let (date, rest) = stamp.split_at_checked(10)?;
    let rest = rest.strip_prefix(['T', ' '])?;
    let (time, zone) = rest.split_at_checked(8)?;
    let mut d = date.split('-');
    let (year, month, day) = (num(d.next()?)?, num(d.next()?)?, num(d.next()?)?);
    let mut t = time.split(':');
    let (hour, minute, second) = (num(t.next()?)?, num(t.next()?)?, num(t.next()?)?);
    if d.next().is_some() || t.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Drop fractional seconds, then read the zone.
    let zone = zone.strip_prefix('.').map_or(zone, |z| z.trim_start_matches(|c: char| c.is_ascii_digit()));
    let offset = match zone {
        "" | "Z" => 0,
        z => {
            let sign = match z.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (h, m) = z[1..].split_once(':')?;
            sign * (num(h)? * 3600 + num(m)? * 60)
        }
    };
    // Days from 1970-01-01 to the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_date_reads_unix_seconds_or_an_iso_stamp() {
        assert_eq!(epoch_seconds("123"), Some(123));
        assert_eq!(epoch_seconds("1970-01-01T00:00:00"), Some(0));
        assert_eq!(epoch_seconds("2026-10-23T10:00:00"), Some(1_792_749_600));
        assert_eq!(epoch_seconds("2026-10-23T12:00:00+02:00"), Some(1_792_749_600));
        assert_eq!(epoch_seconds("2026-10-23T10:00:00.5Z"), Some(1_792_749_600));
        assert_eq!(epoch_seconds("2000-02-29T00:00:00"), Some(951_782_400));
        assert_eq!(epoch_seconds("yesterday"), None);
        assert_eq!(epoch_seconds("2026-13-01T00:00:00"), None);
    }

    #[test]
    fn synthesizes_a_valid_chain_and_is_deterministic() {
        let ctx = PlanContext::default();
        let mut a = IdAllocator::after(10);
        let (records_a, owh_a) = synthesize("IFC4", &mut a, &ctx).unwrap();
        let mut b = IdAllocator::after(10);
        let (records_b, owh_b) = synthesize("IFC4", &mut b, &ctx).unwrap();
        assert_eq!(records_a, records_b);
        assert_eq!(owh_a, owh_b);
        assert_eq!(records_a.len(), 5);
        assert!(records_a.last().unwrap().1.starts_with(&format!("#{owh_a}=IFCOWNERHISTORY(")));
    }

    #[test]
    fn the_person_has_a_name_and_the_owner_history_a_change_action_in_each_schema() {
        for schema in ["IFC2X3", "IFC4"] {
            let mut ids = IdAllocator::after(10);
            let (records, _) = synthesize(schema, &mut ids, &PlanContext::default()).unwrap();
            let person = &records[0].1;
            assert!(person.starts_with("#11=IFCPERSON('ifc-lite','ifc-lite',"), "{schema}: {person}");
            let owner_history = &records.last().unwrap().1;
            assert!(owner_history.contains(".NOCHANGE."), "{schema}: {owner_history}");
        }
    }

    #[test]
    fn ifc2x3_owner_history_still_scans_into_the_declared_attribute_count() {
        let ctx = PlanContext::default();
        let mut a = IdAllocator::after(10);
        let (records, _) = synthesize("IFC2X3", &mut a, &ctx).unwrap();
        for (id, text) in &records {
            let entity_type = text.split('=').nth(1).unwrap().split('(').next().unwrap();
            let names = ifc_lite_core::attribute_names_for_schema("IFC2X3", entity_type).unwrap();
            let inner = text.split_once('(').unwrap().1.trim_end_matches(");");
            let count = crate::step_slot::split_top_level_args(inner).unwrap().len();
            assert_eq!(count, names.len(), "#{id} {entity_type}");
        }
    }
}
