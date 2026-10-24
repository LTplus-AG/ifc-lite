// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7782 C4-7a, native half of the bare `RepresentationMaps` oracle. The
//! browser half is the `#7782` test in
//! `scripts/lib/wasm-prepass-owned-columns-contract.mjs`; both run this same
//! fixture and pin the same facts: the list and bare forms of orphan type
//! #300 draw the same mesh, that mesh is the shape occurrence #200 draws from
//! the same representation (both sit at the identity placement), and a typed
//! wrapper draws nothing.

use ifc_lite_processing::process_geometry;

/// The wasm contract's `fixture({ typeGeometry: true })`, verbatim.
const LISTED: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Owned sharded prepass contract'),'2;1');
FILE_NAME('owned.ifc','2026-10-03T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCAXIS2PLACEMENT2D(#10,$);
#12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,2.,0.2);
#13=IFCEXTRUDEDAREASOLID(#12,#4,#2,3.);
#14=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#200=IFCWALL('0000000000000000000200',$,'First wall',$,$,#5,#15,$,.NOTDEFINED.);
#100=IFCWALL('0000000000000000000100',$,'Second wall',$,$,#5,#15,$,.NOTDEFINED.);
#16=IFCREPRESENTATIONMAP(#4,#14);
#300=IFCWALLTYPE('0000000000000000000300',$,'Orphan type',$,$,$,(#16),$,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
"#;

const LIST_MAPS: &str = ",(#16),$,$,.NOTDEFINED.)";

fn with_maps(maps: &str) -> String {
    assert!(LISTED.contains(LIST_MAPS));
    LISTED.replace(LIST_MAPS, &format!(",{maps},$,$,.NOTDEFINED.)"))
}

/// The shape-only fields of every mesh `id` draws, in output order.
fn shapes(content: &str, id: u32) -> Vec<(Vec<f32>, Vec<f32>, Vec<u32>)> {
    process_geometry(content)
        .meshes
        .iter()
        .filter(|mesh| mesh.express_id == id)
        .map(|mesh| (mesh.positions.clone(), mesh.normals.clone(), mesh.indices.clone()))
        .collect()
}

#[test]
fn issue_7782_native_bare_representation_maps_draw_the_list_mesh() {
    let listed = shapes(LISTED, 300);
    assert_eq!(listed.len(), 1, "list control must draw orphan type #300 once");
    assert!(!listed[0].2.is_empty(), "list control mesh must have triangles");
    assert_eq!(listed, shapes(LISTED, 200), "the type map draws occurrence #200's shape");

    let bare = with_maps("#16");
    assert_ne!(bare, LISTED, "the mutation must remove the list wrapper");
    assert_eq!(shapes(&bare, 300), listed, "bare RepresentationMaps must draw the list mesh");
}

#[test]
fn issue_7782_native_typed_wrapper_representation_maps_draw_nothing() {
    for maps in ["IFCPROPERTYSETDEFINITIONSET((#16))", "IFCPROPERTYSETDEFINITIONSET(#16)"] {
        let content = with_maps(maps);
        assert!(shapes(&content, 300).is_empty(), "{maps} is not an IfcRepresentationMap list");
        assert_eq!(shapes(&content, 200).len(), 1, "{maps}: occurrences still draw");
    }
}
