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
    let time_stamp = context
        .time_stamp
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

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

#[cfg(test)]
mod tests {
    use super::*;

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
