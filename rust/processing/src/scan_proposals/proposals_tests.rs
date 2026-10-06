// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Proposal logic on hand-built detections (#6894), where every expected
//! number is exact: a 6 x 4 m room (floor z 0, ceiling z 2.7) whose east
//! wall is a 0.2 m partition to a second room, plus a column and a pipe.
//! The scene is stated in the model frame; the transform tests express it
//! in another frame and require the same proposals back.
use super::*;
use crate::scan_segmentation::{
    AxisOrientation, NormalSource, PlaneExtent, PlaneOrientation, ScanCylinder, ScanFacets, ScanPlane, ScanSegmentationLimits,
    ScanSegmentationStats,
};

const EPS: f64 = 1e-6;

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// A rectangle `center +- u * lu / 2 +- v * lv / 2` with `normal = u x v`.
fn plane(center: [f64; 3], u: [f64; 3], v: [f64; 3], lu: f64, lv: f64, scanner: bool, fill: f64) -> ScanPlane {
    let normal = cross(u, v);
    let at = |s: f64, t: f64| -> [f64; 3] { std::array::from_fn(|a| center[a] + s * u[a] * lu / 2. + t * v[a] * lv / 2.) };
    let d = -(normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2]);
    ScanPlane {
        normal,
        d,
        centroid: center,
        inlier_points: 10_000,
        inlier_voxels: 1_000,
        area_square_metres: lu * lv * fill,
        rms_metres: 0.003,
        extent: PlaneExtent { center, u_axis: u, v_axis: v, u_length: lu, v_length: lv, corners: [at(-1., -1.), at(1., -1.), at(1., 1.), at(-1., 1.)] },
        orientation: if normal[2].abs() > 0.9 { PlaneOrientation::Horizontal } else { PlaneOrientation::Vertical },
        normal_source: if scanner { NormalSource::Scanner } else { NormalSource::Canonical },
    }
}

/// Vertical face at plan line from `a` to `b`, normal `(b - a) x up`
/// rotated: pass `inward` to choose the side.
fn wall_face(a: [f64; 2], b: [f64; 2], z: (f64, f64), normal_xy: [f64; 2], scanner: bool) -> ScanPlane {
    let length = (b[0] - a[0]).hypot(b[1] - a[1]);
    let mut u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length, 0.];
    // u x up must equal the requested normal.
    if u[1] * 1. * normal_xy[0] - u[0] * normal_xy[1] < 0. {
        u = [-u[0], -u[1], 0.];
    }
    let center = [(a[0] + b[0]) / 2., (a[1] + b[1]) / 2., (z.0 + z.1) / 2.];
    plane(center, u, [0., 0., 1.], length, z.1 - z.0, scanner, 0.9)
}

fn horizontal(lo: [f64; 2], hi: [f64; 2], z: f64, up: bool, scanner: bool) -> ScanPlane {
    let center = [(lo[0] + hi[0]) / 2., (lo[1] + hi[1]) / 2., z];
    let (u, v) = if up { ([1., 0., 0.], [0., 1., 0.]) } else { ([0., 1., 0.], [1., 0., 0.]) };
    let (lu, lv) = if up { (hi[0] - lo[0], hi[1] - lo[1]) } else { (hi[1] - lo[1], hi[0] - lo[0]) };
    plane(center, u, v, lu, lv, scanner, 0.95)
}

fn cylinder(start: [f64; 3], end: [f64; 3], radius: f64) -> ScanCylinder {
    let axis: [f64; 3] = std::array::from_fn(|a| end[a] - start[a]);
    let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    ScanCylinder {
        axis_start: start,
        axis_end: end,
        axis_direction: axis.map(|v| v / length),
        radius,
        length,
        height_range: [start[2].min(end[2]), start[2].max(end[2])],
        arc_degrees: 360.,
        inlier_points: 5_000,
        inlier_voxels: 500,
        rms_metres: 0.004,
        orientation: if axis[2].abs() > 0.9 * length { AxisOrientation::Vertical } else { AxisOrientation::Horizontal },
        faceted: None,
    }
}

