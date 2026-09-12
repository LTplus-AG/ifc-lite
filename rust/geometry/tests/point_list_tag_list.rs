// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An IFC4X3 `IfcCartesianPointList3D` carries an optional `TagList` after
//! its `CoordList`. The raw-byte coordinate reader both tessellated face-set
//! processors use took the span from the first `((` to the LAST `))` of the
//! record, so a written TagList ended the span and its digits (`'P1'`) were
//! read as coordinates: phantom vertices after the real ones. Found by the
//! core review behind #4577 (finding 6, the span half).
//!
//! Each test meshes the same face set twice, once with `TagList = $` (the
//! control, read correctly before and after) and once with tags, and expects
//! the same mesh.

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{
    GeometryProcessor, PolygonalFaceSetProcessor, TessellationQuality, TriangulatedFaceSetProcessor,
};

fn mesh(content: &str, processor: &dyn GeometryProcessor) -> (Vec<f32>, Vec<u32>) {
    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let entity = decoder.decode_by_id(2).expect("face set decodes");
    let mesh = processor
        .process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
        .expect("face set meshes");
    (mesh.positions, mesh.indices)
}

fn point_list(tags: &str) -> String {
    format!("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(100.,0.,0.),(50.,100.,0.)),{tags});\n")
}

/// The whole-shell orientation pass takes the centroid over every parsed
/// vertex, so a phantom vertex at (1,2,3) lifted it off the triangle's plane
/// and the triangle was flipped.
#[test]
fn a_tag_list_does_not_move_the_triangulated_face_set_orientation() {
    let faces = "#2=IFCTRIANGULATEDFACESET(#1,$,$,((1,2,3)),$);\n";
    let processor = TriangulatedFaceSetProcessor::new();
    let control = mesh(&(point_list("$") + faces), &processor);
    assert_eq!(
        control.0,
        [0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 50.0, 100.0, 0.0]
    );
    let tagged = mesh(&(point_list("('P1','P2','P3')") + faces), &processor);
    assert_eq!(tagged, control, "the TagList changed the triangulated mesh");
}

/// A face that names a fourth point of a three-point list is out of range
/// and dropped; the phantom vertex made index 4 resolve.
#[test]
fn a_tag_list_does_not_resolve_an_out_of_range_polygonal_face_index() {
    let faces = "#2=IFCPOLYGONALFACESET(#1,$,(#3,#4),$);\n\
                 #3=IFCINDEXEDPOLYGONALFACE((1,2,3));\n\
                 #4=IFCINDEXEDPOLYGONALFACE((1,2,4));\n";
    let processor = PolygonalFaceSetProcessor::new();
    let control = mesh(&(point_list("$") + faces), &processor);
    assert_eq!(
        control.1.len(),
        3,
        "the control keeps only the in-range face"
    );
    let tagged = mesh(&(point_list("('P1','P2','P3')") + faces), &processor);
    assert_eq!(tagged, control, "the TagList changed the polygonal mesh");
}
