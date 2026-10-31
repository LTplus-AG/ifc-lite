// SPDX-License-Identifier: MPL-2.0
use super::*;

fn capture_source(records: &str, id: u32) -> Result<RetainedFaceSet> {
    let content = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{records}\nENDSEC;\nEND-ISO-10303-21;\n");
    let mut decoder = EntityDecoder::new(content.as_bytes());
    let item = decoder.decode_by_id(id).unwrap();
    capture(&item, &mut decoder, 0.001)
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
