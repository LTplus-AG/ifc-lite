// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Immutable inputs and measured output for manual scan correspondences.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationFrame {
    /// SHA-256 of the exact source asset / effective destination IFC snapshot.
    pub asset_sha256: String,
    /// Host-owned frame identity including placement revision. Never an offset guess.
    pub frame_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanCorrespondence {
    pub id: String,
    /// Stable point/neighborhood identity in the original source asset.
    pub source_observation: String,
    /// Stable IFC feature identity; host resolves model + GlobalId + feature.
    pub target_feature: String,
    /// Native orthonormal source-frame metres, before viewer decode-origin shifts.
    pub source: [f64; 3],
    /// Destination IFC world Z-up metres, before viewer Y-up/federation offsets.
    pub target: [f64; 3],
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRegistrationRequest {
    pub source_frame: RegistrationFrame,
    pub target_frame: RegistrationFrame,
    /// At least three distinct non-collinear matches. Maximum 256.
    pub fit: Vec<ScanCorrespondence>,
    /// Observations disjoint from fit. Maximum 256; empty means no check evidence.
    pub held_out: Vec<ScanCorrespondence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrespondenceResidual {
    pub id: String,
    /// Predicted destination minus observed destination, in destination metres.
    pub vector_metres: [f64; 3],
    pub distance_metres: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResiduals {
    pub points: Vec<CorrespondenceResidual>,
    /// None for an empty held-out set; never a misleading zero-error verdict.
    pub rms_metres: Option<f64>,
    pub max_metres: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSpread {
    /// Descending centred point-scatter singular values in metres squared.
    pub singular_values: [f64; 3],
    /// Second / first value: collinearity diagnostic, not plane-normal rank.
    pub non_collinearity_ratio: f64,
    /// Third / first value: zero is valid for planar non-collinear landmarks.
    pub non_planarity_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRegistrationReport {
    /// SHA-256 of serde's compact typed request JSON, prefixed by algorithm ID.
    /// Binds frames, observations, coordinate values and fit/check partition/order.
    pub request_sha256: String,
    pub algorithm: String,
    pub source_frame: RegistrationFrame,
    pub target_frame: RegistrationFrame,
    /// Proper rotation only, row-major. No reflection and no estimated scale.
    pub rotation: [[f64; 3]; 3],
    /// Apply as targetAnchor + rotation * (sourcePoint - sourceAnchor).
    /// Anchored form avoids cancellation from a large standalone translation.
    pub source_anchor: [f64; 3],
    pub target_anchor: [f64; 3],
    pub source_spread: RegistrationSpread,
    pub target_spread: RegistrationSpread,
    pub fit: RegistrationResiduals,
    pub held_out: RegistrationResiduals,
    /// Mathematical fit report only: never a registration/accuracy approval.
    pub diagnostics: Vec<String>,
}
