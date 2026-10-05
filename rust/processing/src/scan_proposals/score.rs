// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Confidence and fit statistics shared by every proposal kind.
//!
//! `confidence = prior(basis) * quality(rms) * coverage`, where
//! `quality(rms) = 1 / (1 + (rms / 1 cm)^2)` (0.92 at 3 mm, 0.5 at 1 cm) and
//! `coverage` is the share of the proposed surface the inliers occupy (for a
//! cylinder, `0.5 + 0.5 * arc / 360`). Priors: paired faces and floor/ceiling
//! pairs 0.95, cylinders 0.9, single floors and ceilings 0.75, single wall
//! faces 0.7: a measured thickness beats a default one.
use super::frame::{Face, Tube};
use super::report::{DetectionKind, DetectionRef, ProposalBasis, ProposalClass, ProposalFit, ProposalGeometry};

const RMS_SCALE_METRES: f64 = 0.01;

pub(crate) fn prior(basis: ProposalBasis) -> f64 {
    match basis {
        ProposalBasis::PairedFaces | ProposalBasis::FloorCeilingPair => 0.95,
        ProposalBasis::Cylinder => 0.9,
        ProposalBasis::Floor | ProposalBasis::Ceiling => 0.75,
        ProposalBasis::SingleFace => 0.7,
    }
}

pub(crate) fn confidence(basis: ProposalBasis, rms: f64, coverage: f64) -> f64 {
    let quality = 1. / (1. + (rms / RMS_SCALE_METRES).powi(2));
    let value = prior(basis) * quality * coverage.clamp(0., 1.);
    // Three decimals: the value is a ranking aid, not a measurement.
    (value * 1000.).round() / 1000.
}

/// A proposal before ids are assigned; `support` orders proposals of a class.
pub(crate) struct Draft {
    pub class: ProposalClass,
    pub basis: ProposalBasis,
    pub confidence: f64,
    pub sources: Vec<DetectionRef>,
    pub fit: ProposalFit,
    pub geometry: ProposalGeometry,
    pub support: f64,
}

fn pooled_rms(parts: impl Iterator<Item = (f64, u64)>) -> (f64, u64) {
    let (mut sum, mut voxels) = (0., 0_u64);
    for (rms, n) in parts {
        sum += rms * rms * n as f64;
        voxels += n;
    }
    (if voxels > 0 { (sum / voxels as f64).sqrt() } else { 0. }, voxels)
}

pub(crate) fn face_fit(faces: &[&Face]) -> (Vec<DetectionRef>, ProposalFit) {
    let sources = faces.iter().map(|f| DetectionRef { kind: DetectionKind::Plane, index: f.index }).collect();
    let (rms, voxels) = pooled_rms(faces.iter().map(|f| (f.rms, u64::from(f.inlier_voxels))));
    let fit = ProposalFit {
        rms_metres: rms,
        inlier_points: faces.iter().map(|f| f.inlier_points).sum(),
        inlier_voxels: voxels,
        area_square_metres: faces.iter().map(|f| f.area).sum(),
    };
    (sources, fit)
}

pub(crate) fn tube_fit(tube: &Tube) -> (Vec<DetectionRef>, ProposalFit) {
    let length = super::frame::norm(super::frame::sub(tube.end, tube.start));
    let fit = ProposalFit {
        rms_metres: tube.rms,
        inlier_points: tube.inlier_points,
        inlier_voxels: u64::from(tube.inlier_voxels),
        area_square_metres: tube.arc_degrees.to_radians() * tube.radius * length,
    };
    (vec![DetectionRef { kind: DetectionKind::Cylinder, index: tube.index }], fit)
}