fn report(planes: Vec<ScanPlane>, cylinders: Vec<ScanCylinder>) -> ScanSegmentationReport {
    ScanSegmentationReport {
        algorithm: "test".into(),
        planes,
        cylinders,
        stats: ScanSegmentationStats::default(),
        limits: ScanSegmentationLimits::default(),
    }
}

/// Room A (x 0..6, y 0..4) seen from a scanner at (3, 2, 1.5): walls stop
/// 6 cm short of floor and ceiling as segmented walls do. The east wall is
/// a partition whose far face (x = 6.2) was scanned from room B.
fn room(scanner: bool) -> ScanSegmentationReport {
    let z = (0.06, 2.64);
    report(
        vec![
            horizontal([0., 0.], [6., 4.], 0., true, scanner),
            horizontal([0., 0.], [6., 4.], 2.7, !scanner, scanner),
            wall_face([0., 0.], [0., 4.], z, [1., 0.], scanner),
            wall_face([0., 0.], [6., 0.], z, [0., 1.], scanner),
            wall_face([0., 4.], [6., 4.], z, [0., -1.], scanner),
            wall_face([6., 0.], [6., 4.], z, [-1., 0.], scanner),
            wall_face([6.2, 0.], [6.2, 4.], z, [1., 0.], scanner),
        ],
        vec![cylinder([4.5, 2.5, 0.1], [4.5, 2.5, 2.6], 0.3), cylinder([1., 3.2, 2.2], [4., 3.2, 2.2], 0.08)],
    )
}

fn run(report: &ScanSegmentationReport, options: ScanProposalOptions) -> ScanProposalReport {
    propose_scan_elements(report, &options).expect("proposals")
}

fn wall(p: &ScanElementProposal) -> ([f64; 3], [f64; 3], f64, f64) {
    match p.geometry {
        ProposalGeometry::Wall { start, end, thickness_metres, height_metres } => (start, end, thickness_metres, height_metres),
        _ => panic!("{} is not a wall", p.id),
    }
}

fn close(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance
}

/// The wall whose axis runs at constant x (or y) = `offset`.
fn wall_at(r: &ScanProposalReport, axis: usize, offset: f64) -> &ScanElementProposal {
    r.proposals
        .iter()
        .filter(|p| p.ifc_class == ProposalClass::IfcWall)
        .find(|p| {
            let (s, e, ..) = wall(p);
            close(s[axis], offset, 1e-3) && close(e[axis], offset, 1e-3)
        })
        .unwrap_or_else(|| panic!("no wall at axis {axis} = {offset}: {:#?}", r.proposals))
}

#[test]
fn issue_6894_opposite_faces_pair_into_one_wall_with_measured_thickness() {
    for scanner in [false, true] {
        let r = run(&room(scanner), ScanProposalOptions::default());
        assert_eq!((r.stats.paired_walls, r.stats.single_face_walls), (1, 3), "scanner {scanner}");
        let partition = wall_at(&r, 0, 6.1);
        assert_eq!(partition.basis, ProposalBasis::PairedFaces);
        let (start, end, thickness, height) = wall(partition);
        assert!(close(thickness, 0.2, EPS), "thickness {thickness}");
        assert!(close((end[1] - start[1]).abs(), 4., EPS));
        // Walls stop 6 cm short; both ends snap to floor and ceiling.
        assert!(close(start[2], 0., EPS) && close(height, 2.7, EPS), "z {} height {height}", start[2]);
        let sources: Vec<u32> = partition.sources.iter().map(|s| s.index).collect();
        assert_eq!(sources, vec![5, 6]);
    }
}

