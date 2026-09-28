// SPDX-License-Identifier: MPL-2.0
//! Opt-in authored quantity observations. The regular export row's inherited
//! precedence is intentionally not used here: both sides of a conflict matter.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use ifc_lite_core::{AttributeValue, EntityDecoder, EntityIndex, EntityScanner, IfcType, ProjectUnits};
use serde::Serialize;

use crate::model::props::decode_quantity_records;

#[path = "quantity_analysis_units.rs"]
mod units;
#[path = "quantity_analysis_budget.rs"]
mod budget;
#[path = "quantity_analysis_diagnostics.rs"]
mod diagnostics;
#[path = "quantity_analysis_relations.rs"]
mod relations;
use budget::{AnalysisLimits, ExpansionBudget, LeafBudgetError};
use diagnostics::Diagnostics;

const MAX_REL_MEMBERS: usize = 100_000;
const MAX_REF_RECORD_BYTES: usize = 2_000_000;
const MAX_AUTHORED_ROWS: usize = 100_000;
const MAX_QUANTITY_LEAF_VISITS: usize = 100_000;
const MAX_SET_DECODE_BYTES: usize = 128_000_000;
const MAX_LEAF_DECODE_BYTES: usize = 128_000_000;
const MAX_SET_VISITS: usize = 100_000;
const MAX_REL_LINKS: usize = 100_000;
const MAX_CONFLICT_COMPARISONS: usize = 100_000;

fn report_once(diagnostics: &mut Diagnostics, message: &'static str) {
    diagnostics.report_once(message);
}

enum QuantityOrigin { Occurrence, Type(u32) }

struct SourceSets<'a> { ids: &'a [u32], origin: QuantityOrigin }
impl QuantityOrigin {
    fn fields(&self) -> (&'static str, Option<u32>) {
        match self { Self::Occurrence => ("occurrence", None), Self::Type(id) => ("type", Some(*id)) }
    }
}

/// An IFC-authored physical simple quantity, with its two source entity IDs.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct AuthoredQuantity {
    pub set_name: String,
    pub quantity_name: String,
    pub set_id: u32,
    pub quantity_id: u32,
    pub kind: &'static str,
    pub value: f64,
    /// `occurrence` or `type`; type values are never hidden by occurrence values.
    pub origin: &'static str,
    pub type_id: Option<u32>,
    pub unit: Option<QuantityUnit>,
    pub unit_diagnostic: Option<String>,
}

/// Resolved IFC unit, including an explicit quantity override when supplied.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
#[allow(non_snake_case)] // Public IFC attribute spelling is the contract.
pub struct QuantityUnit {
    pub symbol: String,
    pub si_scale: f64,
    pub source: &'static str,
    pub unit_id: Option<u32>,
    /// IFC `IfcNamedUnit.UnitType` token, when it can be resolved.
    pub UnitType: Option<String>,
}

/// Same named authored occurrence and type quantity disagree in value or unit.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct QuantityConflict {
    pub set_name: String,
    pub quantity_name: String,
    pub occurrence_quantity_ids: Vec<u32>,
    pub type_quantity_ids: Vec<u32>,
}

/// One actual product occurrence; no row here represents a type product.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct ProductQuantities {
    pub ifc_type: String,
    pub authored: Vec<AuthoredQuantity>,
    pub conflicts: Vec<QuantityConflict>,
}

/// Observations keyed by product STEP ID. `product_count` counts IFC product
/// entities, not represented solids or physical parts.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct AuthoredQuantityAnalysis {
    pub product_count: usize,
    pub products: BTreeMap<u32, ProductQuantities>,
    pub diagnostics: Vec<String>,
}

