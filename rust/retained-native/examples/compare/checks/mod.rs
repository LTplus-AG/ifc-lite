// SPDX-License-Identifier: MPL-2.0
//! Per-slice source checks: shared reporting needs no feature-specific columns.
mod layers;
mod clips;
pub(crate) mod bounded;
pub mod faces;
mod face_sets;
use ifc_lite_retained_native::ShapeOnlyProduct;
use ifc_lite_processing::AnalyticQuantitySources;
/// Borrowed model context shared by every slice. Decode independently of the
/// retained result; the analytical summaries alone omit Boolean/plane sources.
pub struct SourceContext<'a> {
    pub product_id: u32,
    pub hand_volume: Option<f64>,
    pub clips: &'a ifc_lite_retained_native::oracle::clips::ClipOracle<'a>,
    pub analytic: &'a AnalyticQuantitySources,
}
// Existing slices can continue accepting their old analytic-only argument.
// Changing that argument to &SourceContext opts into source access without a
// second shared dispatcher edit (M4/M6 are developed in parallel).
impl std::ops::Deref for SourceContext<'_> {
    type Target = AnalyticQuantitySources;
    fn deref(&self) -> &Self::Target { self.analytic }
}
/// Optional independent authority for the existing exact_defect comparison.
/// This is not a product-id allowlist or an alternative publication path.
#[derive(Clone, Copy)]
pub struct SourceAuthority { pub volume: f64, pub bbox: Option<[f64; 6]>, pub curved: bool }
pub struct ClipPartEvidence { pub index: usize, pub curved: bool, pub executed: bool }
#[derive(Default)]
pub struct OracleResult {
    pub family: &'static str, pub value: f64, pub limit: f64, pub pass: bool, pub gated: bool,
    pub authority: Option<SourceAuthority>,
    pub reason: Option<String>,
    pub clip_part: Option<ClipPartEvidence>,
}
pub fn check(product: &ShapeOnlyProduct, sources: &SourceContext<'_>, bytes: &[u8], tolerances: &serde_json::Value, bounded: Option<&ifc_lite_retained_native::oracle::bounded::Expectation>) -> Vec<OracleResult> {
    let mut results = layers::check(product, sources, bytes, tolerances);
    results.extend(clips::check(product, sources, tolerances));
    results.extend(bounded::check(product, bounded, tolerances, sources.hand_volume, bytes));
    results.extend(faces::check(product, sources, tolerances));
    results.extend(face_sets::check(product, bytes, tolerances));
    results
}
