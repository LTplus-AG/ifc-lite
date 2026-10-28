// SPDX-License-Identifier: MPL-2.0
//! Per-slice source checks: shared reporting needs no feature-specific columns.
mod layers;
mod clips;
mod bounded;
use ifc_lite_retained_native::ShapeOnlyProduct;
use ifc_lite_processing::AnalyticQuantitySources;
pub struct OracleResult { pub family: &'static str, pub value: f64, pub limit: f64, pub pass: bool, pub gated: bool }
pub fn check(product: &ShapeOnlyProduct, sources: &AnalyticQuantitySources, tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let mut results = layers::check(product, sources, tolerances);
    results.extend(clips::check(product, sources, tolerances));
    results.extend(bounded::check(product, sources, tolerances));
    results
}
