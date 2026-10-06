// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Scan-to-BIM element proposals (#6894): planes and cylinders from
//! `scan_segmentation` become proposed walls, slabs, columns and pipes in
//! the IFC model frame, each with a confidence, its source detections and
//! their fit statistics. Nothing is created here; the viewer reviews the
//! proposals and creates the accepted ones through its modelling commands.
//!
//! 1. `frame`: every detection moves into the model frame (Z up, metres)
//!    through the `scanToModel` similarity; planes are reclassified there.
//! 2. `levels`: horizontal planes become floors or ceilings.
//! 3. `walls`: opposite vertical faces pair into walls; single faces get a
//!    default thickness behind their scanned side.
//! 4. `slabs`: ceilings pair with the floor above; single ones get a
//!    default thickness on their solid side.
//! 5. `cylinders`: vertical axes are columns, others pipes.
//!
//! Confidence is described in `score`. Every stage is quadratic at worst in
//! the plane count, which is bounded by `MAX_PLANES`.
mod cylinders;
mod frame;
mod levels;
mod options;
mod report;
mod score;
mod slabs;
mod walls;

pub use options::{ProposalSchema, ScanProposalOptions};
pub use report::{
    DetectionKind, DetectionRef, ProposalBasis, ProposalClass, ProposalFit, ProposalGeometry,
    ScanElementProposal, ScanProposalReport, ScanProposalStats,
};

use crate::scan_segmentation::ScanSegmentationReport;
use frame::{Face, Similarity, V3};
use score::Draft;

const ALGORITHM: &str = "ifclite-scan-proposals-v1";
/// Input bound: pairing is quadratic in the vertical plane count.
pub const MAX_PLANES: usize = 20_000;
pub const MAX_CYLINDERS: usize = 20_000;

/// Propose IFC elements for the detections in `report`.
pub fn propose_scan_elements(
    report: &ScanSegmentationReport,
    options: &ScanProposalOptions,
) -> Result<ScanProposalReport, String> {
    let params = options.validate()?;
    if report.planes.len() > MAX_PLANES || report.cylinders.len() > MAX_CYLINDERS {
        return Err(format!("Scan proposals accept at most {MAX_PLANES} planes and {MAX_CYLINDERS} cylinders"));
    }
    let transform = Similarity::from_row_major(&options.scan_to_model)?;
    let detections = frame::to_model(report, &transform);
    let faces = detections.faces;
    let mut stats = ScanProposalStats::default();
    let (mut vertical, mut horizontal) = (Vec::new(), Vec::new());
    for (i, face) in faces.iter().enumerate() {
        let up = face.normal[2].abs();
        if up >= params.cos_class {
            horizontal.push(i);
        } else if up <= params.sin_class {
            vertical.push(i);
        } else {
            stats.sloped_planes += 1;
        }
    }
    stats.vertical_planes = vertical.len() as u32;
    stats.horizontal_planes = horizontal.len() as u32;
    let interior = params.interior.unwrap_or_else(|| area_weighted_centroid(&faces));
    let levels = levels::classify(&faces, &horizontal, &vertical, interior, params.snap);

    let walls = walls::propose(&faces, &vertical, &levels, interior, &params, &mut stats);
    let slabs = slabs::propose(&faces, &levels, &params, &mut stats);
    let tubes = cylinders::propose(&detections.tubes, &faces, &levels, &params, &mut stats);
    let mut proposals = Vec::new();
    number("wall", walls, &mut proposals);
    number("slab", slabs, &mut proposals);
    let (columns, pipes): (Vec<Draft>, Vec<Draft>) =
        tubes.into_iter().partition(|d| d.class == ProposalClass::IfcColumn);
    number("column", columns, &mut proposals);
    number("pipe", pipes, &mut proposals);
    Ok(ScanProposalReport { algorithm: ALGORITHM.into(), proposals, transform_scale: transform.scale, stats })
}

/// Order by descending support (ties by first source) and assign ids.
fn number(prefix: &str, mut drafts: Vec<Draft>, out: &mut Vec<ScanElementProposal>) {
    drafts.sort_by(|a, b| {
        b.support.total_cmp(&a.support).then_with(|| a.sources.first().map(|s| s.index).cmp(&b.sources.first().map(|s| s.index)))
    });
    for (i, d) in drafts.into_iter().enumerate() {
        out.push(ScanElementProposal {
            id: format!("{prefix}-{i}"),
            ifc_class: d.class,
            confidence: d.confidence,
            basis: d.basis,
            sources: d.sources,
            fit: d.fit,
            geometry: d.geometry,
        });
    }
}

fn area_weighted_centroid(faces: &[Face]) -> V3 {
    let total: f64 = faces.iter().map(|f| f.area).sum();
    if total <= 0. {
        return [0.; 3];
    }
    let mut sum = [0.; 3];
    for f in faces {
        for (s, c) in sum.iter_mut().zip(f.centroid) {
            *s += c * f.area / total;
        }
    }
    sum
}

#[cfg(test)]
#[path = "proposals_tests.rs"]
mod tests;
