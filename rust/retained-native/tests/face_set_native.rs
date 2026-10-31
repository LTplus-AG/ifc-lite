// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #8291: authored face sets publish source-exact triangles through the real
//! controller and the live worker; cuts and copies refuse typed until adapted.
mod support;
use ifc_lite_retained_native::oracle::face_sets;

const F_B_MAPPED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-b-mapped.ifc");

const SCAFFOLD: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);
#20=IFCBUILDINGELEMENTPROXY('s',$,'Set',$,$,#9,#21,$,.NOTDEFINED.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#33));
/*BODY*/
ENDSEC;END-ISO-10303-21;";
fn model(records: &str) -> String { SCAFFOLD.replace("/*BODY*/", records) }

#[test]
fn issue_8291_f_b_mapped_uncut_boxes_are_final_and_keyed_per_row() {
    let Some(outcomes) = support::native(F_B_MAPPED) else { return; };
    for id in [53, 68, 113] {
        let product = support::shape(&outcomes, id);
        assert_eq!(product.marker(), "final", "#{id}");
        let [part] = product.parts.as_slice() else { panic!("#{id} parts") };
        assert_eq!(part.indices.len(), 36, "twelve authored triangles");
        let faces = part.faces.as_ref().expect("face keys");
        assert_eq!(faces.table.len(), 12, "#{id}: one key per authored row, even coplanar ones");
        assert!(faces.table.iter().all(|key| key.role.starts_with("row(")));
        assert!(!part.curved && part.normals.is_some() && part.appearance.is_some());
    }
    for (id, code) in [(83, "incomplete"), (98, "incomplete"), (128, "operation_unsupported"), (153, "operation_unsupported"),
        (172, "appearance_unsupported"), (183, "appearance_unsupported")] {
        assert_eq!(support::refusal(&outcomes, id).code(), code, "#{id}");
    }
    println!("sdk witness executed: face_set_f_b_mapped");
}

#[test]
fn issue_8291_open_polygonal_sheet_with_a_hole_publishes_its_authored_rows() {
    // No closed solid exists for the kernel to build: this can only publish source triangles.
    let text = model("\
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4000.,0.,0.),(4000.,4000.,0.),(0.,4000.,0.),(1000.,1000.,0.),(2000.,1000.,0.),(2000.,2000.,0.),(1000.,2000.,0.),(0.,0.,3000.)));
#31=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,8,7,6)));
#32=IFCINDEXEDPOLYGONALFACE((1,9,2));
#33=IFCPOLYGONALFACESET(#30,.F.,(#31,#32),$);");
    let Some(outcomes) = support::native(&text) else { return; };
    let product = support::shape(&outcomes, 20);
    assert_eq!(product.marker(), "final");
    let [part] = product.parts.as_slice() else { panic!("parts") };
    let faces = part.faces.as_ref().unwrap();
    let keys: Vec<_> = faces.triangles.iter().map(|&k| faces.table[k as usize].role.trim_start_matches("row(").trim_end_matches(')').parse::<u32>().ok()).collect();
    let mut decoder = ifc_lite_core::EntityDecoder::new(text.as_bytes());
    let item = decoder.decode_by_id(33).unwrap();
    let set = face_sets::authored(&item, &mut decoder, 0.001).unwrap();
    let deviation = face_sets::deviation(&set, &part.positions, &part.indices, &keys);
    assert_eq!(deviation.missing_rows, 0);
    assert!(deviation.corner_m <= 1e-9 && deviation.area_relative <= 1e-9, "{deviation:?}");
    println!("sdk witness executed: face_set_open_polygonal");
}

#[test]
fn issue_8291_survey_scale_coordinates_keep_full_precision() {
    // At this magnitude f32 rounds to 0.5 m: an authored 125 mm edge would collapse or move.
    let text = model("\
#30=IFCCARTESIANPOINTLIST3D(((6000000.,2000000.,0.),(6000000.125,2000000.,0.),(6000000.,2000000.125,0.)));
#33=IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);").replace("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)", "IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    let Some(outcomes) = support::native(&text) else { return; };
    let [part] = support::shape(&outcomes, 20).parts.as_slice() else { panic!("parts") };
    let frame = part.world_from_object;
    let origin = [frame[12], frame[13]];
    assert_eq!(origin, [6000000., 2000000.], "the anchor carries the survey offset in f64");
    let span = part.positions.chunks_exact(3).map(|p| p[0]).fold(0., f64::max);
    assert_eq!(span, 0.125);
    println!("sdk witness executed: face_set_survey_scale");
}
