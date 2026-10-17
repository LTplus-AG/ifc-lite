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
