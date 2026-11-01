// SPDX-License-Identifier: MPL-2.0
use super::*;

fn capture_source(records: &str, id: u32) -> Result<RetainedFaceSet> {
    capture_scaled(records, id, 0.001)
}

fn capture_scaled(records: &str, id: u32, scale: f64) -> Result<RetainedFaceSet> {
    let content = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{records}\nENDSEC;\nEND-ISO-10303-21;\n");
    let mut decoder = EntityDecoder::new(content.as_bytes());
    let item = decoder.decode_by_id(id).unwrap();
    capture(&item, &mut decoder, scale)
}

const TETRA: &str = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(0.,1000.,0.),(0.,0.,1000.)));";

#[test]
fn issue_8291_keeps_full_f64_coordinates_and_coord_index_rows() {
    let far = "#1=IFCCARTESIANPOINTLIST3D(((6000000.125,0.,0.),(6000001.125,0.,0.),(6000000.125,1.,0.)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";
    let set = capture_source(far, 2).unwrap();
    assert_eq!(set.positions[0], 6000000.125, "f32 would round this coordinate");
    assert_eq!((set.triangles.as_slice(), set.rows.as_slice(), set.row_count), (&[0, 1, 2][..], &[0][..], 1));
}

#[test]
fn issue_8291_closed_inward_shell_flips_like_exact_and_keeps_rows() {
    let inward = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,.T.,((1,2,3),(1,4,2),(2,4,3),(3,4,1)),$);");
    let set = capture_source(&inward, 2).unwrap();
    assert_eq!(set.rows, [0, 1, 2, 3]);
    assert_eq!(set.triangles[..3], [0, 2, 1], "the whole inward shell turns outward");
    let unasserted = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,$,((1,2,3),(1,4,2),(2,4,3),(3,4,1)),$);");
    assert_eq!(capture_source(&unasserted, 2).unwrap().triangles[..3], [0, 2, 1], "topologically closed `$` also orients");
}

#[test]
fn issue_8291_open_sheet_keeps_authored_winding() {
    let sheet = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3),(1,4,2)),$);");
    assert_eq!(capture_source(&sheet, 2).unwrap().triangles, [0, 1, 2, 0, 3, 1]);
}

#[test]
fn issue_8291_pn_index_remaps_and_invalid_rows_drop_without_shifting() {
    let set = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3),(1,2,9),(2,1,3)),(4,3,2));");
    let captured = capture_source(&set, 2).unwrap();
    assert_eq!(captured.triangles, [3, 2, 1, 2, 3, 1], "PnIndex maps corners; the out-of-list row drops");
    assert_eq!(captured.rows, [0, 2], "later rows keep their authored row");
    assert_eq!(captured.row_count, 3);
}

#[test]
fn issue_8291_polygon_rows_are_authored_face_positions() {
    let records = format!("{TETRA}\n#3=IFCINDEXEDPOLYGONALFACE((1,2,3,1));\n#4=IFCINDEXEDPOLYGONALFACE((1,2));\n#5=IFCINDEXEDPOLYGONALFACE((1,4,2));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#3,#4,#5),$);");
    let captured = capture_source(&records, 6).unwrap();
    assert_eq!(*captured.rows.last().unwrap(), 2, "a skipped short face does not shift the rows after it");
    assert_eq!(captured.row_count, 3);
}

#[test]
fn issue_8291_zero_area_triangles_leave_and_a_set_of_only_those_refuses_at_lowering() {
    let records = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,1,2),(1,2,3)),$);");
    let captured = capture_source(&records, 2).unwrap();
    assert_eq!((captured.triangles.as_slice(), captured.rows.as_slice()), (&[0, 1, 2][..], &[1][..]));
    let only = format!("{TETRA}\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,1,2)),$);");
    assert!(capture_source(&only, 2).unwrap().lower().is_err());
}

#[test]
fn issue_8291_a_sliver_that_collapses_in_metres_leaves_at_capture_not_at_the_seal() {
    // Nonzero area in file units; exactly zero after the request's scaling to metres.
    let records = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,1.,0.),(1.9533,1.9533000000000003,0.),(0.,5.,0.)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3),(1,2,4)),$);";
    let captured = capture_source(records, 2).unwrap();
    assert_eq!(captured.rows, [1]);
    let mut document = crate::document::GeometryDocument::new();
    let handle = document.add_retained_face_set(captured).unwrap();
    let request = document.prepare_retained(handle, 1).unwrap();
    assert!(request.source_exact_completion().is_some(), "every kept triangle has a normal");
}

#[test]
fn issue_8291_one_polygon_row_stays_one_row_however_many_triangles_it_needs() {
    let records = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(1000.,1000.,0.),(0.,1000.,0.)));\n#3=IFCINDEXEDPOLYGONALFACE((1,2,3,4));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#3),$);";
    let captured = capture_source(records, 6).unwrap();
    assert_eq!((captured.rows.as_slice(), captured.row_count), (&[0, 0][..], 1));
}

#[test]
fn issue_8291_survey_scale_polygon_corners_survive_triangulation() {
    // One f32 step is 0.5 here: without the first-point offset these corners merge and the ring collapses.
    let records = "#1=IFCCARTESIANPOINTLIST3D(((6000000.,0.,0.),(6000000.25,0.,0.),(6000000.25,0.125,0.),(6000000.125,0.125,0.),(6000000.125,0.25,0.),(6000000.,0.25,0.)));\n#3=IFCINDEXEDPOLYGONALFACE((1,2,3,4,5,6));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#3),$);";
    let captured = capture_source(records, 6).unwrap();
    assert_eq!(captured.rows.len(), 4, "an L of six corners is four triangles");
    let point = |i: u32| [captured.positions[i as usize * 3], captured.positions[i as usize * 3 + 1]];
    let area: f64 = captured.triangles.chunks_exact(3).map(|t| {
        let (a, b, c) = (point(t[0]), point(t[1]), point(t[2]));
        ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs() / 2.
    }).sum();
    assert_eq!(area, 0.25 * 0.25 - 0.125 * 0.125, "the authored L, exactly");
}

