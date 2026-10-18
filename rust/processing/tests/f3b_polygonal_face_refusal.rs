// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7779 F3b: an absent independent IfcPolygonalFaceSet face record must not
//! erase its product's valid geometry, and the native diagnostics must report
//! the dropped face type independently of the mesh count.

use ifc_lite_processing::{process_geometry, ProcessingResult};

fn model(face_records: &str, face_refs: &str) -> String {
    format!(
        "ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('f3b.ifc','2026-10-18T00:00:00',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
\
         #1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
         #3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\
         #4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#5=IFCUNITASSIGNMENT((#4));\
         #6=IFCPROJECT('0000000000000000000001',$,'F3b',$,$,$,$,(#3),#5);\
         #7=IFCLOCALPLACEMENT($,#2);\
         #20=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));\
         {face_records}\
         #22=IFCPOLYGONALFACESET(#20,.F.,({face_refs}),$);\
         #23=IFCSHAPEREPRESENTATION(#3,'Body','Tessellation',(#22));\
         #24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));\
         #25=IFCWALL('0000000000000000000025',$,'Polygonal test',$,$,#7,#24,$,$);\
         ENDSEC;END-ISO-10303-21;"
    )
}

fn run(face_records: &str, face_refs: &str) -> ProcessingResult {
    process_geometry(model(face_records, face_refs).as_bytes())
}

fn dropped_indexed_faces(result: &ProcessingResult) -> u64 {
    result
        .stats
        .geometry_diagnostics
        .as_ref()
        .expect("face refusal must surface geometry diagnostics")
        .unsupported_items_by_type
        .iter()
        .find(|entry| entry.reason == "IfcIndexedPolygonalFace")
        .map_or(0, |entry| entry.count)
}

#[test]
fn native_product_geometry_survives_dangling_polygonal_face_7779() {
    let face = "#21=IFCINDEXEDPOLYGONALFACE((1,2,3));";
    let clean = run(face, "#21");
    let clean_mesh = clean.meshes.iter().find(|m| m.express_id == 25).expect("control wall mesh");
    assert_eq!(clean_mesh.indices.len(), 3);

    let partial = run(face, "#21,#999");
    let mesh = partial.meshes.iter().find(|m| m.express_id == 25).expect("valid face keeps wall mesh");
    assert_eq!(mesh.indices, clean_mesh.indices);
    assert_eq!(mesh.positions, clean_mesh.positions);
    assert_eq!(mesh.normals, clean_mesh.normals);
    assert_eq!(dropped_indexed_faces(&partial), 1, "diagnostics report the item/type drop");
}

#[test]
fn native_all_missing_polygonal_faces_report_without_a_product_mesh_7779() {
    let result = run("", "#999");
    assert!(
        result.meshes.iter().all(|m| m.express_id != 25 || m.indices.is_empty()),
        "all-missing face entries cannot produce product triangles"
    );
    assert_eq!(dropped_indexed_faces(&result), 1);
}
