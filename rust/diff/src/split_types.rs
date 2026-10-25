// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::{model::EntityFingerprint, geometry_compare::positive_or};
use crate::class_families::normalize_class;
use crate::utf16::cmp_code_units;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitMergeKind { Split, Merge }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitConfidence { Verified, Extent, Displaced }
#[derive(Debug)]
pub struct SplitMergeClaim<'a, R> {
    pub kind: SplitMergeKind,
    pub confidence: SplitConfidence,
    pub whole: &'a EntityFingerprint<R>,
    pub pieces: Vec<&'a EntityFingerprint<R>>,
    pub whole_volume: Option<f64>,
    pub pieces_volume: Option<f64>,
    pub volume_residual: Option<f64>,
    pub excluded: Option<&'a EntityFingerprint<R>>,
    pub cross_class: bool,
}
#[derive(Debug, Clone, Copy)]
pub struct SplitSettings {
    pub volume_tolerance: f64,
    pub padding_min: f64,
    pub padding_ratio: f64,
    pub max_pieces: f64,
}
impl Default for SplitSettings {
    fn default() -> Self { Self::resolve(None, None, None, None) }
}
impl SplitSettings {
    pub fn resolve(volume: Option<f64>, min: Option<f64>, ratio: Option<f64>, cap: Option<f64>) -> Self {
        Self { volume_tolerance: positive_or(volume, 0.03), padding_min: positive_or(min, 0.05),
            padding_ratio: positive_or(ratio, 0.01),
            max_pieces: cap.filter(|v| v.is_finite() && v.floor() >= 2.0).map(f64::floor).unwrap_or(256.0) }
    }
}
pub(crate) fn claim_of<'a, R>(kind: SplitMergeKind, confidence: SplitConfidence,
    whole: &'a EntityFingerprint<R>, mut pieces: Vec<&'a EntityFingerprint<R>>,
    volumes: Option<(f64, f64, f64)>, excluded: Option<&'a EntityFingerprint<R>>) -> SplitMergeClaim<'a, R> {
    pieces.sort_by(|a, b| cmp_code_units(&a.key, &b.key).then_with(|| cmp_code_units(&a.data_hash, &b.data_hash)));
    let cross_class = pieces.iter().any(|p| normalize_class(&p.ifc_type) != normalize_class(&whole.ifc_type));
    SplitMergeClaim { kind, confidence, whole, pieces, whole_volume: volumes.map(|v| v.0),
        pieces_volume: volumes.map(|v| v.1), volume_residual: volumes.map(|v| v.2), excluded, cross_class }
}
