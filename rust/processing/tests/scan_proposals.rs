// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Element proposals from real segmentation of seeded synthetic scans
//! (#6894): the two-room scan of #6870 (a 0.2 m partition with a door,
//! exterior walls seen from inside only, floor, two ceilings, two columns,
//! a sloped panel) and the cylinder room (a column and a pipe among decoys).
//!
//! Tolerances, stated once: positions and thicknesses within
//! `POSITION_TOLERANCE_METRES` (segmented planes sit within a voxel of the
//! sampled surface), radii within 1 cm, heights within `POSITION_TOLERANCE`
//! after snapping to the detected floor and ceiling.

mod scan_synthetic;

use ifc_lite_processing::scan_proposals::{
    propose_scan_elements, ProposalBasis, ProposalClass, ProposalGeometry, ProposalSchema, ScanElementProposal,
    ScanProposalOptions, ScanProposalReport,
};
use ifc_lite_processing::scan_segmentation::{segment_scan_points, ScanSegmentationOptions, ScanSegmentationReport};
use scan_synthetic::{cylinder_room, two_rooms, ScanSpec};
use std::sync::OnceLock;

const POSITION_TOLERANCE_METRES: f64 = 0.03;
/// Where a wall ends along its run follows the face extents, which move by
/// up to two voxels plus noise with the voxel lattice (#6870's extent bound).
const EXTENT_TOLERANCE_METRES: f64 = 0.08;

fn two_room_report() -> &'static ScanSegmentationReport {
    static REPORT: OnceLock<ScanSegmentationReport> = OnceLock::new();
    REPORT.get_or_init(|| {
        let scan = two_rooms(&ScanSpec::default());
        let options = ScanSegmentationOptions { scanner_position: Some(scan.scanner), ..Default::default() };
        segment_scan_points(&scan.positions, &options).unwrap()
    })
}

fn of(r: &ScanProposalReport, class: ProposalClass) -> Vec<&ScanElementProposal> {
    r.proposals.iter().filter(|p| p.ifc_class == class).collect()
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= POSITION_TOLERANCE_METRES
}

/// (axis x or y offset when the wall runs along y or x, thickness, base z,
/// height, basis) of every wall.
fn walls(r: &ScanProposalReport) -> Vec<(char, f64, f64, f64, f64, ProposalBasis)> {
    of(r, ProposalClass::IfcWall)
        .into_iter()
        .map(|p| {
            let ProposalGeometry::Wall { start, end, thickness_metres, height_metres } = p.geometry else { unreachable!() };
            let along_y = (end[1] - start[1]).abs() > (end[0] - start[0]).abs();
            let (axis, offset) = if along_y { ('x', (start[0] + end[0]) / 2.) } else { ('y', (start[1] + end[1]) / 2.) };
            (axis, offset, thickness_metres, start[2], height_metres, p.basis)
        })
        .collect()
}

#[test]
fn issue_6894_two_room_scan_proposes_the_partition_and_the_exterior_walls() {
    let r = propose_scan_elements(two_room_report(), &ScanProposalOptions::default()).unwrap();
    let found = walls(&r);
    let has = |axis: char, offset: f64, thickness: f64, height: f64, basis: ProposalBasis| {
        found.iter().any(|w| w.0 == axis && near(w.1, offset) && near(w.2, thickness) && near(w.3, 0.) && near(w.4, height) && w.5 == basis)
    };
    // The partition: faces x = 6 and 6.2 pair, axis 6.1, measured 0.2 m;
    // room A's 2.7 m ceiling and room B's 3 m one both touch it, the taller
    // face wins the union.
    assert!(has('x', 6.1, 0.2, 3., ProposalBasis::PairedFaces), "{found:#?}");
    // Exterior walls, scanned from inside: 0.2 m default, outside the room.
    for (axis, offset, height) in [('x', -0.1, 2.7), ('x', 10.1, 3.), ('y', -0.1, 2.7), ('y', 4.1, 2.7), ('y', -0.1, 3.), ('y', 4.1, 3.)] {
        assert!(has(axis, offset, 0.2, height, ProposalBasis::SingleFace), "{axis} {offset}: {found:#?}");
    }
    assert_eq!(found.len(), 7, "{found:#?}");
    assert_eq!((r.stats.paired_walls, r.stats.single_face_walls), (1, 6));
    assert_eq!(r.stats.sloped_planes, 1, "the sloped panel proposes nothing");
}