#[test]
fn issue_6894_single_faces_get_the_default_thickness_behind_the_scanned_side() {
    // Scanner-facing normals and, without them, the interior point both put
    // the wall body outside the room.
    for scanner in [false, true] {
        let r = run(&room(scanner), ScanProposalOptions::default());
        for (axis, offset) in [(0, -0.1), (1, -0.1), (1, 4.1)] {
            let w = wall_at(&r, axis, offset);
            assert_eq!(w.basis, ProposalBasis::SingleFace);
            assert!(close(wall(w).2, 0.2, EPS));
        }
    }
    let thick = ScanProposalOptions { default_wall_thickness_metres: 0.3, ..Default::default() };
    wall_at(&run(&room(true), thick), 0, -0.15);
}

#[test]
fn issue_6894_a_gap_seen_from_inside_is_not_a_wall() {
    // Two faces 0.4 m apart whose scanner-facing normals point into the gap:
    // a niche scanned from within, open space between.
    let z = (0., 2.5);
    let niche = report(
        vec![wall_face([0., 0.], [0., 3.], z, [1., 0.], true), wall_face([0.4, 0.], [0.4, 3.], z, [-1., 0.], true)],
        vec![],
    );
    let r = run(&niche, ScanProposalOptions::default());
    assert_eq!((r.stats.paired_walls, r.stats.single_face_walls), (0, 2));
    // The same faces with normals pointing out of the gap are one wall.
    let solid = report(
        vec![wall_face([0., 0.], [0., 3.], z, [-1., 0.], true), wall_face([0.4, 0.], [0.4, 3.], z, [1., 0.], true)],
        vec![],
    );
    assert_eq!(run(&solid, ScanProposalOptions::default()).stats.paired_walls, 1);
}

#[test]
fn issue_6894_thickness_range_and_overlap_gate_pairing() {
    let z = (0., 2.5);
    let pair = |gap: f64, from: f64| {
        report(vec![wall_face([0., 0.], [0., 3.], z, [1., 0.], false), wall_face([gap, from], [gap, from + 3.], z, [1., 0.], false)], vec![])
    };
    let paired = |r: ScanSegmentationReport| run(&r, ScanProposalOptions::default()).stats.paired_walls;
    assert_eq!(paired(pair(0.3, 0.)), 1);
    assert_eq!(paired(pair(0.7, 0.)), 0, "beyond maxWallThicknessMetres");
    assert_eq!(paired(pair(0.03, 0.)), 0, "below minWallThicknessMetres");
    assert_eq!(paired(pair(0.3, 2.)), 0, "one third overlap");
    assert_eq!(paired(pair(0.3, 1.4)), 1, "just over half overlap");
}

fn slabs(r: &ScanProposalReport) -> Vec<(ProposalBasis, f64, f64)> {
    r.proposals
        .iter()
        .filter_map(|p| match &p.geometry {
            ProposalGeometry::Slab { outline, thickness_metres } => Some((p.basis, outline[0][2], *thickness_metres)),
            _ => None,
        })
        .collect()
}

#[test]
fn issue_6894_floors_and_ceilings_get_their_solid_side() {
    for scanner in [false, true] {
        let r = run(&room(scanner), ScanProposalOptions::default());
        let mut found = slabs(&r);
        found.sort_by(|a, b| a.1.total_cmp(&b.1));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].0, ProposalBasis::Floor);
        assert!(close(found[0].1, 0., EPS) && close(found[0].2, 0.2, EPS));
        assert_eq!(found[1].0, ProposalBasis::Ceiling);
        // The ceiling's slab sits above it: top 2.9.
        assert!(close(found[1].1, 2.9, EPS) && close(found[1].2, 0.2, EPS), "{found:?}");
    }
    // Outline: the extent, counter-clockwise from above, on the top face.
    let r = run(&room(false), ScanProposalOptions::default());
    let ProposalGeometry::Slab { outline, .. } = &r.proposals.iter().find(|p| p.basis == ProposalBasis::Ceiling).unwrap().geometry else {
        unreachable!()
    };
    let twice_area: f64 = (0..4).map(|i| outline[i][0] * outline[(i + 1) % 4][1] - outline[(i + 1) % 4][0] * outline[i][1]).sum();
    assert!(close(twice_area, 48., EPS), "area x2 {twice_area}");
}