#[test]
fn issue_8291_a_small_inward_shell_at_survey_scale_still_turns_outward() {
    // At this magnitude f32 merges every corner, so the f32 point list has no shell left to orient.
    let records = "#1=IFCCARTESIANPOINTLIST3D(((6000000.,0.,0.),(6000000.125,0.,0.),(6000000.,0.125,0.),(6000000.,0.,0.125)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.T.,((1,2,3),(1,4,2),(2,4,3),(3,4,1)),$);";
    assert_eq!(capture_source(records, 2).unwrap().triangles[..3], [0, 2, 1], "the same flip as the same shell at the origin");
}

#[test]
fn issue_8291_an_unused_first_point_does_not_choose_the_frame() {
    // Entry 1 is at the origin and no face names it: a frame there leaves the ring merged at survey scale.
    let polygon = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(6000000.,0.,0.),(6000000.25,0.,0.),(6000000.25,0.125,0.),(6000000.125,0.125,0.),(6000000.125,0.25,0.),(6000000.,0.25,0.)));\n#3=IFCINDEXEDPOLYGONALFACE((2,3,4,5,6,7));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#3),$);";
    assert_eq!(capture_source(polygon, 6).unwrap().rows.len(), 4, "an L of six corners is four triangles");
    let shell = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(6000000.,0.,0.),(6000000.125,0.,0.),(6000000.,0.125,0.),(6000000.,0.,0.125)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.T.,((2,3,4),(2,5,3),(3,5,4),(4,5,2)),$);";
    assert_eq!(capture_source(shell, 2).unwrap().triangles[..3], [1, 3, 2], "the same flip as the same shell at the origin");
}

#[test]
fn issue_8291_a_ring_whose_levels_round_together_keeps_its_area() {
    // In metres at survey scale: every narrowed point stays distinct, but both Y levels are one f32 value.
    let records = "#1=IFCCARTESIANPOINTLIST3D(((0.,6000000.,0.),(3.,6000000.,0.),(2.,6000000.125,0.),(1.,6000000.125,0.)));\n#3=IFCINDEXEDPOLYGONALFACE((1,2,3,4));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#3),$);";
    assert_eq!(capture_scaled(records, 6, 1.).unwrap().rows.len(), 2, "the authored trapezoid is two triangles");
}

#[test]
fn issue_8291_a_dropped_face_cannot_choose_the_frame() {
    // The first face names unlisted point 9, so it drops: its point 1, at the origin, must not be the frame.
    let polygon = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(6000000.,0.,0.),(6000000.25,0.,0.),(6000000.25,0.125,0.),(6000000.125,0.125,0.),(6000000.125,0.25,0.),(6000000.,0.25,0.)));\n#2=IFCINDEXEDPOLYGONALFACE((1,9,2));\n#3=IFCINDEXEDPOLYGONALFACE((2,3,4,5,6,7));\n#6=IFCPOLYGONALFACESET(#1,.F.,(#2,#3),$);";
    let captured = capture_source(polygon, 6).unwrap();
    assert_eq!((captured.rows.len(), captured.row_count), (4, 2), "an L of six corners is four triangles, in the second row");
    let shell = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(6000000.,0.,0.),(6000000.125,0.,0.),(6000000.,0.125,0.),(6000000.,0.,0.125)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.T.,((1,9,2),(2,3,4),(2,5,3),(3,5,4),(4,5,2)),$);";
    assert_eq!(capture_source(shell, 2).unwrap().triangles[..3], [1, 3, 2], "the same flip as the same shell at the origin");
}

#[test]
fn issue_8291_dropped_rows_are_paid_for_at_capture() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let set = |rows: &str| format!("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(0.,1000.,0.)));\n#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3){rows}),$);");
    let account = || ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(10_000), ..Default::default() }));
    assert!(account().scope(|| capture_source(&set(""), 2)).is_ok());
    // Each collapsed row leaves the arrays but keeps a slot downstream: 100 of them must not be free.
    assert!(account().scope(|| capture_source(&set(&",(1,1,1)".repeat(100)), 2)).is_err());
}

#[test]
fn issue_8291_a_polygon_of_many_triangles_does_not_hide_dropped_rows() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    // One convex row of 101 triangles: counting triangles as rows would make 100 dropped rows free.
    let points: Vec<String> = (0..103).map(|i| { let a = f64::from(i) * std::f64::consts::TAU / 103.; format!("({:.3},{:.3},0.)", 1000. * a.cos(), 1000. * a.sin()) }).collect();
    let ring: Vec<String> = (1..=103).map(|i| i.to_string()).collect();
    let set = |dropped: u32| {
        let faces: Vec<String> = (0..=dropped).map(|f| format!("#{}", 10 + f)).collect();
        let empties: String = (1..=dropped).map(|f| format!("#{}=IFCINDEXEDPOLYGONALFACE((1,999,2));\n", 10 + f)).collect();
        format!("#1=IFCCARTESIANPOINTLIST3D(({}));\n#10=IFCINDEXEDPOLYGONALFACE(({}));\n{empties}#6=IFCPOLYGONALFACESET(#1,.F.,({}),$);", points.join(","), ring.join(","), faces.join(","))
    };
    let account = || ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(10_000), ..Default::default() }));
    assert_eq!(account().scope(|| capture_source(&set(0), 6)).unwrap().rows.len(), 101);
    assert!(account().scope(|| capture_source(&set(100), 6)).is_err());
}
