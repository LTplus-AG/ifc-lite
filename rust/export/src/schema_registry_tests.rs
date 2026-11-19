// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EXPORT-MERGE-2 (#7683): the generated export tables are derived from the
//! TypeScript registries under `packages/parser` and `packages/data`, and
//! their CI `--check` steps only compare the Rust output with those sources.
//! Nothing held them to core's EXPRESS registry (`ifc_lite_core`'s
//! `attribute_names_for_schema`), the one home schema conversion now reads
//! attribute lists from. This test does: every row that records an
//! attribute count or an attribute-name list must agree with core for the
//! schema it is keyed on.

use crate::generated::enum_reconciliation::{IFC2X3_ENUM_SLOTS, IFC4X3_ENUM_SLOTS, IFC4_ENUM_SLOTS};
use crate::generated::ifc2x3_required_slots::IFC2X3_REQUIRED_SLOTS;
use crate::generated::ifc4_required_slots::IFC4_REQUIRED_SLOTS;
use crate::generated::step_log_tables::{NAME_LISTS, NONE, RETYPE_ROWS, SLOT_ROWS};
use ifc_lite_core::attribute_names_for_schema;

/// `(schema, type, arity)` rows whose arity differs from core, or whose type
/// core does not declare in that schema at all.
fn disagreements<'a>(schema: &str, rows: impl Iterator<Item = (&'a str, usize)>) -> Vec<String> {
    let mut bad = Vec::new();
    let mut seen = 0usize;
    for (name, arity) in rows {
        seen += 1;
        match attribute_names_for_schema(schema, name) {
            Some(names) if names.len() == arity => {}
            Some(names) => bad.push(format!("{schema} {name}: table {arity}, core {}", names.len())),
            None => bad.push(format!("{schema} {name}: table {arity}, core does not declare it")),
        }
    }
    assert!(seen > 10, "anti-vacuity: {schema} table has {seen} rows");
    bad
}

#[test]
fn every_generated_arity_matches_core_7683() {
    let mut bad = Vec::new();
    bad.extend(disagreements("IFC2X3", IFC2X3_REQUIRED_SLOTS.iter().map(|r| (r.0, usize::from(r.1)))));
    bad.extend(disagreements("IFC4", IFC4_REQUIRED_SLOTS.iter().map(|r| (r.0, usize::from(r.1)))));
    for (schema, table) in [("IFC2X3", IFC2X3_ENUM_SLOTS), ("IFC4", IFC4_ENUM_SLOTS), ("IFC4X3", IFC4X3_ENUM_SLOTS)] {
        bad.extend(disagreements(schema, table.iter().map(|r| (r.0, usize::from(r.1)))));
    }
    assert!(bad.is_empty(), "{} generated rows disagree with core:\n{}", bad.len(), bad.join("\n"));
}

/// The step_log tables carry whole NAME lists rather than a count, so they are
/// compared by name. A slot whose declared name repeats an earlier one is
/// written empty by the generator (`indexOf` never reaches it); that blank is
/// the only difference allowed.
fn names_disagree(schema: &str, name: &str, list: &[&str]) -> Option<String> {
    let core = attribute_names_for_schema(schema, name)?;
    let same = core.len() == list.len()
        && core.iter().zip(list).all(|(c, t)| c == t || (t.is_empty() && core.iter().filter(|n| *n == c).count() > 1));
    (!same).then(|| format!("{schema} {name}: table {list:?}, core {core:?}"))
}

#[test]
fn every_step_log_name_list_matches_core_7683() {
    let mut bad = Vec::new();
    let mut compared = 0usize;
    for (name, lists, ..) in SLOT_ROWS {
        // Columns 4..7 are `getAttributeNamesForSchema` for IFC2X3, IFC4,
        // IFC4X3. That function falls back to another schema's list for a type
        // the schema does not declare, so only declared types are compared.
        for (schema, index) in [("IFC2X3", lists[4]), ("IFC4", lists[5]), ("IFC4X3", lists[6])] {
            if index == NONE {
                continue;
            }
            compared += 1;
            bad.extend(names_disagree(schema, name, NAME_LISTS[usize::from(index)]));
        }
    }
    for (schema, name, list, _) in RETYPE_ROWS {
        if attribute_names_for_schema(schema, name).is_some_and(|core| !core.is_empty()) {
            compared += 1;
            bad.extend(names_disagree(schema, name, NAME_LISTS[usize::from(*list)]));
        }
    }
    assert!(compared > 1000, "anti-vacuity: compared {compared} lists");
    assert!(bad.is_empty(), "{} step_log name lists disagree with core:\n{}", bad.len(), bad.join("\n"));
}

