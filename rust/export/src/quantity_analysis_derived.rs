// SPDX-License-Identifier: MPL-2.0
//! Opt-in join of authored quantities with canonical analytic source occurrences.
//! No meshing or second representation/reference walk occurs here.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use ifc_lite_processing::{extract_analytic_quantity_sources, AnalyticSourceKey,
    SweptDiskInstance};
use serde::Serialize;

use crate::quantity_analysis::{analyze_authored_quantities, AuthoredQuantity, QuantityConflict};

/// A source parameter or nominal measurement, never a final cut-product takeoff.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct DerivedQuantity {
    pub name: &'static str,
    pub value: f64,
    pub unit: &'static str,
    pub formula: &'static str,
    pub origin: &'static str,
    pub source_solid_ids: Vec<u32>,
    pub limitation: &'static str,
    pub status: &'static str,
}

/// One use of a source solid by a product. Repeated map uses remain separate.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct QuantitySourceOccurrence {
    pub source_kind: &'static str,
    pub source: AnalyticSourceKey,
    pub ordinal: usize,
    pub solid_id: u32,
    pub mapping_path: Vec<u32>,
    pub source_modified: bool,
    pub status: &'static str,
    /// Explains unsupported sources and missing nominal swept-disk quantities.
    pub status_reason: Option<String>,
    pub quantities: Vec<DerivedQuantity>,
}

/// Authored observations and nominal source estimates for one IFC product.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct ProductQuantityAnalysis {
    pub ifc_type: String,
    pub authored: Vec<AuthoredQuantity>,
    pub conflicts: Vec<QuantityConflict>,
    pub source_occurrence_count: usize,
    pub unique_source_count: usize,
    pub sources: Vec<QuantitySourceOccurrence>,
    /// Always absent: overlap, voids and CSG may change the visible product.
    pub product_total: Option<f64>,
    pub aggregate_diagnostic: String,
}

/// Product and unique geometric source counts are different, especially for maps.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct QuantityAnalysis {
    pub product_count: usize,
    pub source_occurrence_count: usize,
    pub unique_source_count: usize,
    pub products: BTreeMap<u32, ProductQuantityAnalysis>,
    pub diagnostics: Vec<String>,
}

const MAX_JOINED_DIAGNOSTICS: usize = 1_024;
const JOINED_DIAGNOSTICS_TRUNCATED: &str = "quantity analysis diagnostics exceed work budget";

#[derive(Default)]
struct JoinedDiagnostics {
    messages: Vec<String>,
    seen: HashSet<String>,
    truncated: bool,
}

impl JoinedDiagnostics {
    fn push(&mut self, message: String) {
        if self.seen.contains(&message) { return; }
        if self.messages.len() >= MAX_JOINED_DIAGNOSTICS {
            self.truncated = true;
        } else {
            self.seen.insert(message.clone());
            self.messages.push(message);
        }
    }

    fn finish(mut self) -> Vec<String> {
        if self.truncated { self.messages.push(JOINED_DIAGNOSTICS_TRUNCATED.into()); }
        self.messages
    }
}

fn quantity(name: &'static str, value: f64, unit: &'static str,
    formula: &'static str, origin: &'static str, solid_id: u32,
    status: &'static str) -> DerivedQuantity {
    let limitation = if origin == "authored_source_parameter" {
        "IFC solid parameter, not an authored product quantity or final cut measurement"
    } else if unit.starts_with("ifc_file_length_units") {
        "Unplaced nominal source estimate; occurrence scale, voids and CSG are excluded"
    } else {
        "Nominal uncut source estimate; overlap, voids and cutting allowances are excluded"
    };
    DerivedQuantity { name, value, unit, formula, origin,
        source_solid_ids: vec![solid_id], limitation, status }
}

fn source_status(instance: &SweptDiskInstance) -> (&'static str, Option<String>) {
    match &instance.status {
        ifc_lite_geometry::analytic::AnalyticStatus::Unsupported(reason) =>
            ("unsupported", Some(reason.clone())),
        ifc_lite_geometry::analytic::AnalyticStatus::Complete if instance.source_modified =>
            ("source_modified", Some("CSG operand; final product geometry differs from this source".into())),
        ifc_lite_geometry::analytic::AnalyticStatus::Complete => ("complete", None),
    }
}