fn add_sets(
    decoder: &mut EntityDecoder, project_units: &ProjectUnits,
    index: &EntityIndex,
    product: &mut ProductQuantities, source_sets: SourceSets<'_>,
    budget: &mut ExpansionBudget, diagnostics: &mut Diagnostics,
) {
    if budget.rows == 0 {
        if !source_sets.ids.is_empty() {
            report_once(diagnostics, "authored quantity rows exceed work budget");
        }
        return;
    }
    let mut seen = HashSet::new();
    for &set_id in source_sets.ids {
        if budget.sets == 0 {
            report_once(diagnostics, "authored quantity set visits exceed work budget");
            return;
        }
        budget.sets -= 1;
        if !seen.insert(set_id) { continue; }
        let record_bytes = index.get(&set_id).map_or(0, |(start, end)| end.saturating_sub(*start));
        if record_bytes > MAX_REF_RECORD_BYTES {
            diagnostics.push(format!("quantity set #{set_id}: record exceeds work budget"));
            continue;
        }
        if budget.leaf_counts.get(&set_id).is_some_and(|count| *count > budget.leaves) {
            report_once(diagnostics, "quantity leaf visits exceed work budget");
            continue;
        }
        if record_bytes > budget.set_bytes {
            report_once(diagnostics, "quantity set decode bytes exceed work budget");
            continue;
        }
        budget.set_bytes -= record_bytes;
        let Ok(set) = decoder.decode_by_id(set_id) else {
            diagnostics.push(format!("quantity set #{set_id}: cannot decode"));
            continue;
        };
        if set.ifc_type != IfcType::IfcElementQuantity { continue; }
        let Some(leaf_count) = set.get(5).and_then(AttributeValue::as_list).map(|items| items.len()) else {
            diagnostics.push(format!("quantity set #{set_id}: malformed quantity list"));
            continue;
        };
        budget.leaf_counts.insert(set_id, leaf_count);
        let refs = set.get(5).and_then(AttributeValue::as_list).expect("checked quantity list");
        if let Err(error) = budget.charge_leaf_refs(refs, index) {
            match error {
                LeafBudgetError::Visits => report_once(diagnostics, "quantity leaf visits exceed work budget"),
                LeafBudgetError::Bytes => report_once(diagnostics, "quantity leaf decode bytes exceed work budget"),
                LeafBudgetError::Oversized(id) => diagnostics.push(format!(
                    "quantity set #{set_id}: quantity #{id} record exceeds work budget")),
            }
            continue;
        }
        let Some((set_name, records)) = decode_quantity_records(decoder, &set, Some(MAX_REL_MEMBERS)) else {
            diagnostics.push(format!("quantity set #{set_id}: malformed or over work budget"));
            continue;
        };
        for record in records {
            if budget.rows == 0 {
                report_once(diagnostics, "authored quantity rows exceed work budget");
                return;
            }
            budget.rows -= 1;
            let Some(kind) = units::express_kind(record.value.kind) else {
                diagnostics.push(format!("quantity #{}: unsupported quantity kind {}", record.id, record.value.kind));
                continue;
            };
            let (unit, unit_diagnostic) = units::resolve_quantity_unit(
                decoder, project_units, kind, record.unit_id, record.invalid_unit_ref);
            let (origin, type_id) = source_sets.origin.fields();
            product.authored.push(AuthoredQuantity {
                set_name: set_name.clone(), quantity_name: record.value.name,
                set_id, quantity_id: record.id, kind, value: record.value.value,
                origin, type_id, unit, unit_diagnostic,
            });
        }
    }
}

fn conflicts(
    authored: &[AuthoredQuantity], remaining: &mut usize, diagnostics: &mut Diagnostics,
) -> Vec<QuantityConflict> {
    type OriginPair<'a> = (Vec<&'a AuthoredQuantity>, Vec<&'a AuthoredQuantity>);
    let mut grouped: BTreeMap<(&str, &str), OriginPair<'_>> = BTreeMap::new();
    for quantity in authored {
        let pair = grouped.entry((&quantity.set_name, &quantity.quantity_name)).or_default();
        if quantity.origin == "occurrence" { pair.0.push(quantity); } else { pair.1.push(quantity); }
    }
    let mut found = Vec::new();
    for ((set_name, quantity_name), (occ, inherited)) in grouped {
        if occ.is_empty() || inherited.is_empty() { continue; }
        let mut different = false;
        'pairs: for a in &occ {
            for b in &inherited {
                if *remaining == 0 {
                    report_once(diagnostics, "authored quantity conflict comparisons exceed work budget");
                    return found;
                }
                *remaining -= 1;
                if !units::same_physical_value(a, b) {
                    different = true;
                    break 'pairs;
                }
            }
        }
        if different {
            found.push(QuantityConflict {
                set_name: set_name.into(), quantity_name: quantity_name.into(),
                occurrence_quantity_ids: occ.iter().map(|q| q.quantity_id).collect(),
                type_quantity_ids: inherited.iter().map(|q| q.quantity_id).collect(),
            });
        }
    }
    found
}