/// How `convert_record` reconciles a source type's attribute list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Adjust {
    Trim,
    Pad,
}

/// Every `(from, to, SOURCE TYPE)` whose attribute list `convert_record`
/// trims or pads, re-derived from core's registry and the rename tables by the
/// same decision tree, for the fixture coverage gate below.
fn adjusted_type_universe() -> std::collections::BTreeMap<(&'static str, &'static str, String), Adjust> {
    let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
    let mut out = std::collections::BTreeMap::new();
    for from in schemas {
        for to in schemas.into_iter().filter(|to| *to != from) {
            for ty in ifc_lite_core::IFC_TYPES.iter() {
                let name = ty.name().to_ascii_uppercase();
                let Some(src) = super::schema_attribute_names(from, &name) else { continue };
                let new_type = super::convert_entity_type(&name, from, to);
                if super::should_skip_entity(&new_type, to)
                    || !crate::schema_unrepresented::has_representation(true, &new_type, to)
                {
                    continue;
                }
                let Some(tgt) = super::schema_attribute_names(to, &new_type) else { continue };
                let adjust = if crate::schema_renames::is_strict_attr_prefix(&name, tgt, src) {
                    Adjust::Trim
                } else if crate::schema_renames::is_strict_attr_prefix(&name, src, tgt) {
                    Adjust::Pad
                } else {
                    continue;
                };
                out.insert((from, to, name), adjust);
            }
        }
    }
    out
}