/// Join three canonical opt-in analytic views with exact authored observations.
/// `ids` selects actual product occurrences; an empty set returns no rows.
/// Source measurements are nominal and intentionally never summed into a
/// product material quantity, cutting length, or physical-part count.
pub fn analyze_quantities(content: &[u8], ids: Option<&HashSet<u32>>) -> QuantityAnalysis {
    let authored = analyze_authored_quantities(content, ids);
    if authored.products.is_empty() {
        let mut diagnostics = JoinedDiagnostics::default();
        for message in authored.diagnostics { diagnostics.push(message); }
        return QuantityAnalysis { product_count: 0, source_occurrence_count: 0,
            unique_source_count: 0, products: BTreeMap::new(),
            diagnostics: diagnostics.finish() };
    }
    let selected: HashSet<u32> = authored.products.keys().copied().collect();
    let analytic = extract_analytic_quantity_sources(content, Some(&selected));
    let disks = analytic.swept_disk_descriptions;
    let disk_defs = analytic.swept_disk_definitions;
    let extrusions = analytic.extrusion_definitions;
    let extrusion_sources: BTreeMap<_, _> = extrusions.sources.iter()
        .map(|source| (&source.key, source)).collect();
    let mut diagnostics = JoinedDiagnostics::default();
    for message in authored.diagnostics.into_iter().chain(disks.diagnostics)
        .chain(disk_defs.diagnostics).chain(extrusions.diagnostics) {
        diagnostics.push(message);
    }
    let mut products = BTreeMap::new();
    let mut unique_sources = BTreeSet::new();
    let mut source_occurrence_count = 0;
    for (product_id, product) in authored.products {
        let mut sources = Vec::new();
        for instance in disk_defs.instances.get(&product_id).into_iter().flatten() {
            let Some(description) = disks.elements.get(&product_id)
                .and_then(|items| items.get(instance.ordinal)) else {
                diagnostics.push(format!("product #{product_id}: swept disk occurrence ordinal {} has no description", instance.ordinal));
                continue;
            };
            if description.solid_id != instance.solid_id ||
                description.mapping_path != instance.mapping_path {
                diagnostics.push(format!("product #{product_id}: swept disk source/description mismatch at ordinal {}", instance.ordinal));
                continue;
            }
            let (status, mut status_reason) = source_status(instance);
            let mut quantities = Vec::new();
            if let Some(metrics) = description.directrix_metrics() {
                quantities.push(quantity("centreline_length", metrics.total_length, "m",
                    "sum(exact directrix segment lengths)", "derived", instance.solid_id, status));
            }
            if let Some(nominal) = description.nominal_quantities() {
                quantities.push(quantity("cross_section_area", nominal.cross_section_area, "m2",
                    "pi * (outer_radius^2 - inner_radius^2)", "derived", instance.solid_id, status));
                quantities.push(quantity("nominal_volume", nominal.nominal_volume, "m3",
                    "cross_section_area * centreline_length", "derived", instance.solid_id, status));
                quantities.push(quantity("outer_lateral_area", nominal.outer_lateral_area, "m2",
                    "2 * pi * outer_radius * centreline_length", "derived", instance.solid_id, status));
                if let Some(inner) = nominal.inner_lateral_area {
                    quantities.push(quantity("inner_lateral_area", inner, "m2",
                        "2 * pi * inner_radius * centreline_length", "derived", instance.solid_id, status));
                }
            } else if status == "complete" {
                status_reason = Some("Nominal swept-disk quantities unavailable: source geometry or directrix does not support a valid sweep".into());
            }
            unique_sources.insert(instance.source.clone());
            sources.push(QuantitySourceOccurrence { source_kind: "IfcSweptDiskSolid",
                source: instance.source.clone(), ordinal: instance.ordinal,
                solid_id: instance.solid_id, mapping_path: instance.mapping_path.clone(),
                source_modified: instance.source_modified, status, status_reason, quantities });
        }
        for instance in extrusions.instances.get(&product_id).into_iter().flatten() {
            let Some(definition) = extrusion_sources.get(&instance.source) else {
                diagnostics.push(format!("product #{product_id}: extrusion source #{} is missing", instance.solid_id));
                continue;
            };
            let (status, status_reason) = source_status(instance);
            let mut quantities = Vec::new();
            if let Some(depth) = definition.source.depth.filter(|value| value.is_finite()) {
                quantities.push(quantity("Depth", depth, "ifc_file_length_units",
                    "IfcExtrudedAreaSolid.Depth", "authored_source_parameter", instance.solid_id, status));
            }
            if let Some(nominal) = &definition.nominal_quantities {
                quantities.push(quantity("profile_area", nominal.profile_area, "ifc_file_length_units2",
                    "outer profile loop area - inner profile loop areas", "derived", instance.solid_id, status));
                quantities.push(quantity("projected_height", nominal.projected_height, "ifc_file_length_units",
                    "Depth * abs(dot(extrusion_direction, profile_normal))", "derived", instance.solid_id, status));
                quantities.push(quantity("nominal_volume", nominal.nominal_volume, "ifc_file_length_units3",
                    "profile_area * projected_height", "derived", instance.solid_id, status));
            }
            unique_sources.insert(instance.source.clone());
            sources.push(QuantitySourceOccurrence { source_kind: "IfcExtrudedAreaSolid",
                source: instance.source.clone(), ordinal: instance.ordinal,
                solid_id: instance.solid_id, mapping_path: instance.mapping_path.clone(),
                source_modified: instance.source_modified, status, status_reason, quantities });
        }
        source_occurrence_count += sources.len();
        let unique_source_count = sources.iter().map(|item| &item.source).collect::<BTreeSet<_>>().len();
        let aggregate_diagnostic = if sources.is_empty() {
            "No supported analytic source is represented; a product total cannot be inferred"
        } else if sources.iter().any(|item| item.source_modified) {
            "CSG changes source geometry; source measurements cannot be summed as a product total"
        } else if sources.iter().any(|item| item.status != "complete") {
            "Unsupported analytic occurrence prevents a certified product total"
        } else if sources.len() > 1 {
            "Multiple source uses may overlap or repeat; a product total cannot be inferred"
        } else {
            "Nominal source geometry excludes openings, voids and cutting allowances; a final product total cannot be inferred"
        };
        products.insert(product_id, ProductQuantityAnalysis {
            ifc_type: product.ifc_type, authored: product.authored,
            conflicts: product.conflicts, source_occurrence_count: sources.len(),
            unique_source_count, sources, product_total: None,
            aggregate_diagnostic: aggregate_diagnostic.into() });
    }
    QuantityAnalysis { product_count: products.len(), source_occurrence_count,
        unique_source_count: unique_sources.len(), products, diagnostics: diagnostics.finish() }
}

#[cfg(test)]
#[path = "quantity_analysis_derived_tests.rs"]
mod tests;