#[test]
fn issue_6894_two_room_scan_proposes_floor_ceiling_slabs_and_snapped_columns() {
    let r = propose_scan_elements(two_room_report(), &ScanProposalOptions::default()).unwrap();
    let mut slabs: Vec<(ProposalBasis, f64, f64)> = of(&r, ProposalClass::IfcSlab)
        .into_iter()
        .map(|p| {
            let ProposalGeometry::Slab { outline, thickness_metres } = &p.geometry else { unreachable!() };
            (p.basis, outline[0][2], *thickness_metres)
        })
        .collect();
    slabs.sort_by(|a, b| a.1.total_cmp(&b.1));
    let expected = [(ProposalBasis::Floor, 0.), (ProposalBasis::Ceiling, 2.9), (ProposalBasis::Ceiling, 3.2)];
    assert_eq!(slabs.len(), 3, "{slabs:?}");
    for ((basis, top, thickness), (want_basis, want_top)) in slabs.iter().zip(expected) {
        assert_eq!(*basis, want_basis);
        assert!(near(*top, want_top) && near(*thickness, 0.2), "{slabs:?}");
    }
    let mut columns: Vec<(f64, f64, f64, f64, f64)> = of(&r, ProposalClass::IfcColumn)
        .into_iter()
        .map(|p| {
            let ProposalGeometry::Column { base, height_metres, radius_metres } = p.geometry else { unreachable!() };
            (base[0], base[1], base[2], height_metres, radius_metres)
        })
        .collect();
    columns.sort_by(|a, b| a.0.total_cmp(&b.0));
    assert_eq!(columns.len(), 2, "{columns:?}");
    for (c, (x, y, height, radius)) in columns.iter().zip([(4.5, 2.5, 2.7, 0.3), (8., 2., 3., 0.15)]) {
        assert!(near(c.0, x) && near(c.1, y) && near(c.2, 0.) && near(c.3, height) && (c.4 - radius).abs() <= 0.01, "{columns:?}");
    }
    assert!(of(&r, ProposalClass::IfcPipeSegment).is_empty());
    for p in &r.proposals {
        assert!(p.confidence > 0. && p.confidence <= 1. && !p.sources.is_empty() && p.fit.inlier_points > 0, "{p:#?}");
    }
}

#[test]
fn issue_6894_horizontal_cylinders_are_pipes_by_schema() {
    let scene = cylinder_room(&ScanSpec::default());
    let options = ScanSegmentationOptions { scanner_position: Some(scene.scanner), ..Default::default() };
    let report = segment_scan_points(&scene.positions, &options).unwrap();
    for (schema, class) in [(ProposalSchema::Ifc4, ProposalClass::IfcPipeSegment), (ProposalSchema::Ifc2x3, ProposalClass::IfcFlowSegment)] {
        let r = propose_scan_elements(&report, &ScanProposalOptions { schema, ..Default::default() }).unwrap();
        let pipes = of(&r, class);
        assert_eq!(pipes.len(), 1, "{schema:?}");
        let ProposalGeometry::Pipe { start, end, radius_metres } = pipes[0].geometry else { unreachable!() };
        assert!((radius_metres - 0.08).abs() <= 0.01);
        assert!(near(start[1], 3.2) && near(start[2], 2.2) && near(end[2], 2.2));
        assert!(near(start[0].min(end[0]), 1.) || start[0].min(end[0]) > 1., "pipe runs within x 1..4");
        assert_eq!(of(&r, ProposalClass::IfcColumn).len(), 1);
    }
}

