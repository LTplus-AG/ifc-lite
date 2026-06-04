// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #913 / #407 — the backend must colour an element from its associated
//! *material* appearance when there is no `IfcStyledItem` on the geometry.
//! Most BIM tools assign glass/frame appearance this way:
//!
//! ```text
//! #10 proxy ─IfcRelAssociatesMaterial→ #40 IfcMaterial
//!   #40 ─IfcMaterialDefinitionRepresentation #41→ #42 IfcStyledRepresentation
//!     └─ #30 orphan IfcStyledItem → #31 IfcSurfaceStyle → blue IfcColourRgb
//! ```
//!
//! Pre-fix the proxy rendered as the default gray; now it must be blue.

use ifc_lite_processing::{
    process_geometry, process_geometry_streaming_with_options, StreamingOptions,
};

const MATERIAL_BLUE: [f32; 4] = [0.2, 0.3, 0.8, 1.0];
const PROXY_DEFAULT: [f32; 4] = [0.6, 0.6, 0.6, 1.0];

/// No IfcStyledItem on the geometry — colour comes only from the material chain.
const MATERIAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-407 material chain fixture'),'2;1');
FILE_NAME('mat.ifc','2026-06-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyMaterialChain0',$,'Proxy',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#30=IFCSTYLEDITEM($,(#31),$);
#31=IFCSURFACESTYLE('Glass',.BOTH.,(#32));
#32=IFCSURFACESTYLERENDERING(#33,$,$,$,$,$,$,$,.FLAT.);
#33=IFCCOLOURRGB($,0.2,0.3,0.8);
#40=IFCMATERIAL('Glass',$,$);
#41=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#42),#40);
#42=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#30));
#50=IFCRELASSOCIATESMATERIAL('2RelAssocMaterial000',$,$,$,(#10),#40);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn proxy_inherits_material_appearance() {
    let result = process_geometry(MATERIAL_IFC);

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 10)
        .expect("proxy #10 produced no mesh");

    assert!(
        approx_eq(proxy.color, MATERIAL_BLUE),
        "expected material colour {MATERIAL_BLUE:?}, got {:?} (default would be {PROXY_DEFAULT:?})",
        proxy.color
    );
}

#[test]
fn proxy_inherits_material_appearance_in_fast_first_batch_streaming() {
    // Regression for #913 §2c: the `fast_first_batch` streaming mode defers
    // geometry styled items, but orphan styled items (material appearances) are
    // resolved up front for the material chain — so they must NOT be deferred.
    // Pre-fix the deferred path collected no orphan styled items and this proxy
    // rendered the default gray; now it must be the material blue.
    let result = process_geometry_streaming_with_options(
        MATERIAL_IFC,
        // `defer_style_updates` = fast_first_batch && Default opening filter &&
        // !include_presentation_layers — all three required to hit the deferred
        // branch this test guards.
        StreamingOptions {
            fast_first_batch: true,
            include_presentation_layers: false,
            initial_batch_size: 1,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
    );

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 10)
        .expect("proxy #10 produced no mesh in fast_first_batch streaming mode");

    assert!(
        approx_eq(proxy.color, MATERIAL_BLUE),
        "fast_first_batch streaming: expected material colour {MATERIAL_BLUE:?}, got {:?} \
         (default would be {PROXY_DEFAULT:?})",
        proxy.color
    );
}