#[test]
fn issue_6894_a_ceiling_and_the_floor_above_pair_into_one_slab() {
    // Storey 1 ceiling at 2.7, storey 2 floor at 3.0 over most of it.
    let mut storeys = room(true);
    storeys.planes.push(horizontal([0.5, 0.], [6., 4.], 3.0, true, true));
    storeys.planes.push(wall_face([0., 0.], [0., 4.], (3.06, 5.6), [1., 0.], true));
    let r = run(&storeys, ScanProposalOptions::default());
    let paired: Vec<_> = slabs(&r).into_iter().filter(|s| s.0 == ProposalBasis::FloorCeilingPair).collect();
    assert_eq!(paired.len(), 1, "{:?}", slabs(&r));
    assert!(close(paired[0].1, 3.0, EPS) && close(paired[0].2, 0.3, EPS));
    assert_eq!(r.stats.paired_slabs, 1);
}

#[test]
fn issue_6894_cylinders_become_columns_snapped_to_levels_and_schema_pipes() {
    let r = run(&room(false), ScanProposalOptions::default());
    let column = r.proposals.iter().find(|p| p.ifc_class == ProposalClass::IfcColumn).expect("column");
    let ProposalGeometry::Column { base, height_metres, radius_metres } = column.geometry else { unreachable!() };
    assert!(close(base[0], 4.5, EPS) && close(base[1], 2.5, EPS) && close(base[2], 0., EPS));
    assert!(close(height_metres, 2.7, EPS) && close(radius_metres, 0.3, EPS));
    assert_eq!(column.sources, vec![DetectionRef { kind: DetectionKind::Cylinder, index: 0 }]);
    let pipe = |schema| {
        let r = run(&room(false), ScanProposalOptions { schema, ..Default::default() });
        r.proposals.iter().find(|p| p.id == "pipe-0").map(|p| p.ifc_class)
    };
    assert_eq!(pipe(ProposalSchema::Ifc4), Some(ProposalClass::IfcPipeSegment));
    assert_eq!(pipe(ProposalSchema::Ifc4x3), Some(ProposalClass::IfcPipeSegment));
    assert_eq!(pipe(ProposalSchema::Ifc2x3), Some(ProposalClass::IfcFlowSegment));
}

#[test]
fn issue_6894_a_faceted_column_gets_the_round_profile_of_equal_area() {
    // #6937 reports a polygonal column with `radius` its circumradius. A
    // circle of that radius is too large (an octagon: ~5% radius, ~11% area),
    // so the proposed round profile has the polygon's cross-section area.
    let mut scan = room(false);
    scan.cylinders[0].faceted = Some(ScanFacets { faces: 8, face_normal: [1., 0., 0.], apothem: 0.3 * (std::f64::consts::PI / 8.).cos() });
    let r = run(&scan, ScanProposalOptions::default());
    let column = r.proposals.iter().find(|p| p.ifc_class == ProposalClass::IfcColumn).expect("column");
    let ProposalGeometry::Column { radius_metres, .. } = column.geometry else { unreachable!() };
    let octagon_area = 0.5 * 8. * 0.3 * 0.3 * (2. * std::f64::consts::PI / 8.).sin();
    assert!(close(std::f64::consts::PI * radius_metres * radius_metres, octagon_area, 1e-9), "{radius_metres}");
    assert!(close(radius_metres, 0.284_65, 1e-4), "{radius_metres}");
    // A round column keeps its fitted radius.
    let round = run(&room(false), ScanProposalOptions::default());
    let ProposalGeometry::Column { radius_metres, .. } = round.proposals.iter().find(|p| p.ifc_class == ProposalClass::IfcColumn).unwrap().geometry else { unreachable!() };
    assert!(close(radius_metres, 0.3, EPS));
}