/// Coverage gate for `tests/fixtures/schema_upconvert_sweep.json`, the shared
/// cross-language pin both converters run (#1416, #7683): every type
/// `convert_record` trims or pads must be NAMED by a fixture row, in both
/// directions. A count floor passes both when rows are silently dropped and
/// when the registry grows a type with no row to pin it. Replaces the gate that
/// re-derived the universe from the deleted `schema_pad` tables, which only
/// ever knew the upgrade-pad half.
#[test]
fn sweep_fixture_names_every_trimmed_and_padded_type_7683() {
    let universe = adjusted_type_universe();
    let count = |want: Adjust| universe.values().filter(|a| **a == want).count();
    assert!(count(Adjust::Trim) > 100 && count(Adjust::Pad) > 100, "anti-vacuity: {universe:?}");

    let raw = include_str!("../tests/fixtures/schema_upconvert_sweep.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let named: std::collections::BTreeSet<(String, String, String)> = doc["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter_map(|c| {
            let ty = c["line"].as_str()?.split_once('=')?.1.split_once('(')?.0;
            Some((c["from"].as_str()?.to_string(), c["to"].as_str()?.to_string(), ty.to_string()))
        })
        .collect();
    let missing: Vec<_> = universe
        .iter()
        .filter(|((f, t, n), _)| !named.contains(&(f.to_string(), t.to_string(), n.clone())))
        .collect();
    assert!(missing.is_empty(), "the sweep fixture names no case for {} adjusted type(s): {missing:?}", missing.len());
}

/// Same-named types whose lists differ in a way that no plan reconciles, with
/// why each may stay. Abstract types have no instances; the structural actions
/// are rewritten by `schema_structural` before any plan runs.
const SOURCE_LAYOUT_EXEMPT: &[(&str, &str)] = &[
    ("IFCCONSTRUCTIONRESOURCE", "abstract in both schemas"),
    ("IFCWORKCONTROL", "abstract in both schemas"),
    ("IFCSURFACETEXTURE", "abstract in both schemas"),
    ("IFCMATERIALPROPERTIES", "abstract in IFC2X3; its downgrade needs the Material referent resolved, so it stays as on main here (#10763 follow-up)"),
    ("IFCPROFILEPROPERTIES", "abstract in IFC2X3, so only the IFC4 downgrade (renamed) has instances"),
    ("IFCSTRUCTURALLINEARACTION", "schema_structural::attributes"),
    ("IFCSTRUCTURALPLANARACTION", "schema_structural::attributes"),
];

/// #10763: a type that keeps its name but whose lists differ in length, or
/// hold one name at two indexes, is either reconciled by a plan or exempt with
/// a reason. Before #10763 every one of these kept its source layout.
#[test]
fn no_same_named_type_keeps_a_shifted_source_layout_10763() {
    use crate::schema_plan::{plan_for, Adjust, Plan};
    let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
    let mut bad = Vec::new();
    let mut mapped = 0usize;
    for from in schemas {
        for to in schemas.into_iter().filter(|to| *to != from) {
            for ty in ifc_lite_core::IFC_TYPES.iter() {
                let name = ty.name().to_ascii_uppercase();
                let Plan::Write { renamed: None, adjust, .. } = plan_for(&name, from, to) else { continue };
                mapped += usize::from(matches!(adjust, Adjust::Mapped(..)));
                let (Some(src), Some(tgt)) = (super::schema_attribute_names(from, &name), super::schema_attribute_names(to, &name)) else { continue };
                let shifted = src.len() != tgt.len() || src.iter().enumerate().any(|(i, n)| tgt.iter().position(|t| t == n).is_some_and(|j| j != i));
                if shifted && adjust == Adjust::Keep && !SOURCE_LAYOUT_EXEMPT.iter().any(|(t, _)| *t == name) {
                    bad.push(format!("{from}->{to} {name}"));
                }
            }
        }
    }
    assert!(mapped >= 4 * 20, "anti-vacuity: {mapped} mapped plans");
    assert!(bad.is_empty(), "{} same-named type(s) keep a shifted source layout:\n{}", bad.len(), bad.join("\n"));
}

/// Same-index name changes reviewed as the same concept and value type, which
/// a positional pass-through therefore keeps right (#10807). Test data only:
/// conversion does not read it, so it never reaches a writer.
const SAME_CONCEPT_AT_INDEX: &[(&str, &str, &str)] = &[
    ("IFCASSET", "AssetID", "Identification"),
    ("IFCDOCUMENTREFERENCE", "ItemReference", "Identification"),
    ("IFCEXTERNALLYDEFINEDHATCHSTYLE", "ItemReference", "Identification"),
    ("IFCEXTERNALLYDEFINEDSURFACESTYLE", "ItemReference", "Identification"),
    ("IFCEXTERNALLYDEFINEDTEXTFONT", "ItemReference", "Identification"),
    ("IFCEXTERNALREFERENCE", "ItemReference", "Identification"),
    ("IFCINVENTORY", "InventoryType", "PredefinedType"),
    ("IFCORGANIZATION", "Id", "Identification"),
    ("IFCPERSON", "Id", "Identification"),
    ("IFCRAMP", "ShapeType", "PredefinedType"),
    ("IFCROOF", "ShapeType", "PredefinedType"),
    ("IFCSTAIR", "ShapeType", "PredefinedType"),
    ("IFCREINFORCINGBAR", "BarRole", "PredefinedType"),
    ("IFCRELCOVERSSPACES", "RelatedSpace", "RelatingSpace"),
    ("IFCSTRUCTURALLOADTEMPERATURE", "DeltaT_Constant", "DeltaTConstant"),
    ("IFCSTRUCTURALLOADTEMPERATURE", "DeltaT_Y", "DeltaTY"),
    ("IFCSTRUCTURALLOADTEMPERATURE", "DeltaT_Z", "DeltaTZ"),
    ("IFCCLASSIFICATION", "Location", "Specification"),
    ("IFCCOMPLEXPROPERTY", "Description", "Specification"),
    ("IFCPROPERTY", "Description", "Specification"),
    ("IFCSIMPLEPROPERTY", "Description", "Specification"),
    ("IFCPROPERTYENUMERATEDVALUE", "Description", "Specification"),
    ("IFCPROPERTYLISTVALUE", "Description", "Specification"),
    ("IFCPROPERTYREFERENCEVALUE", "Description", "Specification"),
    ("IFCPROPERTYSINGLEVALUE", "Description", "Specification"),
    ("IFCCURVESTYLEFONTANDSCALING", "CurveFont", "CurveStyleFont"),
    ("IFCFILLAREASTYLE", "ModelorDraughting", "ModelOrDraughting"),
    ("IFCMATERIALRELATIONSHIP", "Expression", "MaterialExpression"),
    ("IFCSTRUCTURALCURVECONNECTION", "Axis", "AxisDirection"),
    ("IFCWORKTIME", "Start", "StartDate"),
    ("IFCWORKTIME", "Finish", "FinishDate"),
];

/// Same-index name changes whose values another step reconciles, with which.
const AT_INDEX_HANDLED: &[(&str, &str)] = &[
    ("IFCBUILDINGELEMENTPROXY", "CompositionType -> PredefinedType: schema_enum writes a member IFC4 lacks as NOTDEFINED/USERDEFINED and reports it"),
    ("IFCSPACE", "InteriorOrExteriorSpace -> PredefinedType: INTERNAL/EXTERNAL are IfcSpaceTypeEnum members; schema_enum reports the rest"),
    ("IFCBOUNDARYEDGECONDITION", "schema_structural (#9668)"),
    ("IFCBOUNDARYFACECONDITION", "schema_structural (#9668)"),
    ("IFCBOUNDARYNODECONDITION", "schema_structural (#9668)"),
    ("IFCBOUNDARYNODECONDITIONWARPING", "schema_structural (#9668)"),
];

/// #10807: #10763's gate caught lists that differ in length or move a name,
/// but not IfcProcedure, whose IFC2X3 and IFC4 lists have the same length and
/// put different attributes at the same index (`ProcedureType` where IFC4 has
/// `LongDescription`). A type the converter passes through positionally may
/// now differ from the target at an index only by a reviewed in-place rename:
/// `schema_renames`, or [`SAME_CONCEPT_AT_INDEX`]. Anything else is mapped,
/// handled, or exempt with a reason.
#[test]
fn no_same_named_type_passes_a_different_attribute_through_by_position_10807() {
    use crate::schema_plan::{plan_for, Adjust, Plan};
    use crate::schema_renames::{POSITIONAL_RENAMES, POSITIONAL_REPLACEMENTS};
    let reviewed = |ty: &str, a: &str, b: &str| {
        let pair = |(x, y): (&str, &str)| (x == a && y == b) || (x == b && y == a);
        POSITIONAL_RENAMES.iter().filter(|(t, _)| *t == ty).flat_map(|(_, p)| p.iter()).any(|p| pair(*p))
            || POSITIONAL_REPLACEMENTS.iter().any(|(t, p)| *t == ty && pair(*p))
            || SAME_CONCEPT_AT_INDEX.iter().any(|(t, x, y)| *t == ty && pair((x, y)))
    };
    let exempt = |ty: &str| SOURCE_LAYOUT_EXEMPT.iter().chain(AT_INDEX_HANDLED).any(|(t, _)| *t == ty);
    let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
    let (mut bad, mut checked) = (Vec::new(), 0usize);
    for from in schemas {
        for to in schemas.into_iter().filter(|to| *to != from) {
            for ty in ifc_lite_core::IFC_TYPES.iter() {
                let name = ty.name().to_ascii_uppercase();
                let Plan::Write { renamed: None, adjust: Adjust::Keep, .. } = plan_for(&name, from, to) else { continue };
                let (Some(src), Some(tgt)) = (super::schema_attribute_names(from, &name), super::schema_attribute_names(to, &name)) else { continue };
                checked += 1;
                for (a, b) in src.iter().zip(tgt).filter(|(a, b)| a != b) {
                    if !reviewed(&name, a, b) && !exempt(&name) {
                        bad.push(format!("{from}->{to} {name}: {a} at the index of {b}"));
                    }
                }
            }
        }
    }
    assert!(checked > 500, "anti-vacuity: {checked} positional pass-throughs");
    bad.sort();
    bad.dedup();
    assert!(bad.is_empty(), "{} attribute(s) pass through by position into another attribute:\n{}", bad.len(), bad.join("\n"));
}