/// The viewer's case: points held Y-up ((x, y, z) -> (x, z, -y)), turned
/// 30 degrees about up and relative to a decode origin, segmented with
/// `upAxis` Y; `scanToModel` maps them into a georeferenced model frame
/// offset by `GEOREF`. The proposals equal the Z-up ones moved by `GEOREF`.
#[test]
fn issue_6894_georeferenced_y_up_scan_proposes_in_the_model_frame() {
    const GEOREF: [f64; 3] = [2_600_000., 1_200_000., 410.];
    let scan = two_rooms(&ScanSpec::default());
    let (sin, cos) = 30_f64.to_radians().sin_cos();
    // Scan frame = turn(yup(model)); turn is about the scan's up (y).
    let to_scan = |p: [f64; 3]| -> [f64; 3] {
        let (x, y, z) = (p[0], p[2], -p[1]);
        [cos * x + sin * z, y, -sin * x + cos * z]
    };
    let positions: Vec<f32> = scan
        .positions
        .chunks_exact(3)
        .flat_map(|p| to_scan([p[0].into(), p[1].into(), p[2].into()]).map(|v| v as f32))
        .collect();
    let options = ScanSegmentationOptions { up_axis: [0., 1., 0.], scanner_position: Some(to_scan(scan.scanner)), ..Default::default() };
    let report = segment_scan_points(&positions, &options).unwrap();
    // Inverse turn, then Y-up back to Z-up ((x, y, z) -> (x, -z, y)), then GEOREF.
    #[rustfmt::skip]
    let scan_to_model = [
        cos, 0., -sin, GEOREF[0],
        -sin, 0., -cos, GEOREF[1],
        0., 1., 0., GEOREF[2],
        0., 0., 0., 1.,
    ];
    let mapped = propose_scan_elements(&report, &ScanProposalOptions { scan_to_model, ..Default::default() }).unwrap();
    let truth = propose_scan_elements(two_room_report(), &ScanProposalOptions::default()).unwrap();
    assert_eq!(mapped.stats, truth.stats);
    assert_eq!(mapped.proposals.len(), truth.proposals.len());
    // (value, tolerance) pairs; slab outlines follow the extents too, so
    // only their elevation and thickness are compared.
    let local = |p: &ScanElementProposal, origin: [f64; 3]| -> Vec<(f64, f64)> {
        let shift = |v: [f64; 3]| [v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]];
        let tight = |values: &[f64]| values.iter().map(|&v| (v, POSITION_TOLERANCE_METRES)).collect::<Vec<_>>();
        match &p.geometry {
            ProposalGeometry::Wall { start, end, thickness_metres, height_metres } => {
                let (s, e) = (shift(*start), shift(*end));
                // Across the run: offset; along it: the ends, either direction.
                let run = if (e[0] - s[0]).abs() > (e[1] - s[1]).abs() { 0 } else { 1 };
                let ends = [s[run].min(e[run]), s[run].max(e[run])].map(|v| (v, EXTENT_TOLERANCE_METRES));
                let across = tight(&[run as f64, (s[1 - run] + e[1 - run]) / 2., s[2], *thickness_metres, *height_metres]);
                [across.as_slice(), &ends].concat()
            }
            ProposalGeometry::Slab { outline, thickness_metres } => tight(&[outline[0][2] - origin[2], *thickness_metres]),
            ProposalGeometry::Column { base, height_metres, radius_metres } => tight(&[shift(*base).as_slice(), &[*height_metres, *radius_metres]].concat()),
            ProposalGeometry::Pipe { start, end, radius_metres } => tight(&[shift(*start).as_slice(), &shift(*end), &[*radius_metres]].concat()),
        }
    };
    for t in &truth.proposals {
        let want = local(t, [0.; 3]);
        let matched = mapped.proposals.iter().filter(|m| m.ifc_class == t.ifc_class && m.basis == t.basis).any(|m| {
            let got = local(m, GEOREF);
            got.len() == want.len() && got.iter().zip(&want).all(|((a, _), (b, tolerance))| (a - b).abs() <= *tolerance)
        });
        assert!(matched, "{} {want:?} not reproduced in the georeferenced Y-up frame", t.id);
    }
}