#[test]
fn issue_6894_confidence_ranks_measured_over_defaulted_and_tracks_fit() {
    let r = run(&room(true), ScanProposalOptions::default());
    let paired = wall_at(&r, 0, 6.1).confidence;
    let single = wall_at(&r, 0, -0.1).confidence;
    assert!(paired > single && single > 0. && paired <= 1., "{paired} {single}");
    let mut noisy = room(true);
    for p in &mut noisy.planes {
        p.rms_metres = 0.02;
    }
    assert!(wall_at(&run(&noisy, ScanProposalOptions::default()), 0, 6.1).confidence < paired);
}

#[test]
fn issue_6894_options_and_transforms_are_validated() {
    let bad = |o: ScanProposalOptions| propose_scan_elements(&room(false), &o).unwrap_err();
    let mut reflect = ScanProposalOptions::default();
    reflect.scan_to_model[0] = -1.;
    assert!(bad(reflect).contains("reflect"));
    let mut stretch = ScanProposalOptions::default();
    stretch.scan_to_model[0] = 2.;
    assert!(bad(stretch).contains("uniform"));
    let mut projective = ScanProposalOptions::default();
    projective.scan_to_model[12] = 1.;
    assert!(bad(projective).contains("affine"));
    assert!(bad(ScanProposalOptions { max_wall_thickness_metres: 0.01, ..Default::default() }).contains("thickness"));
    let unknown: Result<ScanProposalOptions, _> = serde_json::from_str(r#"{"surprise":1}"#);
    assert!(unknown.is_err());
}

/// Row-major 4x4 product, written out independently of `frame`.
fn multiply(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    std::array::from_fn(|k| (0..4).map(|i| a[(k / 4) * 4 + i] * b[i * 4 + k % 4]).sum())
}

fn apply(m: &[f64; 16], p: [f64; 3], w: f64) -> [f64; 3] {
    std::array::from_fn(|r| m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3] * w)
}

/// `report` expressed through `m` (points with w = 1, directions w = 0,
/// lengths times `scale`).
fn expressed(report: &ScanSegmentationReport, m: &[f64; 16], scale: f64) -> ScanSegmentationReport {
    let mut out = report.clone();
    for p in &mut out.planes {
        let n = apply(m, p.normal, 0.).map(|v| v / scale);
        p.centroid = apply(m, p.centroid, 1.);
        p.d = -(n[0] * p.centroid[0] + n[1] * p.centroid[1] + n[2] * p.centroid[2]);
        p.normal = n;
        p.extent.corners = p.extent.corners.map(|c| apply(m, c, 1.));
        p.extent.center = apply(m, p.extent.center, 1.);
        p.area_square_metres *= scale * scale;
        p.rms_metres *= scale;
    }
    for c in &mut out.cylinders {
        c.axis_start = apply(m, c.axis_start, 1.);
        c.axis_end = apply(m, c.axis_end, 1.);
        c.radius *= scale;
        c.rms_metres *= scale;
    }
    out
}