/// Read authored quantities without meshing. `ids` restricts emitted product
/// rows; an empty set emits none. Relationship fan-out and quantity lists have
/// explicit work budgets and report refusal rather than truncating silently.
pub fn analyze_authored_quantities(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> AuthoredQuantityAnalysis {
    analyze_with_budgets(content, ids, MAX_AUTHORED_ROWS, MAX_SET_VISITS, MAX_CONFLICT_COMPARISONS)
}

fn analyze_with_budgets(
    content: &[u8], ids: Option<&HashSet<u32>>, row_budget: usize, set_budget: usize,
    comparison_budget: usize,
) -> AuthoredQuantityAnalysis {
    analyze_with_limits(content, ids, AnalysisLimits { rows: row_budget,
        sets: set_budget, comparisons: comparison_budget, ..Default::default() })
}

fn analyze_with_limits(
    content: &[u8], ids: Option<&HashSet<u32>>, limits: AnalysisLimits,
) -> AuthoredQuantityAnalysis {
    if ids.is_some_and(HashSet::is_empty) {
        return AuthoredQuantityAnalysis {
            product_count: 0, products: BTreeMap::new(), diagnostics: Vec::new(),
        };
    }
    let mut products = BTreeMap::new();
    let mut project_id = None;
    let mut products_scan = EntityScanner::new(content);
    while let Some((id, name, _, _)) = products_scan.next_entity() {
        if ifc_lite_core::keyword_eq(name, "IFCPROJECT") { project_id.get_or_insert(id); }
        if ids.is_some_and(|selected| !selected.contains(&id)) { continue; }
        let kind = ifc_lite_core::ifc_type_from_keyword(name);
        if kind.is_subtype_of(IfcType::IfcProduct) {
            products.insert(id, ProductQuantities {
                ifc_type: kind.name().into(), authored: Vec::new(), conflicts: Vec::new(),
            });
        }
    }
    let product_count = products.len();
    let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(content));
    let mut decoder = EntityDecoder::with_arc_index(content, index.clone());
    let mut diagnostics = Diagnostics::default();
    let relations = relations::collect_relationships(
        content, &mut decoder, &products, limits.links, &mut diagnostics);
    let direct = relations.direct;
    let typed = relations.typed;
    let project_units = project_id.map(|id| ProjectUnits::resolve(&mut decoder, id)).unwrap_or_default();
    let mut type_defs = HashMap::<u32, Vec<u32>>::new();
    let mut budget = ExpansionBudget { rows: limits.rows, sets: limits.sets,
        leaves: limits.leaves, set_bytes: limits.set_bytes, leaf_bytes: limits.leaf_bytes,
        leaf_counts: HashMap::new() };
    let mut remaining_comparisons = limits.comparisons;
    for (id, product) in &mut products {
        if budget.rows == 0 || budget.sets == 0 {
            if direct.contains_key(id) || typed.contains_key(id) {
                report_once(&mut diagnostics, if budget.rows == 0 {
                    "authored quantity rows exceed work budget"
                } else { "authored quantity set visits exceed work budget" });
            }
            continue;
        }
        if let Some(defs) = direct.get(id) {
            add_sets(&mut decoder, &project_units, &index, product,
                SourceSets { ids: defs, origin: QuantityOrigin::Occurrence }, &mut budget,
                &mut diagnostics);
        }
        if let Some(&type_id) = typed.get(id) {
            let defs = type_defs.entry(type_id).or_insert_with(|| {
                if index.get(&type_id).is_some_and(|(start, end)| end.saturating_sub(*start) > MAX_REF_RECORD_BYTES) {
                    diagnostics.push(format!("type #{type_id}: record exceeds work budget"));
                    return Vec::new();
                }
                let Ok(type_entity) = decoder.decode_by_id(type_id) else {
                    diagnostics.push(format!("type #{type_id}: cannot decode"));
                    return Vec::new();
                };
                if !type_entity.ifc_type.is_subtype_of(IfcType::IfcTypeObject) {
                    diagnostics.push(format!("type #{type_id}: not IfcTypeObject"));
                    return Vec::new();
                }
                let Some(value) = type_entity.get(5) else {
                    diagnostics.push(format!("type #{type_id}: missing HasPropertySets"));
                    return Vec::new();
                };
                if value.is_null() { return Vec::new(); }
                let Some(list) = value.as_list() else {
                    diagnostics.push(format!("type #{type_id}: malformed HasPropertySets"));
                    return Vec::new();
                };
                if list.len() > MAX_REL_MEMBERS {
                    diagnostics.push(format!("type #{type_id}: HasPropertySets exceeds work budget"));
                    return Vec::new();
                }
                let mut refs = Vec::with_capacity(list.len());
                for member in list {
                    let Some(id) = member.as_entity_ref() else {
                        diagnostics.push(format!("type #{type_id}: malformed HasPropertySets member"));
                        return Vec::new();
                    };
                    refs.push(id);
                }
                refs
            });
            add_sets(&mut decoder, &project_units, &index, product,
                SourceSets { ids: defs, origin: QuantityOrigin::Type(type_id) }, &mut budget,
                &mut diagnostics);
        }
        product.conflicts = conflicts(&product.authored, &mut remaining_comparisons, &mut diagnostics);
    }
    AuthoredQuantityAnalysis { product_count, products, diagnostics: diagnostics.finish() }
}

#[cfg(test)]
#[path = "quantity_analysis_tests.rs"]
mod tests;
