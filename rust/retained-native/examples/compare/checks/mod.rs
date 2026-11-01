// SPDX-License-Identifier: MPL-2.0
//! Per-slice source checks: shared reporting needs no feature-specific columns.
mod layers;
mod clips;
pub(crate) mod bounded;
pub mod faces;
pub(crate) mod face_sets;
use ifc_lite_retained_native::ShapeOnlyProduct;
use ifc_lite_processing::AnalyticQuantitySources;
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityIndex, SourceBundle};
use std::{cell::OnceCell, sync::Arc};
/// Borrowed model context shared by every slice. Decode independently of the
/// retained result; the analytical summaries alone omit Boolean/plane sources.
pub struct SourceContext<'a> {
    pub product_id: u32,
    pub model: &'a ModelSource<'a>,
    pub hand_volume: Option<f64>,
    pub clips: &'a ifc_lite_retained_native::oracle::clips::ClipOracle<'a>,
    pub analytic: &'a AnalyticQuantitySources,
}
/// One model's source, indexed once and shared by every product's oracles. Each
/// oracle used to rebuild a whole-file index per product, O(products x file size)
/// (#7955: Holter Tower). Every caller still gets a fresh decoder, as before.
pub struct ModelSource<'a> {
    pub bytes: &'a [u8],
    pub bundle: &'a Arc<SourceBundle>,
    index: OnceCell<Arc<EntityIndex>>,
    units: OnceCell<f64>,
}
impl<'a> ModelSource<'a> {
    pub fn new(bytes: &'a [u8], bundle: &'a Arc<SourceBundle>) -> Self {
        Self { bytes, bundle, index: OnceCell::new(), units: OnceCell::new() }
    }
    /// `EntityDecoder::new(bytes)` with the index its first lookup would build.
    pub fn decoder(&self) -> EntityDecoder<'a> {
        let index = self.index.get_or_init(|| Arc::new(build_entity_index(self.bytes)));
        EntityDecoder::with_arc_index(self.bytes, Arc::clone(index))
    }
    /// The project length scale exactly as a fresh plain decoder resolves it.
    pub fn unit_scale(&self) -> f64 {
        *self.units.get_or_init(|| {
            let mut decoder = EntityDecoder::new(self.bytes);
            ifc_lite_geometry::GeometryRouter::with_units(self.bytes, &mut decoder).unit_scale()
        })
    }
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
pub fn check(product: &ShapeOnlyProduct, sources: &SourceContext<'_>, tolerances: &serde_json::Value, bounded: Option<&ifc_lite_retained_native::oracle::bounded::Expectation>) -> Vec<OracleResult> {
    let mut results = layers::check(product, sources, tolerances);
    results.extend(clips::check(product, sources, tolerances));
    results.extend(bounded::check(product, bounded, tolerances, sources.hand_volume, sources.model.bundle));
    results.extend(faces::check(product, sources, tolerances));
    results.extend(face_sets::check(product, sources.model, tolerances));
    results
}