/// Model -> scan: Z-up to the viewer's Y-up ((x, y, z) -> (x, z, -y)), a
/// 30 degree turn about up, scale `1 / s` and a georeferenced offset. Its
/// inverse is the `scanToModel` the viewer passes.
fn frames(s: f64) -> ([f64; 16], [f64; 16]) {
    let (sin, cos) = 30_f64.to_radians().sin_cos();
    let turn = [cos, -sin, 0., 0., sin, cos, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
    let georef = [1., 0., 0., -2_600_123.25, 0., 1., 0., -1_200_456.5, 0., 0., 1., -412.75, 0., 0., 0., 1.];
    let yup = [1., 0., 0., 0., 0., 0., 1., 0., 0., -1., 0., 0., 0., 0., 0., 1.];
    let shrink = [1. / s, 0., 0., 0., 0., 1. / s, 0., 0., 0., 0., 1. / s, 0., 0., 0., 0., 1.];
    let model_to_scan = multiply(&shrink, &multiply(&yup, &multiply(&turn, &georef)));
    let grow = [s, 0., 0., 0., 0., s, 0., 0., 0., 0., s, 0., 0., 0., 0., 1.];
    let yup_inverse = [1., 0., 0., 0., 0., 0., -1., 0., 0., 1., 0., 0., 0., 0., 0., 1.];
    let turn_inverse = [cos, sin, 0., 0., -sin, cos, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
    let georef_inverse = [1., 0., 0., 2_600_123.25, 0., 1., 0., 1_200_456.5, 0., 0., 1., 412.75, 0., 0., 0., 1.];
    let scan_to_model = multiply(&georef_inverse, &multiply(&turn_inverse, &multiply(&yup_inverse, &grow)));
    (model_to_scan, scan_to_model)
}

fn assert_same(a: &ScanProposalReport, b: &ScanProposalReport, tolerance: f64) {
    assert_eq!(a.proposals.len(), b.proposals.len());
    assert_eq!(a.stats, b.stats);
    let flat = |g: &ProposalGeometry| -> Vec<f64> {
        match g {
            ProposalGeometry::Wall { start, end, thickness_metres, height_metres } => {
                [start.as_slice(), end, &[*thickness_metres, *height_metres]].concat()
            }
            ProposalGeometry::Slab { outline, thickness_metres } => {
                outline.iter().flatten().copied().chain([*thickness_metres]).collect()
            }
            ProposalGeometry::Column { base, height_metres, radius_metres } => [base.as_slice(), &[*height_metres, *radius_metres]].concat(),
            ProposalGeometry::Pipe { start, end, radius_metres } => [start.as_slice(), end, &[*radius_metres]].concat(),
        }
    };
    for (p, q) in a.proposals.iter().zip(&b.proposals) {
        assert_eq!((&p.id, p.ifc_class, p.basis, &p.sources), (&q.id, q.ifc_class, q.basis, &q.sources));
        assert!(close(p.confidence, q.confidence, 2e-3), "{} confidence", p.id);
        for (x, y) in flat(&p.geometry).iter().zip(flat(&q.geometry)) {
            assert!(close(*x, y, tolerance), "{}: {x} vs {y}", p.id);
        }
    }
}

#[test]
fn issue_6894_proposals_from_a_georeferenced_y_up_scan_land_in_the_model_frame() {
    // The scene is the model frame. Expressed in a Y-up, rotated, offset scan
    // frame and mapped back by `scanToModel`, it proposes the same elements.
    for scanner in [false, true] {
        let truth = run(&room(scanner), ScanProposalOptions::default());
        let (model_to_scan, scan_to_model) = frames(1.);
        let scan = expressed(&room(scanner), &model_to_scan, 1.);
        let mapped = run(&scan, ScanProposalOptions { scan_to_model, ..Default::default() });
        assert_eq!(mapped.transform_scale, 1.);
        assert_same(&truth, &mapped, 1e-6);
    }
}

#[test]
fn issue_6894_a_scaled_alignment_scales_thickness_radius_and_height() {
    // A map conversion with scale 0.5 between scan and model metres.
    let truth = run(&room(false), ScanProposalOptions::default());
    let (model_to_scan, scan_to_model) = frames(0.5);
    let scan = expressed(&room(false), &model_to_scan, 2.);
    let mapped = run(&scan, ScanProposalOptions { scan_to_model, ..Default::default() });
    assert!(close(mapped.transform_scale, 0.5, 1e-12));
    assert_same(&truth, &mapped, 1e-6);
}
