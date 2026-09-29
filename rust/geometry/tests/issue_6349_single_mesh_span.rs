// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6349: the single-mesh router API must not silently round a product whose
//! items lie ~5,000 km apart. A near-origin direct box and the same box mapped
//! to X = 5,000,000.123456 m cannot share one f64 origin plus one f32 buffer to
//! 1e-5 m, so `process_element` / `process_element_with_voids` either return
//! both boxes at that precision or report the span explicitly. Full-precision
//! frame parts (`process_element_parts`) are covered in `router::frame_parts`.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FAR_X: f64 = 5_000_000.123456;

fn fixture(body: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);\
         #4=IFCDIRECTION((0.,0.,1.));#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\
         #10=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#11=IFCEXTRUDEDAREASOLID(#10,#2,#4,1.);\
         #12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#11));#13=IFCREPRESENTATIONMAP(#2,#12);\
         #14=IFCCARTESIANPOINT(({FAR_X},0.,0.));#15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);\
         #16=IFCMAPPEDITEM(#13,#15);#17=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({body}));\
         #18=IFCPRODUCTDEFINITIONSHAPE($,$,(#17));\
         #20=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Mixed',$,$,#3,#18,$,$);\
         #30=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.4);#31=IFCCARTESIANPOINT((0.,0.,-1.));\
         #32=IFCAXIS2PLACEMENT3D(#31,$,$);#33=IFCEXTRUDEDAREASOLID(#30,#32,#4,3.);\
         #34=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#33));#35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));\
         #40=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#35,$,.OPENING.);\
         #41=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#20,#40);"
    )
}

/// World X values of a mesh's vertices, reconstructed in f64.
fn world_x(mesh: &Mesh) -> Vec<f64> {
    mesh.positions.chunks_exact(3).map(|p| p[0] as f64 + mesh.origin[0]).collect()
}

/// A single mesh is acceptable only if BOTH boxes kept their X faces to 1e-5 m;
/// otherwise the router must have said why it could not return one.
fn assert_precise_or_reported(result: Result<Mesh, ifc_lite_geometry::Error>, context: &str) {
    match result {
        Ok(mesh) => {
            let xs = world_x(&mesh);
            for face in [-0.5, 0.5, FAR_X - 0.5, FAR_X + 0.5] {
                let closest = xs.iter().map(|x| (x - face).abs()).fold(f64::INFINITY, f64::min);
                assert!(
                    closest < 1e-5,
                    "{context}: X face {face:.6} came back {closest:.6} m off, silently rounded"
                );
            }
        }
        Err(error) => {
            let message = error.to_string();
            assert!(message.contains("#6349") && message.contains("#20"), "{context}: {message}");
        }
    }
}

#[test]
fn issue_6349_single_mesh_api_never_silently_rounds_a_near_far_product() {
    for body in ["#11,#16", "#16,#11"] {
        for local_frame in [false, true] {
            let source = fixture(body);
            let mut decoder = EntityDecoder::new(&source);
            let element = decoder.decode_by_id(20).unwrap();
            let router = GeometryRouter::with_scale_and_local_frame(1.0, local_frame);
            let context = format!("items ({body}), local frame {local_frame}");
            assert_precise_or_reported(
                router.process_element(&element, &mut decoder),
                &format!("process_element, {context}"),
            );
            let voids = FxHashMap::from_iter([(20, vec![40])]);
            assert_precise_or_reported(
                router.process_element_with_voids(&element, &mut decoder, &voids),
                &format!("process_element_with_voids, {context}"),
            );
        }
    }
}

#[test]
fn issue_6349_single_frame_products_still_return_one_mesh() {
    // Two boxes in one frame, near or both mapped far: the ordinary contract.
    for body in ["#11,#33", "#16"] {
        let source = fixture(body);
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(20).unwrap();
        let mesh = GeometryRouter::new().process_element(&element, &mut decoder).unwrap();
        assert!(!mesh.indices.is_empty(), "items ({body})");
    }
}
