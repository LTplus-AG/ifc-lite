// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: layer slicing under the per-element LOCAL FRAME (#1114).
//!
//! In wasm the mesh is stored relative to its per-element AABB-centre origin
//! (`world = origin + position`), default ON. The layer-cut planes are built
//! from the element placement in absolute world coords, so they MUST be
//! relativized by the same origin — otherwise, for any wall not sitting at the
//! coordinate origin along its thickness axis, the planes land a whole building
//! placement away from the relativized mesh and slice nothing (the #563
//! `cut-produced-<2` fallback). This file runs in its OWN test binary so it can
//! force the local frame on (the flag is read once and cached per process).

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::material_layer_index::MaterialLayerIndex;
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;

/// Three-layer wall (4 m × 0.3 m × 3 m, layers along AXIS2) placed at Y = 100 m,
/// so its per-element local origin has a large component along the slicing axis.
fn three_layer_wall_at_y100_ifc() -> &'static str {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,100.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Finish',$,$);
#201=IFCMATERIAL('Core',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'FinishOuter',$,$,$);
#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#200,0.05,$,'FinishInner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',#2,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
}

#[test]
fn slices_correctly_under_per_element_local_frame() {
    // Force the local frame on BEFORE any geometry call reads & caches the flag.
    // Safe: this file is its own test binary, so nothing else reads it first.
    std::env::set_var("IFC_LITE_LOCAL_FRAME", "1");

    let content = three_layer_wall_at_y100_ifc();
    let mut decoder = EntityDecoder::new(content);
    let mut router = GeometryRouter::with_units(content, &mut decoder);
    let index = MaterialLayerIndex::from_content(content, &mut decoder);
    let buildup = index.get(100).expect("wall #100 sliceable").clone();
    router.set_material_layer_index(std::sync::Arc::new(index));

    let wall = decoder.decode_by_id(100).expect("decode wall #100");
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let collection = router
        .process_element_with_material_layers(&wall, &mut decoder, &buildup, &void_index)
        .expect("layered path ok")
        .expect("Some(SubMeshCollection)");

    // Three layers → three sub-meshes. Before the plane-relativization fix the
    // planes sat ~100 m off the local-framed mesh and everything collapsed into
    // one slab (cut-produced-<2).
    assert_eq!(
        collection.sub_meshes.len(),
        3,
        "a wall placed 100 m from the origin must still slice into 3 layers with the local frame on"
    );

    // Every slab must carry the element's local-frame origin (~y=100) forward —
    // `clip_mesh` builds a fresh mesh with origin [0,0,0], so without restoring
    // it each sliced wall would render at the world origin (misplaced).
    for sub in &collection.sub_meshes {
        assert!(
            (sub.mesh.origin[1] - 100.0).abs() < 1.0,
            "sliced sub-mesh must keep the local-frame origin (~y=100), got {:?}",
            sub.mesh.origin
        );
    }

    // The slabs are NOT capped at the shared interfaces. Capping closed each slab
    // but doubled every interface into a coincident, oppositely-wound full-section
    // sheet — the "ghost face": non-watertight (degree-4 edges) and ~3x the
    // triangles. Instead the slabs are open bands whose UNION is the wall's
    // watertight outer skin: every edge shared by exactly two triangles, none by
    // four. (The 2D section re-closes each band's open contour at the interface
    // chord; see the `drawing-2d` PolygonBuilder bidirectional loop builder.)
    let (open, doubled) = union_edge_stats(&collection.sub_meshes);
    assert_eq!(
        open, 0,
        "the union of the layer bands must be watertight (no open edges), got {open}"
    );
    assert_eq!(
        doubled, 0,
        "no interface may be a doubled coincident sheet (no degree-4 edges), got {doubled}"
    );
}

/// Weld every sub-mesh of a sliced element by rounded WORLD position (origin +
/// position; flat-shaded, so positions are not index-shared) and return
/// `(open_edges, degree>=4_edges)` for the UNION. `open == 0` ⇒ watertight;
/// `degree>=4 == 0` ⇒ no doubled coincident interface sheet (the ghost face).
fn union_edge_stats(subs: &[ifc_lite_geometry::mesh::SubMesh]) -> (usize, usize) {
    use std::collections::HashMap;
    let q = |v: f32, o: f64| ((v as f64 + o) * 1.0e4).round() as i64;
    let mut edges: HashMap<[(i64, i64, i64); 2], u32> = HashMap::new();
    for sub in subs {
        let m = &sub.mesh;
        let o = m.origin;
        let key = |i: usize| -> (i64, i64, i64) {
            (
                q(m.positions[i * 3], o[0]),
                q(m.positions[i * 3 + 1], o[1]),
                q(m.positions[i * 3 + 2], o[2]),
            )
        };
        for tri in m.indices.chunks_exact(3) {
            let v = [tri[0] as usize, tri[1] as usize, tri[2] as usize];
            for &(a, b) in &[(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
                let (ka, kb) = (key(a), key(b));
                let e = if ka <= kb { [ka, kb] } else { [kb, ka] };
                *edges.entry(e).or_insert(0) += 1;
            }
        }
    }
    let open = edges.values().filter(|&&c| c == 1).count();
    let doubled = edges.values().filter(|&&c| c >= 4).count();
    (open, doubled)
}
